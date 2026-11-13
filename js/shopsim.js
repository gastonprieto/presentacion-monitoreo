/* Simulación de la tienda: Usuarios → Órdenes → Pagos (pool de conexiones → DB) → Envíos.
   Cada pedido es un checkout: Órdenes arma la orden, le pide el cobro a Pagos y después el envío a Envíos.
   Pagos tiene un pool de `pool` conexiones por réplica contra una DB compartida: si no hay conexión libre,
   el pedido espera; si espera más de `poolWait`, falla con «timeout acquiring db connection» (503).
   El incidente recurrente: la DB se pone lenta, el pool se llena, primero sube la latencia y después los errores.
   La tienda emite las tres señales: métricas (`window`), logs (`logs`) y trazas (`traces`).

   La lógica es una simulación de eventos discretos con su propia cola: cada evento corre en su instante
   exacto, sin importar el tamaño del tick ni la velocidad, así que tiempo real y `fastForward` dan los
   mismos números con la misma seed. El viaje entre servicios (`travel`) es un retardo fijo que se anima
   pero no cuenta como latencia: métricas y trazas miden tiempo de servicio (GUIDELINE §6).
   Los scripts de las escenas y los modelos que reaccionan (supervisor, health checks, autoscaler, breaker)
   programan con sim.after / sim.every / sim.wait, que van a la misma cola de eventos: corren en su instante
   exacto y se borran con reset. wait() resuelve en su instante, pero el código después del await corre cuando
   JS vuelve a la cola de microtareas (fin del tick o del fastForward): para algo exacto, after. No usar clock.after/every/wait para tocar la simulación (si alguien lo hace,
   igual se pone al día la simulación hasta el instante del timer antes de correrlo).
   Reacciones automáticas (slides «Reaccionar solo»): cada réplica de Pagos es un proceso con estado propio
   (arriba, colgado, arrancando, calentando, en rotación) y su Supervisor. Health checks cada hcInterval:
   liveness reinicia lo que no responde hcFall veces seguidas; readiness saca de la rotación lo que no está
   listo (con readiness el balanceo de Órdenes sólo elige réplicas en rotación; sin readiness elige cualquiera
   y la que arranca o está caída falla el pedido). Autoscaler sobre `sat` por réplica lista, promedio de los
   últimos AS_WIN segundos. La llamada Órdenes → Pagos pasa siempre por _callPagos: ahí se aplican el
   breaker, el timeout y los reintentos (cada intento es un pedido real a Pagos). Cada reacción emite
   'react' { t, kind: 'restart' | 'scale' | 'remove' | 'breaker', detail } y se dibuja con un 🤖 azul.
   Usa el Clock y la geometría de NetKit y rng/MetricWindow/Supervisor/Autoscaler/CircuitBreaker de ObsKit.
   Expone window.ShopSimKit = { ShopSim, DEFAULTS, COL }. */
