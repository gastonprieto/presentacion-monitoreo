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
   Usa el Clock y la geometría de NetKit y rng/MetricWindow de ObsKit. Expone window.ShopSimKit = { ShopSim, DEFAULTS, COL }. */
(function () {
  'use strict';

  const { Clock, Speed, svgEl, cubic, curve, edge, pop, C, MOBILE, W, H } = window.NetKit;
  const { rng, MetricWindow } = window.ObsKit;

  const COL = { req: C.req, ok: C.ok, slow: C.slow, err: C.err, db: C.db, svc: '#38bdf8' };

  const DEFAULTS = {
    seed: 1, rate: 6,
    pool: 6, dbTime: 0.25, dbMax: 12, // la DB contesta más lento con más de dbMax consultas a la vez
    poolWait: 2,                      // espera máxima por una conexión libre (s)
    ordenesTime: 0.05, enviosTime: 0.08,
    replicas: 1,
    fault: null,                      // 'slowdb' (DB × 6) · 'hang' (Pagos no contesta) · 'crash' (Pagos caído)
    slowRatio: 0, slowFactor: 10,     // proporción de consultas lentas y cuánto más tardan (percentiles)
    travel: 0.48, showPool: false, clickToTrace: false
  };
  const SERVICES = ['checkout', 'ordenes', 'pagos', 'envios'];
  const SLOWDB = 6;        // multiplicador de la DB con fault 'slowdb'
  const HANG_AFTER = 10;   // un pedido colgado cuenta como error a los 10 s
  const WARN_WAIT = 0.5;   // esperar más que esto por una conexión deja un warn
  const SLOW = 1;          // checkout más lento que esto: punto amarillo
  const KEEP = 120;        // segundos de muestras que se guardan
  const SAT_EVERY = 0.1;   // cada cuánto se mide la saturación del pool
  const STEP = 0.05;       // paso fijo de fastForward

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

    reset(opts) {
      if (opts) this.o = Object.assign({}, DEFAULTS, opts);
      this.gen = (this.gen || 0) + 1;
      this.clock.clear();
      this.clock.now = 0;
      this.t = 0;
      this.q = new Heap();
      this.seq = 0;
      this.rand = rng(this.o.seed);
      this.fault = this.o.fault;
      this.nextId = 1001;
      this.rr = 0;
      this.dbActive = 0;
      this.dbRecent = [];  // duraciones de las últimas consultas (para el rótulo de la DB)
      this.samples = Object.fromEntries(SERVICES.map(s => [s, []]));
      this.satLog = [];
      this.logs = [];
      this.traces = [];
      this.picked = null;
      this.reps = [];
      this._resize();
      this._build();
      this._scheduleArrivals();
      this._scheduleSat();
      this._draw();
      this.emit('reset');
    }

    // Cambia una opción en vivo. Réplicas y showPool redibujan; el resto rige desde el próximo evento.
    set(key, value) {
      this.o[key] = value;
      if (key === 'fault') return value ? this.breakPagos(value) : this.heal();
      if (key === 'replicas') this._resize();
      if (key === 'replicas' || key === 'showPool' || key === 'clickToTrace') { this._build(); this._draw(); }
    }

    // Rompe Pagos (idempotente: repetir la misma falla no cambia nada)
    breakPagos(fault) {
      if (this.fault === fault) return;
      this.fault = fault;
      this._draw();
    }
    heal() {
      if (this.fault === null) return;
      this.fault = null;
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

    // Métricas de los últimos sec segundos. service: 'checkout' (de punta a punta) o un servicio.
    window(sec, service = 'checkout') {
      const from = this.t - sec, mw = new MetricWindow({ span: sec });
      for (const s of this.samples[service]) if (s.t > from) mw.add(s.t, s);
      const st = mw.stats(this.t);
      let sat = 0;
      if (service === 'pagos') {
        let sum = 0, n = 0;
        for (const [t, f] of this.satLog) if (t > from) { sum += f; n++; }
        sat = n ? sum / n : 0;
      }
      return Object.assign(st, { sat });
    }

    /* ---------- eventos ---------- */

    _at(dt, fn) {
      const e = { at: this.t + dt, seq: this.seq++, fn, dead: false };
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
        this._at(-Math.log(1 - this.rand()) / Math.max(this.o.rate, 0.2), next);
      };
      this._at(0.2, next);
    }

    // Saturación del pool: conexiones en uso / total, medida en una grilla fija de tiempo
    _scheduleSat() {
      const step = () => {
        const total = this.o.pool * this.reps.length;
        this.satLog.push([this.t, total ? this.reps.reduce((a, r) => a + r.inUse, 0) / total : 0]);
        if (this.satLog.length > KEEP / SAT_EVERY + 50) {
          const from = this.t - KEEP;
          this.satLog = this.satLog.filter(s => s[0] > from);
          for (const k of SERVICES) this.samples[k] = this.samples[k].filter(s => s.t > from);
        }
        this._at(SAT_EVERY, step);
      };
      this._at(SAT_EVERY, step);
    }

    _resize() {
      const n = Math.max(1, this.o.replicas);
      while (this.reps.length < n) this.reps.push({ i: this.reps.length, inUse: 0, waiting: [], hung: 0 });
      this.reps.length = n; // las que se van terminan lo que tenían en curso (sus pedidos guardan la referencia)
    }

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
      const ord = { id: this.nextId++, traceId: hex(this.rand()), gen: this.gen, spans: [], pT: 0, eT: 0 };
      this.emit('request', ord);
      this._hop(() => this.client, () => this.ordenes, COL.req, ord, () => this._atOrdenes(ord));
    }

    _atOrdenes(ord) {
      ord.start = this.t;
      ord.oT = this.o.ordenesTime * this._jit();
      this._at(ord.oT, () => {
        this._sample('ordenes', ord.oT, true);
        this._log('info', 'ordenes', 0, `orden #${ord.id} creada`, ord);
        const rep = this.reps[this.rr++ % this.reps.length];
        if (this.fault === 'crash') { // no hay a quién conectarse: falla en el acto
          this._pop(rep.node, '✕ conexión', COL.err);
          return this._pagosDone(ord, rep, 0, false, 'crash');
        }
        this._hop(() => this.ordenes, () => rep.node, COL.req, ord, () => this._atPagos(ord, rep));
      });
    }

    _atPagos(ord, rep) {
      ord.pIn = this.t;
      if (this.fault === 'hang') { // acepta el pedido pero nunca contesta
        rep.hung++;
        this._at(HANG_AFTER, () => { rep.hung--; this._pagosDone(ord, rep, HANG_AFTER, false, 'hang'); });
        return;
      }
      if (rep.inUse < this.o.pool) return this._query(ord, rep);
      const w = { ord };
      rep.waiting.push(w);
      if (this.o.poolWait > 0 && Number.isFinite(this.o.poolWait)) {
        w.timer = this._at(this.o.poolWait, () => {
          rep.waiting.splice(rep.waiting.indexOf(w), 1);
          this._pop(rep.node, '503', COL.err);
          this._pagosDone(ord, rep, this.t - ord.pIn, false, 'timeout');
        });
      }
    }

    _query(ord, rep) {
      rep.inUse++;
      this.dbActive++;
      const o = this.o, wait = this.t - ord.pIn;
      const slow = this.rand() < o.slowRatio ? o.slowFactor : 1;
      const d = o.dbTime * (this.fault === 'slowdb' ? SLOWDB : 1) * Math.max(1, this.dbActive / o.dbMax) * this._jit() * slow;
      this._dot(() => rep.node, () => this.dbNode, COL.db, d / 2, ord, 3.5);
      this._at(d / 2, () => this._dot(() => this.dbNode, () => rep.node, COL.db, d / 2, ord, 3.5));
      this._at(d, () => {
        rep.inUse--;
        this.dbActive--;
        this.dbRecent.push(d);
        if (this.dbRecent.length > 20) this.dbRecent.shift();
        const nx = rep.waiting.shift();
        if (nx) { if (nx.timer) nx.timer.dead = true; this._query(nx.ord, rep); }
        if (wait > WARN_WAIT) this._log('warn', 'pagos', rep.i, `esperó ${fmt(wait, 1)} s por una conexión a la DB`, ord);
        this._pagosDone(ord, rep, wait + d, true);
      });
    }

    _pagosDone(ord, rep, pT, ok, why) {
      ord.pT = pT;
      ord.why = why;
      ord.spans.push({ service: 'pagos', start: ord.start + ord.oT, end: ord.start + ord.oT + pT, ok });
      if (why !== 'crash') this._sample('pagos', pT, ok); // caído no mide nada: el error lo ve Órdenes
      if (ok) this._log('info', 'pagos', rep.i, `pago aprobado en ${Math.round(pT * 1000)} ms`, ord);
      else if (why === 'timeout') this._log('error', 'pagos', rep.i, `timeout acquiring db connection (esperó ${fmt(pT, 1)} s) → 503`, ord);
      if (why === 'crash') return this._finish(ord, false, 'no pudo conectar con pagos (connection refused)');
      if (why === 'hang') return this._finish(ord, false, `pagos no respondió en ${HANG_AFTER} s`);
      this._hop(() => rep.node, () => this.ordenes, ok ? COL.ok : COL.err, ord, () => {
        if (!ok) return this._finish(ord, false, 'checkout falló: pagos respondió 503');
        this._hop(() => this.ordenes, () => this.envios, COL.req, ord, () => this._atEnvios(ord));
      });
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
      if (!ok) this._log('error', 'ordenes', 0, errMsg, ord);
      const trace = { traceId: ord.traceId, orderId: ord.id, start: ord.start, dur: lat, ok, spans: ord.spans };
      this.traces.push(trace);
      if (this.traces.length > 50) this.traces.shift();
      this.emit('trace', trace, ord.id === this.picked);
      if (ord.id === this.picked) this.picked = null;
      if (!ok) this._pop(this.ordenes, ord.why === 'crash' ? '502' : '503', COL.err);
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
        const name = m > 1 ? (narrow ? `P${i + 1}` : `Pagos ${i + 1}`) : 'Pagos';
        const n = rep.node = this._box('srv pagos', x, y, hw, hh, name, narrow ? null : '💳');
        if (compact) { n.title.setAttribute('y', 5); n.sub.style.display = 'none'; }
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
    }

    _draw() {
      const o = this.o, f = this.fault;
      this.reps.forEach(rep => {
        const n = rep.node;
        if (!n) return;
        n.g.classList.toggle('down', f === 'crash');
        n.g.classList.toggle('hung', f === 'hang');
        n.g.classList.toggle('hot', !f && rep.waiting.length > 0);
        n.sub.textContent = f === 'crash' ? '✕ caído'
          : f === 'hang' ? `no responde · ${rep.hung}`
          : `${this.v && this.reps.length > 1 ? '' : 'pool '}${rep.inUse}/${o.pool}${rep.waiting.length ? ` · espera ${rep.waiting.length}` : ''}`;
        n.slots.forEach((s, k) => s.classList.toggle('on', k < rep.inUse));
        const q = n.qg, want = Math.min(rep.waiting.length, 12);
        while (q.childNodes.length > want) q.lastChild.remove();
        while (q.childNodes.length < want) {
          const k = q.childNodes.length;
          svgEl('rect', { class: 'qsq', x: -n.hw + 4 + k * 8, y: n.hh + 4, width: 6, height: 6, rx: 1 }, q);
        }
      });
      const avg = this.dbRecent.length ? this.dbRecent.reduce((a, b) => a + b, 0) / this.dbRecent.length : 0;
      this.dbNode.sub.textContent = `${this.dbActive} consultas · ${fmt(avg)} s`;
      this.dbNode.g.classList.toggle('hot', avg > o.dbTime * 3);
    }

    _frame() {
      this._pump(this.clock.now);
      if (this.drawing) this._draw();
      this.emit('tick', this.t);
    }
  }

  window.ShopSimKit = { ShopSim, DEFAULTS, COL };
})();