(function () {
  'use strict';

  const { Clock, Speed, svgEl, cubic, curve, edge, pop, C, MOBILE, W, H } = window.NetKit;
  const { rng, MetricWindow, Supervisor, Autoscaler, CircuitBreaker } = window.ObsKit;

  const COL = { req: C.req, ok: C.ok, slow: C.slow, err: C.err, db: C.db, svc: '#38bdf8', react: '#60a5fa' };

  const DEFAULTS = {
    seed: 1, rate: 6,
    pool: 3, dbTime: 0.25, dbMax: 12, // la DB contesta más lento con más de dbMax consultas a la vez
    poolWait: 2,                      // espera máxima por una conexión libre (s)
    ordenesTime: 0.05, enviosTime: 0.08,
    replicas: 1,
    fault: null,                      // 'slowdb' (DB rinde 12× menos) · 'hang' (Pagos no contesta) · 'crash' (Pagos se cae)
    slowRatio: 0, slowFactor: 10,     // proporción de consultas lentas y cuánto más tardan (percentiles)
    travel: 0.48, showPool: false, clickToTrace: false,
    // reacciones automáticas
    liveness: false, readiness: false, hcInterval: 1, hcFall: 2,
    warmup: 0,                        // segundos que tarda una réplica en estar lista después de arrancar
    restartPolicy: 'no', restartTime: 2,
    autoscale: null,                  // { target, min, max, cooldown, startup, downWindow? }
    timeout: null,                    // segundos que Órdenes espera a Pagos
    breaker: null,                    // { failures, openFor }
    retries: 0
  };
  const SERVICES = ['checkout', 'ordenes', 'pagos', 'envios', 'db'];
  const SLOWDB = 12;       // con 'slowdb' la DB aguanta 12 veces menos consultas a la vez (con dbMax 12: de a una)
  const HANG_AFTER = 10;   // sin timeout, Órdenes abandona un pedido colgado a los 10 s
  const WARN_WAIT = 0.5;   // esperar más que esto por una conexión deja un warn
  const SLOW = 1;          // checkout más lento que esto: punto amarillo
  const KEEP = 120;        // segundos de muestras que se guardan
  const SAT_EVERY = 0.1;   // cada cuánto se mide la saturación del pool
  const AS_EVERY = 1;      // cada cuánto decide el autoscaler
  const AS_WIN = 5;        // ventana de la métrica del autoscaler (s)
  const DRAIN_MAX = 5;     // un reinicio con readiness espera hasta 5 s a que la réplica termine lo que tiene
  const STEP = 0.05;       // paso fijo de fastForward

  // Por qué falló una llamada a Pagos, visto desde Órdenes
  const WHY = {
    refused: 'no pudo conectar con pagos (connection refused)',
    reset: 'pagos cortó la conexión (connection reset)',
    pool: 'checkout falló: pagos respondió 503',
    warming: 'checkout falló: pagos respondió 503 (arrancando)',
    hang: `pagos no respondió en ${HANG_AFTER} s`,
    open: 'circuito abierto: ni se llama a pagos',
    noreps: 'no hay réplicas de pagos listas'
  };
  const BR_NAME = { closed: 'cerrado', open: 'abierto', half: 'medio abierto' };

  const fmt = (x, d = 2) => x.toFixed(d).replace('.', ',');
  const hex = r => Math.floor(r * 4294967296).toString(16).padStart(8, '0');

  // Cola de prioridad de eventos { at, seq, fn }: el más temprano primero; a igual instante, el más viejo
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    peek() { return this.a[0]; }
    less(i, j) { const x = this.a[i], y = this.a[j]; return x.at < y.at || (x.at === y.at && x.seq < y.seq); }
    swap(i, j) { const t = this.a[i]; this.a[i] = this.a[j]; this.a[j] = t; }
    push(e) {
      const a = this.a;
      a.push(e);
      for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && this.less(l, m)) m = l;
          if (r < a.length && this.less(r, m)) m = r;
          if (m === i) break;
          this.swap(i, m); i = m;
        }
      }
      return top;
    }
  }

  class ShopSim {
    constructor(svg, opts) {
      this.svg = svg;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.classList.add('netsim');
      this.v = MOBILE;
      this.clock = new Clock();
      this.clock.onTick = () => this._frame();
      // Un timer del Clock primero pone al día la simulación hasta su instante (los ticks corren timers antes que onTick)
      const after = this.clock.after.bind(this.clock);
      this.clock.after = (sec, fn) => { const tm = after(sec, () => { this._pump(tm.at); fn(); }); return tm; };
      this.listeners = {};
      this.drawing = true;
      this.o = Object.assign({}, DEFAULTS);
      this.reset(opts);
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => f(...a)); }
    start() { this.clock.start(); }
    stop() { this.clock.stop(); }
    get now() { return this.t; }
    get replicaCount() { return this.reps.length; }

    // Estado de la réplica en la posición i (su id no cambia aunque otras se vayan)
    replicaState(i) {
      const r = this.reps[i];
      if (!r) return null;
      return { id: r.id, up: r.up, ready: this._ready(r), restarts: r.restarts, backoffUntil: r.backoffUntil,
        inRotation: this._routable(r), hang: r.hang, booting: r.booting, received: r.received };
    }

    // Programación determinista sobre la cola de eventos (se borra con reset)
    after(sec, fn) { return this._at(sec, fn); }
    every(sec, fn) {
      const h = { on: true, cancel() { h.on = false; } };
      const loop = () => { if (!h.on) return; fn(); if (h.on) this._at(sec, loop); };
      this._at(sec, loop);
      return h;
    }
    wait(sec) { const gen = this.gen; return new Promise(r => this._at(sec, () => gen === this.gen && r())); }

    reset(opts) {
      if (opts) this.o = Object.assign({}, DEFAULTS, opts);
      this.gen = (this.gen || 0) + 1;
      this.clock.clear();
      this.clock.now = 0;
      this.t = 0;
      this.q = new Heap();
      this.seq = 0;
      this.rand = rng(this.o.seed);
      // las llegadas tienen su propio generador: dos configuraciones con la misma seed reciben el mismo tráfico
      this.arrRand = rng(this.o.seed * 7919 + 17);
      this.fault = null;
      this.nextId = 1001;
      this.nextRep = 1;
      this.rr = 0;
      this.dbActive = 0;
      this.dbRecent = [];  // duraciones de las últimas consultas (para el rótulo de la DB)
      this.samples = Object.fromEntries(SERVICES.map(s => [s, []]));
      this.satLog = [];
      this.asLog = [];     // [t, sat por réplica lista] para el autoscaler
      this.logs = [];
      this.traces = [];
      this.picked = null;
      this.reps = [];
      this._makeBreaker();
      this._makeScaler();
      this._resize();
      this._build();
      this._scheduleArrivals();
      this._scheduleSat();
      this._scheduleProbes();
      this._scheduleScaler();
      if (this.o.fault) this.breakPagos(this.o.fault);
      this._draw();
      this.emit('reset');
    }

    // Cambia una opción en vivo. Réplicas y showPool redibujan; el resto rige desde el próximo evento.
    set(key, value) {
      this.o[key] = value;
      if (key === 'fault') return value ? this.breakPagos(value) : this.heal();
      if (key === 'breaker') this._makeBreaker();
      if (key === 'autoscale') this._makeScaler();
      if (key === 'restartPolicy') this.reps.forEach(r => { r.sup.policy = value; });
      if (key === 'readiness' && value) this.reps.forEach(r => { r.inRot = this._ready(r); });
      if (key === 'replicas') this._resize();
      if (key === 'replicas' || key === 'showPool' || key === 'clickToTrace' || key === 'breaker') { this._build(); this._draw(); }
    }

    // Rompe Pagos (idempotente). 'slowdb' es de la DB; 'hang' cuelga los procesos que están corriendo (un
    // reinicio lo arregla); 'crash' tira los procesos y los vuelve a tirar cada vez que arrancan.
    breakPagos(fault) {
      if (this.fault === fault) return;
      this.fault = fault;
      this.reps.forEach(r => { r.hang = fault === 'hang' && r.up; });
      if (fault === 'crash') this.reps.forEach(r => this._exit(r, true));
      this._draw();
    }
    // Arreglo del operador: se acaba la falla y las réplicas caídas arrancan de nuevo
    heal() {
      if (this.fault === null) return;
      this.fault = null;
      this.reps.forEach(r => {
        r.hang = false;
        if (!r.up && !r.booting) { if (r.restartTimer) r.restartTimer.dead = true; this._boot(r, this.o.restartTime, this.o.warmup); }
      });
      this._draw();
    }

    // Reinicio planificado de la réplica i. Con readiness sale de la rotación y termina lo que tiene antes de
    // parar; sin readiness se corta en el acto (lo que tenía en curso falla).
    restartReplica(i) {
      const r = this.reps[i];
      if (!r || r.draining !== false || (!r.up && !r.booting)) return;
      if (this.o.readiness && r.up) { r.draining = this.t; r.inRot = false; }
      else this._stop(r);
      this._draw();
    }

    fastForward(sec) {
      const sp = Speed.value, was = this.drawing;
      Speed.value = 1;
      this.drawing = false;
      try { for (let i = 0, n = Math.round(sec / STEP); i < n; i++) this.clock._tick(0, STEP * 1000); }
      finally { Speed.value = sp; this.drawing = was; }
      this._draw();
    }

    // Métricas de los últimos sec segundos. service: 'checkout' (de punta a punta), un servicio o 'db'
    // (duración de las consultas). Órdenes incluye lo que espera a Pagos y Envíos.
    window(sec, service = 'checkout') {
      const now = this.t, from = now - sec, mw = new MetricWindow({ span: sec });
      for (const s of this.samples[service]) if (s.t > from) mw.add(s.t, s);
      const st = mw.stats(now);
      let sat = 0;
      if (service === 'pagos') {
        let sum = 0, n = 0;
        for (const [t, f] of this.satLog) if (t > from) { sum += f; n++; }
        sat = n ? sum / n : 0;
      }
      return Object.assign(st, { sat });
    }

    /* ---------- eventos ---------- */

    _at(dt, fn) { return this._atAbs(this.t + dt, fn); }
    _atAbs(at, fn) {
      const e = { at, seq: this.seq++, fn, dead: false };
      this.q.push(e);
      return e;
    }

    // Corre en orden todos los eventos hasta `until` (cada uno ve this.t = su instante)
    _pump(until) {
      while (this.q.size && this.q.peek().at <= until) {
        const e = this.q.pop();
        if (e.dead) continue;
        this.t = e.at;
        e.fn();
      }
      if (until > this.t) this.t = until;
    }

    _jit() { return 0.75 + this.rand() * 0.5; }

    _scheduleArrivals() {
      const next = () => {
        if (this.o.rate > 0) this._arrive();
        this._at(-Math.log(1 - this.arrRand()) / Math.max(this.o.rate, 0.2), next);
      };
      this._at(0.2, next);
    }

    // Grilla fija de 0,1 s: saturación del pool, estado del breaker y réplicas que terminaron de drenar
    _scheduleSat() {
      let k = 0;
      const step = () => {
        const pool = this.o.pool, total = pool * this.reps.length;
        this.satLog.push([this.t, total ? this.reps.reduce((a, r) => a + r.inUse, 0) / total : 0]);
        const ready = this.reps.filter(r => this._ready(r));
        this.asLog.push([this.t, ready.length ? ready.reduce((a, r) => a + r.inUse, 0) / (pool * ready.length) : 1]);
        if (this.satLog.length > KEEP / SAT_EVERY + 50) {
          const from = this.t - KEEP;
          this.satLog = this.satLog.filter(s => s[0] > from);
          for (const k of SERVICES) this.samples[k] = this.samples[k].filter(s => s.t > from);
        }
        if (this.asLog.length > AS_WIN / SAT_EVERY + 10) this.asLog.shift();
        this._brSync();
        for (const r of this.reps) {
          if (r.draining !== false && ((!r.pending && !r.calls.size) || this.t - r.draining >= DRAIN_MAX)) this._stop(r);
        }
        this._atAbs(Math.round(++k * SAT_EVERY * 1e6) / 1e6, step); // grilla exacta k × 0,1 s
      };
      this._atAbs(++k * SAT_EVERY, step);
    }

    /* ---------- réplicas: procesos, health checks y supervisor ---------- */

    _newRep() {
      return { id: this.nextRep++, inUse: 0, waiting: [], hung: [], calls: new Set(), pending: 0, epoch: 0,
        up: true, booting: false, hang: false, warmUntil: 0, inRot: true, draining: false, gone: false,
        liveFails: 0, readyFails: 0, restarts: 0, backoffUntil: 0, received: 0, restartTimer: null, bootTimer: null,
        sup: new Supervisor({ policy: this.o.restartPolicy }) };
    }

    _resize(n = Math.max(1, this.o.replicas), warm = 0) {
      while (this.reps.length < n) {
        const r = this._newRep();
        if (warm > 0) { r.warmUntil = this.t + warm; r.inRot = !this.o.readiness; }
        if (this.fault === 'crash') this._exit(r, true);
        this.reps.push(r);
      }
      // las que se van terminan lo que tenían en curso (sus pedidos guardan la referencia)
      this.reps.splice(n).forEach(r => {
        r.gone = true;
        if (r.restartTimer) r.restartTimer.dead = true;
        if (r.bootTimer) r.bootTimer.dead = true;
      });
    }

    // Lista para recibir pedidos: arriba, sin colgarse, ya calentó y no está drenando
    _ready(r) { return r.up && !r.hang && this.t >= r.warmUntil && r.draining === false; }
    // El balanceo de Órdenes la puede elegir: con readiness sólo las que están en rotación; sin, cualquiera
    _routable(r) { return this.o.readiness ? r.inRot : true; }

    _react(kind, detail, node) {
      const e = { t: this.t, kind, detail };
      this.emit('react', e);
      const label = kind === 'restart' ? 'reinicio'
        : kind === 'remove' ? 'fuera'
        : kind === 'scale' ? (detail.to > detail.from ? `+${detail.to - detail.from} réplica` : `−${detail.from - detail.to} réplica`)
        : BR_NAME[detail.to];
      this._pop(node || this.ordenes, `🤖 ${label}`, COL.react);
    }

    // Health checks cada hcInterval. Liveness: ¿el proceso contesta? (hcFall fallas seguidas → se mata y
    // decide el supervisor). Readiness: ¿está listo? (hcFall fallas → fuera de rotación; un OK → adentro).
    _scheduleProbes() {
      const probe = () => {
        const o = this.o;
        for (const r of this.reps.slice()) {
          if (o.liveness && r.up) {
            r.liveFails = r.hang ? r.liveFails + 1 : 0;
            if (r.liveFails >= o.hcFall) {
              r.liveFails = 0;
              this._react('remove', { replica: r.id, why: 'liveness' }, r.node);
              this._exit(r, true);
              continue;
            }
          }
          if (o.readiness) {
            if (this._ready(r)) { r.readyFails = 0; r.inRot = true; }
            else if (r.inRot && ++r.readyFails >= o.hcFall) {
              r.inRot = false;
              this._react('remove', { replica: r.id, why: 'readiness' }, r.node);
            }
          }
        }
        this._at(Math.max(0.1, o.hcInterval), probe);
      };
      this._at(Math.max(0.1, this.o.hcInterval), probe);
    }

    // Mata el proceso: lo que tenía adentro falla (connection reset), el pool se vacía
    _kill(r) {
      r.up = false;
      r.booting = false;
      r.hang = false;
      r.epoch++;
      r.inRot = false;
      r.draining = false;
      if (r.bootTimer) r.bootTimer.dead = true;
      const calls = [...r.calls];
      r.calls.clear();
      r.waiting.forEach(w => { if (w.timer) w.timer.dead = true; });
      r.hung.forEach(c => { if (c.hangT) c.hangT.dead = true; });
      r.waiting = []; r.hung = []; r.inUse = 0;
      for (const c of calls) {
        c.lost = true;
        this._sample('pagos', this.t - c.pIn, false);
        if (c.tmo) c.tmo.dead = true;
        if (!c.timedOut) this._reply(c, false, 'reset', this.t - c.pIn);
      }
    }

    // El proceso terminó (se cayó o lo mató liveness): el supervisor decide si y cuándo vuelve
    _exit(r, failed) {
      if (!r.up && !r.booting) return;
      this._kill(r);
      const delay = r.sup.onExit(this.t, failed);
      if (delay === null) return;
      r.backoffUntil = this.t + delay;
      r.restartTimer = this._at(delay, () => {
        if (r.gone) return;
        r.restarts++;
        this._react('restart', { replica: r.id, delay, restarts: r.restarts }, r.node);
        this._boot(r, this.o.restartTime, this.o.warmup);
      });
    }

    // Parada planificada (reinicio del operador): no pasa por el supervisor
    _stop(r) {
      this._kill(r);
      r.restarts++;
      this._boot(r, this.o.restartTime, this.o.warmup);
    }

    // Arranca: bootTime caída, después escucha pero calienta warm segundos. Con 'crash' se cae al terminar de arrancar.
    _boot(r, bootTime, warm) {
      r.up = false;
      r.booting = true;
      r.inRot = false;
      const ready = () => {
        if (r.gone) return;
        r.booting = false;
        r.up = true;
        r.liveFails = 0;
        r.readyFails = 0;
        r.warmUntil = this.t + warm;
        if (this.fault === 'crash') return this._exit(r, true);
        r.sup.onHealthy(this.t);
      };
      if (bootTime > 0) r.bootTimer = this._at(bootTime, ready);
      else ready();
    }

    /* ---------- breaker y autoscaler ---------- */

    _makeBreaker() {
      this.br = this.o.breaker ? new CircuitBreaker(this.o.breaker) : null;
      this.brState = this.br ? this.br.state : null;
    }
    _brSync() {
      if (!this.br) return;
      const s = this.br.tick(this.t);
      if (s === this.brState) return;
      const from = this.brState;
      this.brState = s;
      this._react('breaker', { from, to: s }, this.ordenes);
      this._drawBreaker();
    }

    _makeScaler() {
      const a = this.o.autoscale;
      // para bajar, la recomendación más alta de los últimos 15 s (un bache no achica y vuelve a agrandar)
      this.scaler = a ? new Autoscaler(Object.assign({ downWindow: 15 }, a)) : null;
    }

    // Métrica: `sat` (conexiones en uso / pool) promedio por réplica lista en los últimos AS_WIN s.
    // Las réplicas nuevas tardan `startup` s en estar listas.
    _scheduleScaler() {
      const step = () => {
        const a = this.scaler;
        if (a) {
          const from = this.t - AS_WIN;
          let sum = 0, n = 0;
          for (const [t, f] of this.asLog) if (t > from) { sum += f; n++; }
          const cur = this.reps.length, want = a.step(this.t, n ? sum / n : 0, cur);
          if (want !== cur) {
            this._resize(want, a.startup);
            this._build();
            this._react('scale', { from: cur, to: want }, this.reps[want - 1].node);
          }
        }
        this._at(AS_EVERY, step);
      };
      this._at(AS_EVERY, step);
    }

    /* ---------- un pedido ---------- */

    _sample(service, latency, ok) { this.samples[service].push({ t: this.t, latency, ok }); }

    _log(level, service, replica, msg, ord) {
      const l = { t: this.t, level, service, replica, msg, orderId: ord.id, traceId: ord.traceId };
      this.logs.push(l);
      if (this.logs.length > 300) this.logs.shift();
      this.emit('log', l);
    }

    // Un salto entre servicios: tarda `travel` (animado) y después corre fn
    _hop(a, b, color, ord, fn) {
      this._dot(a, b, color, this.o.travel, ord);
      this._at(this.o.travel, fn);
    }

    _arrive() {
      const ord = { id: this.nextId++, traceId: hex(this.rand()), gen: this.gen, spans: [], pT: 0, eT: 0, attempts: 0 };
      this.emit('request', ord);
      this._hop(() => this.client, () => this.ordenes, COL.req, ord, () => this._atOrdenes(ord));
    }

    _atOrdenes(ord) {
      ord.start = this.t;
      ord.oT = this.o.ordenesTime * this._jit();
      this._at(ord.oT, () => {
        this._log('info', 'ordenes', 0, `orden #${ord.id} creada`, ord);
        this._callPagos(ord);
      });
    }

    // La única puerta de Órdenes a Pagos: breaker → elegir réplica → (timeout) → respuesta → reintento
    _callPagos(ord) {
      ord.attempts++;
      const call = { ord, rep: null, done: false };
      if (this.br) {
        const ok = this.br.allow(this.t);
        this._brSync();
        if (!ok) { this._pop(this.ordenes, '⚡', COL.react); return this._reply(call, false, 'open', 0); }
      }
      const pool = this.reps.filter(r => this._routable(r));
      if (!pool.length) return this._reply(call, false, 'noreps', 0);
      const rep = call.rep = pool[this.rr++ % pool.length];
      rep.received++;
      if (!rep.up) return this._refused(call);
      rep.pending++;
      const epoch = rep.epoch;
      this._hop(() => this.ordenes, () => rep.node, COL.req, ord, () => {
        rep.pending--;
        if (!rep.up || rep.epoch !== epoch) return this._refused(call);
        this._atPagos(call);
      });
    }

    // No hay proceso escuchando: falla en el acto (y Pagos lo cuenta como error, aunque no lo vea)
    _refused(call) {
      this._sample('pagos', 0, false);
      this._pop(call.rep.node, '✕ conexión', COL.err);
      this._reply(call, false, 'refused', 0);
    }

    _atPagos(call) {
      const o = this.o, rep = call.rep;
      call.pIn = this.t;
      call.epoch = rep.epoch;
      rep.calls.add(call);
      if (this.t < rep.warmUntil) return this._pagosDone(call, 0, false, 'warming');
      if (o.timeout > 0) {
        call.tmo = this._at(o.timeout, () => { // Órdenes deja de esperar; se entera tras el viaje de vuelta
          call.timedOut = true;
          this._at(o.travel, () => { this._pop(this.ordenes, '⏱', COL.err); this._reply(call, false, 'timeout', o.timeout); });
        });
      }
      if (rep.hang) { // acepta el pedido pero nunca contesta
        rep.hung.push(call);
        call.hangT = this._at(HANG_AFTER, () => {
          rep.hung.splice(rep.hung.indexOf(call), 1);
          this._pagosDone(call, HANG_AFTER, false, 'hang');
        });
        return;
      }
      if (rep.inUse < o.pool) return this._query(call);
      const w = { call };
      rep.waiting.push(w);
      if (o.poolWait > 0 && Number.isFinite(o.poolWait)) {
        w.timer = this._at(o.poolWait, () => {
          rep.waiting.splice(rep.waiting.indexOf(w), 1);
          this._pop(rep.node, '503', COL.err);
          this._pagosDone(call, this.t - call.pIn, false, 'pool');
        });
      }
    }

    _query(call) {
      const rep = call.rep, ord = call.ord, epoch = rep.epoch;
      rep.inUse++;
      this.dbActive++;
      const o = this.o, wait = this.t - call.pIn;
      const slow = this.rand() < o.slowRatio ? o.slowFactor : 1;
      const load = this.dbActive * (this.fault === 'slowdb' ? SLOWDB : 1) / o.dbMax;
      const d = o.dbTime * Math.max(1, load) * this._jit() * slow;
      this._dot(() => rep.node, () => this.dbNode, COL.db, d / 2, ord, 3.5);
      this._at(d / 2, () => this._dot(() => this.dbNode, () => rep.node, COL.db, d / 2, ord, 3.5));
      this._at(d, () => {
        this.dbActive--;
        this.dbRecent.push(d);
        if (this.dbRecent.length > 20) this.dbRecent.shift();
        this._sample('db', d, true);
        if (rep.epoch !== epoch) return; // el proceso murió mientras tanto: la respuesta se pierde
        rep.inUse--;
        const nx = rep.waiting.shift();
        if (nx) { if (nx.timer) nx.timer.dead = true; this._query(nx.call); }
        if (wait > WARN_WAIT) this._log('warn', 'pagos', rep.id, `esperó ${fmt(wait, 1)} s por una conexión a la DB`, ord);
        this._pagosDone(call, wait + d, true);
      });
    }

    // Pagos termina un pedido (lado del servidor): métricas y logs de Pagos, respuesta a Órdenes
    _pagosDone(call, pT, ok, why) {
      const rep = call.rep, ord = call.ord;
      if (call.lost) return;
      rep.calls.delete(call);
      this._sample('pagos', pT, ok);
      if (ok) this._log('info', 'pagos', rep.id, `pago aprobado en ${Math.round(pT * 1000)} ms`, ord);
      else if (why === 'pool') this._log('error', 'pagos', rep.id, `timeout acquiring db connection (esperó ${fmt(pT, 1)} s) → 503`, ord);
      else if (why === 'warming') this._log('error', 'pagos', rep.id, 'todavía arrancando → 503', ord);
      if (call.timedOut) return; // Órdenes ya no espera
      if (call.tmo) call.tmo.dead = true;
      if (why === 'warming') this._pop(rep.node, '503', COL.err);
      this._hop(() => rep.node, () => this.ordenes, ok ? COL.ok : COL.err, ord, () => this._reply(call, ok, why, pT));
    }

    // Órdenes recibe la respuesta (o se cansa de esperar): breaker, reintento o sigue a Envíos
    _reply(call, ok, why, waited) {
      if (call.done) return;
      call.done = true;
      const ord = call.ord, o = this.o;
      if (why !== 'open' && why !== 'noreps') {
        const s = ord.start + ord.oT + ord.pT;
        ord.spans.push({ service: 'pagos', start: s, end: s + waited, ok });
        if (this.br) { this.br.record(this.t, ok); this._brSync(); }
      }
      ord.pT += waited;
      ord.why = why;
      if (ok) return this._hop(() => this.ordenes, () => this.envios, COL.req, ord, () => this._atEnvios(ord));
      if (why !== 'open' && why !== 'noreps' && ord.attempts <= o.retries) {
        this._log('warn', 'ordenes', 0, `reintenta el cobro de #${ord.id} (intento ${ord.attempts + 1})`, ord);
        return this._callPagos(ord);
      }
      const msg = why === 'timeout' ? `pagos no respondió en ${fmt(o.timeout, 1)} s (timeout)` : WHY[why];
      this._finish(ord, false, ord.attempts > 1 ? `${msg} tras ${ord.attempts} intentos` : msg);
    }

    _atEnvios(ord) {
      const s = ord.start + ord.oT + ord.pT;
      ord.eT = this.o.enviosTime * this._jit();
      this._at(ord.eT, () => {
        ord.spans.push({ service: 'envios', start: s, end: s + ord.eT, ok: true });
        this._sample('envios', ord.eT, true);
        this._log('info', 'envios', 0, `envío programado para #${ord.id}`, ord);
        this._hop(() => this.envios, () => this.ordenes, COL.ok, ord, () => this._finish(ord, true));
      });
    }

    // Órdenes contesta al usuario: cierra el checkout, su traza y sus métricas
    _finish(ord, ok, errMsg) {
      const lat = ord.oT + ord.pT + ord.eT;
      ord.spans.unshift({ service: 'ordenes', start: ord.start, end: ord.start + lat, ok });
      this._sample('checkout', lat, ok);
      this._sample('ordenes', lat, ok); // Órdenes tarda lo suyo más lo que espera a Pagos y Envíos
      if (!ok) this._log('error', 'ordenes', 0, errMsg, ord);
      const trace = { traceId: ord.traceId, orderId: ord.id, start: ord.start, dur: lat, ok, spans: ord.spans };
      this.traces.push(trace);
      if (this.traces.length > 50) this.traces.shift();
      this.emit('trace', trace, ord.id === this.picked);
      if (ord.id === this.picked) this.picked = null;
      const w = ord.why;
      if (!ok && w !== 'open') this._pop(this.ordenes, w === 'refused' || w === 'reset' || w === 'noreps' ? '502' : '503', COL.err);
      this._dot(() => this.ordenes, () => this.client, ok ? (lat > SLOW ? COL.slow : COL.ok) : COL.err, this.o.travel, ord);
    }

    /* ---------- dibujo ---------- */

    _pop(n, text, color) { if (this.drawing && n) pop(this.gTop, n.x, n.y - n.hh - 10, text, color); }

    // Punto animado de a a b (a y b son funciones: el nodo puede cambiar si se redibuja). No toca la lógica.
    _dot(fa, fb, color, dur, ord, r = 5.5) {
      if (!this.drawing) return;
      const a = fa(), b = fb();
      if (!a || !b) return;
      const el = svgEl('circle', { r, fill: color, class: 'pk' + (ord.id === this.picked ? ' picked' : '') }, this.gPk);
      if (this.o.clickToTrace && r > 4) {
        el.classList.add('pick');
        el.addEventListener('click', () => { this.picked = ord.id; el.classList.add('picked'); });
      }
      const an = this.clock.animate(dur, p => {
        const P = cubic(edge(a, b, this.v), edge(b, a, this.v), p, this.v);
        el.setAttribute('cx', P.x); el.setAttribute('cy', P.y);
      }, () => el.remove());
      an.t0 = this.t; // sale en el instante lógico del evento, no en el del tick que lo procesó
    }

    _box(kind, x, y, hw, hh, title, emoji) {
      const n = { kind, x, y, hw, hh };
      const g = svgEl('g', { class: kind, transform: `translate(${x},${y})` }, this.gNodes);
      svgEl('rect', { class: 'node-box', x: -hw, y: -hh, width: hw * 2, height: hh * 2, rx: 10 }, g);
      const tx = emoji ? -hw + 36 : 0, anchor = emoji ? 'start' : 'middle';
      if (emoji) svgEl('text', { x: -hw + 19, y: 7, class: 't-emoji', 'text-anchor': 'middle' }, g).textContent = emoji;
      n.title = svgEl('text', { x: tx, y: -3, class: 't-title small', 'text-anchor': anchor }, g);
      n.title.textContent = title;
      n.sub = svgEl('text', { x: tx, y: 14, class: 't-sub', 'text-anchor': anchor }, g);
      n.g = g;
      return n;
    }

    _link(a, b, cls = '') {
      svgEl('path', { class: 'link ' + cls, d: curve(edge(a, b, this.v), edge(b, a, this.v), this.v) }, this.gLinks);
    }

    _build() {
      const o = this.o, v = this.v, m = this.reps.length;
      this.svg.innerHTML = '';
      this.gLinks = svgEl('g', {}, this.svg);
      this.gNodes = svgEl('g', {}, this.svg);
      this.gPk = svgEl('g', {}, this.svg);
      this.gTop = svgEl('g', {}, this.svg);

      if (v) {
        this.client = this._box('client', 110, 34, 72, 24, 'Usuarios', '👥');
        this.ordenes = this._box('srv', 110, 116, 70, 26, 'Órdenes', '🧾');
        this.envios = this._box('srv', 300, 116, 76, 26, 'Envíos', '📦');
        this.dbNode = this._box('srv data', W / 2, 372, 96, 28, 'DB de pagos', '🗄');
      } else {
        this.client = this._box('client', 88, 270, 74, 28, 'Usuarios', '👥');
        this.ordenes = this._box('srv', 278, 270, 78, 32, 'Órdenes', '🧾');
        this.envios = this._box('srv', 520, 500, 100, 32, 'Envíos', '📦');
        this.dbNode = this._box('srv data', 790, 230, 90, 36, 'DB de pagos', '🗄');
      }
      this.client.g.style.setProperty('--c', C.req);
      this.client.sub.textContent = 'POST /checkout';
      this.ordenes.sub.textContent = 'arma la orden';
      this.envios.sub.textContent = 'programa el envío';

      this.reps.forEach((rep, i) => {
        let x, y, hw, hh;
        if (v) { x = W * (i + 1) / (m + 1); y = 236; hw = Math.min(84, W / (m + 1) / 2 - 6); hh = 36; }
        else { const gap = 340 / (m + 1); x = 520; y = 60 + gap * (i + 1); hw = 100; hh = Math.min(36, gap / 2 - 7); }
        const narrow = v && m > 1, compact = !v && hh < 26;
        // el nombre usa el id estable de la réplica (el que aparece en logs y replicaState)
        const name = m > 1 || rep.id > 1 ? (narrow ? `P${rep.id}` : `Pagos ${rep.id}`) : 'Pagos';
        const n = rep.node = this._box('srv pagos', x, y, hw, hh, name, narrow ? null : '💳');
        n.name = name;
        n.tiny = v && m > 3; // celular con muchas réplicas: rótulos de un par de caracteres
        if (compact) { n.title.setAttribute('y', 5); n.sub.style.display = 'none'; }
        n.compact = compact;
        n.qg = svgEl('g', {}, n.g);
        n.slots = [];
        if (o.showPool) {
          // abajo, a lo ancho, con título y estado más arriba · cajas compactas (muchas réplicas): a la derecha, en filas de 6
          const bottom = v || hh >= 30, gap = bottom && v ? 2 : 3;
          const s = bottom ? Math.max(3, Math.min(8, (hw * 2 - 12) / o.pool - gap)) : 7;
          const per = bottom ? o.pool : 6, rows = Math.ceil(o.pool / per);
          const x0 = bottom ? -(per * (s + gap) - gap) / 2 : hw - 8 - per * (s + gap) + gap;
          const y0 = bottom ? hh - 8 - s : -(rows * (s + gap) - gap) / 2;
          if (bottom) { n.title.setAttribute('y', -14); n.sub.setAttribute('y', 2); }
          for (let k = 0; k < o.pool; k++) {
            n.slots.push(svgEl('rect', { class: 'slot', x: x0 + (k % per) * (s + gap), y: y0 + Math.floor(k / per) * (s + gap), width: s, height: s, rx: 1.5 }, n.g));
          }
        }
        this._link(this.ordenes, n);
        this._link(n, this.dbNode, 'db-link');
      });
      this._link(this.client, this.ordenes);
      this._link(this.ordenes, this.envios);
      // estado del circuit breaker de Órdenes → Pagos, debajo de Órdenes
      this.brText = null;
      if (this.br) {
        const g = svgEl('g', { class: 'breaker' }, this.gNodes);
        this.brText = svgEl('text', { x: this.ordenes.x, y: this.ordenes.y + this.ordenes.hh + (v ? 15 : 22),
          class: 't-info', 'text-anchor': 'middle' }, g);
        this._drawBreaker();
      }
    }

    _drawBreaker() {
      if (!this.brText) return;
      const s = this.brState;
      this.brText.textContent = `⚡ circuito ${BR_NAME[s]}`;
      this.brText.setAttribute('fill', s === 'closed' ? COL.ok : s === 'open' ? COL.err : COL.slow);
    }

    _draw() {
      const o = this.o, t = this.t;
      this.reps.forEach(rep => {
        const n = rep.node;
        if (!n) return;
        const tiny = n.tiny || n.compact, warming = rep.up && t < rep.warmUntil;
        const out = rep.up && !rep.hang && !warming && o.readiness && !rep.inRot;
        n.g.classList.toggle('down', !rep.up);
        n.g.classList.toggle('hung', rep.up && rep.hang);
        n.g.classList.toggle('deploying', warming && !rep.hang);
        n.g.classList.toggle('draining', rep.draining !== false);
        n.g.classList.toggle('unhealthy', out && rep.draining === false);
        n.g.classList.toggle('hot', rep.up && !rep.hang && rep.waiting.length > 0);
        const wait = Math.ceil(rep.backoffUntil - t - 1e-9);
        n.sub.textContent = rep.booting ? (tiny ? '…' : 'arrancando…')
          : !rep.up ? (wait > 0 ? (tiny ? `↻${wait}s` : `↻ en ${wait} s`) : (tiny ? '✕' : '✕ caído'))
          : rep.hang ? (tiny ? `⏸${rep.hung.length}` : `no responde · ${rep.hung.length}`)
          : rep.draining !== false ? (tiny ? '⇣' : 'drenando…')
          : warming ? (tiny ? '…' : 'calentando…')
          : out ? (tiny ? '⊘' : 'fuera de rotación')
          : `${this.v && this.reps.length > 1 ? '' : 'pool '}${rep.inUse}/${o.pool}${rep.waiting.length && !tiny ? ` · espera ${rep.waiting.length}` : ''}`;
        // caja compacta (escritorio con muchas réplicas): sin subtítulo, el estado corto va en el título
        const normal = rep.up && !rep.hang && rep.draining === false && !warming && !out;
        n.title.textContent = n.name + (n.compact && !normal ? ` ${n.sub.textContent}` : rep.restarts && !n.tiny ? ` ↻${rep.restarts}` : '');
        n.slots.forEach((s, k) => s.classList.toggle('on', k < rep.inUse));
        const q = n.qg, want = Math.min(rep.waiting.length, tiny ? 5 : 12);
        while (q.childNodes.length > want) q.lastChild.remove();
        while (q.childNodes.length < want) {
          const k = q.childNodes.length;
          svgEl('rect', { class: 'qsq', x: -n.hw + 4 + k * 8, y: n.hh + 4, width: 6, height: 6, rx: 1 }, q);
        }
      });
      this._drawBreaker();
      const avg = this.dbRecent.length ? this.dbRecent.reduce((a, b) => a + b, 0) / this.dbRecent.length : 0;
      this.dbNode.sub.textContent = `${this.dbActive} consultas · ${fmt(avg)} s`;
      this.dbNode.g.classList.toggle('hot', avg > o.dbTime * 3);
    }

    _frame() {
      // al µs: con ticks distintos el reloj acumula distinto error de coma flotante (29,9999999… vs 30)
      this._pump(Math.round(this.clock.now * 1e6) / 1e6);
      if (this.drawing) this._draw();
      this.emit('tick', this.t);
    }
  }

  window.ShopSimKit = { ShopSim, DEFAULTS, COL };
})();
