/* Una función por slide interactiva. Cada una recibe el <section> y devuelve { start, stop }.
   main.js las crea la primera vez que se visita la slide y las pausa al salir.
   Para una slide nueva: <section data-scene="nombre"> en index.html + S.nombre = slide => { … } acá. */
(function () {
  'use strict';

  const { Clock, svgEl, pop, C } = window.NetKit;
  const S = {};

  /* ---------- helpers ---------- */

  function on(slide, sel, fn) {
    slide.querySelectorAll(sel).forEach(b => b.addEventListener('click', e => { fn(b, e); b.blur(); }));
  }

  // Control segmentado: <div class="seg" data-group="x"><button data-v="a">…
  function seg(slide, group, fn) {
    const root = slide.querySelector(`.seg[data-group="${group}"]`);
    root.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      root.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      b.blur();
      fn(b.dataset.v);
    }));
  }

  // Muestra solo los elementos [data-mode] que coinciden
  function showMode(slide, mode) {
    slide.querySelectorAll('[data-mode]').forEach(el => { el.hidden = el.dataset.mode !== mode; });
  }

  // Muestra sólo los .mode-text[data-mode] que coinciden (sin tocar otros [data-mode] de la slide)
  function showModeIn(slide, mode) {
    slide.querySelectorAll('.mode-text[data-mode]').forEach(el => { el.hidden = el.dataset.mode !== mode; });
  }

  // { start, stop } para main.js; `sim` queda a mano para las pruebas (section._scene.sim)
  const life = sim => ({ start: () => sim.start(), stop: () => sim.stop(), sim });

  /* ---------- 0. portada: simulación decorativa de fondo ---------- */

  /* ---------- portada: un panel de monitoreo que cuenta el incidente en loop ---------- */

  // Ciclo de TITLE_CYCLE s: sano → sube la latencia → aparecen errores → suena la alerta → 🤖 reinicio → vuelve.
  // El tráfico (la demanda) no cambia: es la misma historia que el resto del deck.
  const TITLE_CYCLE = 40, TITLE_STEP = 0.15, TITLE_POINTS = 120;
  const TITLE_ALERT = [21, 31], TITLE_RESTART = 28;

  function titleSignals(t, r) {
    const c = t % TITLE_CYCLE, n = () => (r() - 0.5);
    const ramp = (a, b) => Math.max(0, Math.min(1, (c - a) / (b - a)));
    const bad = c < TITLE_RESTART ? ramp(13, 22) : 1 - ramp(TITLE_RESTART, 33);
    const errs = c < TITLE_RESTART ? ramp(19, 25) : 1 - ramp(TITLE_RESTART, 31);
    return {
      lat: 0.18 + 0.05 * n() + 0.72 * bad + 0.06 * bad * n(),
      err: 0.04 + 0.03 * Math.abs(n()) + 0.6 * errs,
      rps: 0.5 + 0.08 * Math.sin(t / 3) + 0.07 * n(),
      alert: c >= TITLE_ALERT[0] && c < TITLE_ALERT[1]
    };
  }

  S.title = slide => {
    const svg = slide.querySelector('svg.bg');
    svg.setAttribute('viewBox', '0 0 900 590');
    svg.innerHTML = '';
    const clock = new Clock(), r = window.ObsKit.rng(7);
    const PANELS = [
      { k: 'lat', label: 'Latencia p95', col: C.slow },
      { k: 'err', label: 'Errores', col: '#f87171' },
      { k: 'rps', label: 'Tráfico', col: '#38bdf8' }
    ];
    const X0 = 40, X1 = 790, PH = 150, GAP = 30, Y0 = 70;
    PANELS.forEach((p, i) => {
      const y = Y0 + i * (PH + GAP);
      p.y = y;
      svgEl('rect', { x: X0 - 16, y: y - 34, width: X1 - X0 + 32, height: PH + 46, rx: 12, fill: '#111a33', stroke: '#24304f' }, svg);
      svgEl('text', { x: X0, y: y - 12, fill: '#a78bfa', 'font-size': 18, 'font-family': 'ui-monospace, monospace' }, svg).textContent = p.label;
      for (let g = 1; g < 4; g++) svgEl('line', { x1: X0, x2: X1, y1: y + g * PH / 4, y2: y + g * PH / 4, stroke: '#24304f', 'stroke-dasharray': '4 6' }, svg);
      p.line = svgEl('polyline', { fill: 'none', stroke: p.col, 'stroke-width': 3, 'stroke-linejoin': 'round' }, svg);
      p.data = [];
    });
    const badge = svgEl('g', { opacity: 0 }, svg);
    svgEl('rect', { x: 476, y: 14, width: 330, height: 40, rx: 20, fill: '#f87171' }, badge);
    svgEl('text', { x: 641, y: 41, 'text-anchor': 'middle', fill: '#0a0f1f', 'font-size': 19, 'font-weight': 700 }, badge).textContent = '🔔 ALERTA · errores de checkout';
    const bot = svgEl('text', { x: 500, y: Y0 + PH / 2, fill: '#60a5fa', 'font-size': 22, 'font-weight': 700, opacity: 0 }, svg);
    bot.textContent = '🤖 reinicio automático';

    let t = 0;
    const st = { alert: false, restarts: 0 };
    const draw = () => PANELS.forEach(p => {
      const dx = (X1 - X0) / (TITLE_POINTS - 1);
      p.line.setAttribute('points', p.data.map((v, i) => `${(X0 + i * dx).toFixed(1)},${(p.y + PH - Math.max(0, Math.min(1, v)) * PH).toFixed(1)}`).join(' '));
    });
    const step = () => {
      t += TITLE_STEP;
      const s = titleSignals(t, r);
      PANELS.forEach(p => { p.data.push(s[p.k]); if (p.data.length > TITLE_POINTS) p.data.shift(); });
      if (s.alert !== st.alert) { st.alert = s.alert; badge.setAttribute('opacity', s.alert ? 1 : 0); }
      const c = t % TITLE_CYCLE;
      if (c >= TITLE_RESTART && c - TITLE_STEP < TITLE_RESTART) {
        st.restarts++;
        bot.setAttribute('opacity', 1);
        clock.after(3, () => bot.setAttribute('opacity', 0));
      }
      if (st.alert) badge.setAttribute('opacity', 0.65 + 0.35 * Math.abs(Math.sin(t * 4)));
    };
    for (let i = 0; i < TITLE_POINTS; i++) step(); // arranca con el panel lleno
    draw();
    clock.every(TITLE_STEP, () => { step(); draw(); });
    return {
      start: () => clock.start(), stop: () => clock.stop(),
      ff: sec => { ffClock(clock, sec); }, state: () => ({ t, alert: st.alert, restarts: st.restarts })
    };
  };

  /* ---------- helpers de la tienda (ShopSim) ---------- */

  const { ShopSim } = window.ShopSimKit;

  // Crea la ShopSim sobre <svg class="sim"> y conecta los widgets del dashboard que haya en la slide:
  // .sstats (data-service, data-fields, data-window y data-labels opcional: rótulos separados por coma),
  // canvas.svc-chart (data-service, data-fields), .logs y .trace. La API de cada logStream/traceView queda en el._w
  // (p. ej. slide.querySelector('.trace')._w.select(id)); el Chart del gráfico, con Chart.getChart(canvas).
  // Se llama una sola vez por slide (main.js crea la escena al activarla por primera vez), así que cada
  // widget se crea una vez por ShopSim: los widgets no se pueden desconectar. Para cambiar de modo, sim.reset(opts).
  function setupShop(slide, opts) {
    const sim = new ShopSim(slide.querySelector('svg.sim'), opts);
    slide.querySelectorAll('.sstats').forEach(el => {
      Widgets.svcStats(el, sim);
      if (el.dataset.labels) {
        const labels = el.dataset.labels.split(',');
        el.querySelectorAll('.sstat span').forEach((sp, i) => { if (labels[i]) sp.textContent = labels[i]; });
      }
    });
    slide.querySelectorAll('canvas.svc-chart').forEach(cv => Widgets.svcChart(cv, sim));
    slide.querySelectorAll('.logs').forEach(el => { el._w = Widgets.logStream(el, sim); });
    slide.querySelectorAll('.trace').forEach(el => { el._w = Widgets.traceView(el, sim); });
    return sim;
  }

  // Botones de falla: [data-act=break] rompe Pagos con su data-fault (slowdb por defecto), [data-act=heal] lo arregla
  function breakButtons(slide, sim) {
    on(slide, '[data-act=break]', b => sim.breakPagos(b.dataset.fault || 'slowdb'));
    on(slide, '[data-act=heal]', () => sim.heal());
  }

  // Slider de tráfico input.rate + .rate-out
  function rateSlider(slide, sim) {
    const range = slide.querySelector('input.rate'), out = range.parentElement.querySelector('.rate-out');
    const sync = () => { sim.set('rate', +range.value); out.textContent = `${range.value} pedidos/s`; };
    range.addEventListener('input', sync);
    sync();
    return range;
  }

  // Vuelve los sliders de la slide a su valor inicial (el del HTML) y avisa con 'input'
  function resetSliders(slide) {
    slide.querySelectorAll('input[type=range]').forEach(r => { r.value = r.defaultValue; r.dispatchEvent(new Event('input')); });
  }

  /* ---------- helpers de escenas manuales ---------- */

  // Prepara <svg class="sim"> para una escena manual con su propio Clock
  function manual(slide, cls) {
    const svg = slide.querySelector('svg.sim');
    svg.setAttribute('viewBox', `0 0 ${NetKit.W} ${NetKit.H}`);
    svg.classList.add('netsim', cls);
    return { svg, clock: new Clock(), M: NetKit.MOBILE };
  }

  // Avanza un Clock sin animar (para las pruebas): mismo paso que fastForward de las simulaciones
  function ffClock(clock, sec) {
    const sp = NetKit.Speed.value;
    NetKit.Speed.value = 1;
    try { for (let i = 0, n = Math.round(sec / 0.05); i < n; i++) clock._tick(0, 50); }
    finally { NetKit.Speed.value = sp; }
  }

  // Contadores HTML simples: [['clave', 'etiqueta'], …] → update(obj)
  function hstats(slide, fields) {
    const el = slide.querySelector('.hstats');
    el.className = 'hstats stats';
    el.style.gridTemplateColumns = `repeat(${fields.length}, 1fr)`;
    el.innerHTML = fields.map(([k, l]) => `<div class="stat s-${k}"><b data-f="${k}">0</b><span>${l}</span></div>`).join('');
    return v => fields.forEach(([k]) => { el.querySelector(`[data-f="${k}"]`).textContent = v[k]; });
  }

  /* ---------- 1. sin señales: te enterás por el usuario ---------- */

  const COMPLAINT_AFTER = 8; // segundos de simulación entre el primer checkout fallido y la queja

  S.sinsenales = slide => {
    const sim = setupShop(slide, { rate: 6 });
    rateSlider(slide, sim);
    breakButtons(slide, sim);
    const bubble = slide.querySelector('.complaint'), found = slide.querySelector('.found-out');
    const quiet = found.innerHTML;
    let firstErr = null, complaintAt = null;
    // La queja: el primer checkout fallido arranca la cuenta (en la cola de eventos, no depende de la velocidad)
    sim.on('trace', tr => {
      if (tr.ok || firstErr !== null) return;
      firstErr = sim.now;
      sim.after(COMPLAINT_AFTER, () => {
        complaintAt = sim.now;
        bubble.hidden = false;
        found.innerHTML = `Te enteraste <b>por un usuario</b>, ${Math.round(complaintAt - firstErr)} s después del primer error. En la vida real: minutos u horas.`;
        found.classList.add('late');
      });
    });
    sim.on('reset', () => {
      firstErr = complaintAt = null;
      bubble.hidden = true;
      found.innerHTML = quiet;
      found.classList.remove('late');
    });
    on(slide, '[data-act=reset]', () => { sim.reset(); resetSliders(slide); });
    return Object.assign(life(sim), { state: () => ({ firstErr, complaintAt }) });
  };

  /* ---------- 3. métricas: contar y medir ---------- */

  S.metricas = slide => {
    const sim = setupShop(slide, { rate: 6 });
    rateSlider(slide, sim);
    breakButtons(slide, sim);
    on(slide, '[data-act=reset]', () => { sim.reset(); resetSliders(slide); });
    // Un ejemplo vivo de cada tipo: contador (checkouts atendidos), gauge (conexiones en uso) e histograma (latencia)
    const el = k => slide.querySelector(`[data-v=${k}]`);
    const bars = [...slide.querySelectorAll('.histo-mini .hb')];
    const BUCKETS = [0.5, 2, Infinity], HWIN = 10;
    let total = 0, recent = [];
    sim.on('trace', tr => { total++; recent.push([sim.now, tr.dur]); });
    const draw = () => {
      el('count').textContent = total.toLocaleString('es-AR');
      const used = sim.reps.reduce((a, r) => a + r.inUse, 0), cap = sim.o.pool * sim.reps.length;
      el('gauge').textContent = `${used} de ${cap}`;
      recent = recent.filter(([t]) => t > sim.now - HWIN);
      const n = BUCKETS.map((b, i) => recent.filter(([, d]) => d <= b && (i === 0 || d > BUCKETS[i - 1])).length);
      const max = Math.max(1, ...n);
      bars.forEach((hb, i) => { hb.querySelector('i').style.height = `${Math.round(n[i] / max * 100)}%`; hb.querySelector('b').textContent = n[i]; });
    };
    let last = -Infinity;
    sim.on('tick', now => { if (now - last >= 0.25) { last = now; draw(); } });
    sim.on('reset', () => { total = 0; recent = []; last = -Infinity; draw(); });
    draw();
    return Object.assign(life(sim), { state: () => ({ total, recent: recent.length }) });
  };

  /* ---------- 4. percentiles: el promedio esconde la falla ---------- */

  // Pool más grande y algo menos de tráfico que la tienda de siempre: las consultas lentas (10×) no llenan el
  // pool, así que lo único que cambia es la cola de la distribución (sin esperas ni errores que la tapen)
  const PCT_OPTS = { rate: 5, pool: 6, slowRatio: 0, slowFactor: 10 };

  S.percentiles = slide => {
    const sim = setupShop(slide, PCT_OPTS);
    const range = slide.querySelector('input.slow'), out = slide.querySelector('.slow-out');
    const sync = () => { sim.set('slowRatio', +range.value / 100); out.textContent = `${range.value}%`; };
    range.addEventListener('input', sync);
    sync();
    on(slide, '[data-act=reset]', () => { sim.reset(PCT_OPTS); resetSliders(slide); });
    return life(sim);
  };

  /* ---------- 5. señales doradas: latencia, tráfico, errores, saturación ---------- */

  const GOLD_OPTS = { rate: 6, showPool: true };
  const TRAFFIC_WIN = 10; // segundos de la ventana de la demanda

  S.doradas = slide => {
    const sim = setupShop(slide, GOLD_OPTS);
    rateSlider(slide, sim);
    breakButtons(slide, sim);
    const pool = slide.querySelector('input.pool'), pout = slide.querySelector('.pool-out');
    const syncPool = () => {
      pout.textContent = `${pool.value} conexiones`;
      if (sim.o.pool === +pool.value) return;
      sim.set('pool', +pool.value);
      sim.set('showPool', true); // redibuja los casilleros del pool
    };
    pool.addEventListener('input', syncPool);
    syncPool();
    on(slide, '[data-act=reset]', () => { sim.reset(GOLD_OPTS); resetSliders(slide); });
    // Tráfico = demanda (pedidos que llegan), no las respuestas de Pagos: al romper, los timeouts acumulados
    // salen todos juntos y las respuestas/s saltan aunque nadie pida más. Ventana más larga que el resto
    // porque las llegadas son Poisson (en 3 s varían ±40%). Pisa la celda rps de svcStats en cada tick.
    const cell = slide.querySelector('.sstats [data-f=rps]');
    let arrivals = [];
    const traffic = () => {
      const from = sim.now - TRAFFIC_WIN;
      while (arrivals.length && arrivals[0] <= from) arrivals.shift();
      cell.textContent = (arrivals.length / TRAFFIC_WIN).toFixed(1).replace('.', ',');
    };
    sim.on('request', () => arrivals.push(sim.now));
    sim.on('tick', traffic);
    sim.on('reset', () => { arrivals = []; traffic(); });
    traffic();
    return Object.assign(life(sim), { trafficWindow: TRAFFIC_WIN });
  };

  /* ---------- 6. logs: qué pasó en este pedido ---------- */

  S.logs = slide => {
    const sim = setupShop(slide, { rate: 6 });
    breakButtons(slide, sim);
    const input = slide.querySelector('.logs input.log-search'), ph = input.placeholder;
    // Llena el buscador con el pedido del último error de Pagos (o de cualquiera), para no tipear en vivo
    on(slide, '[data-act=last-error]', () => {
      const errs = sim.logs.filter(l => l.level === 'error');
      const e = errs.filter(l => l.service === 'pagos').pop() || errs.pop();
      input.value = e ? String(e.orderId) : '';
      input.placeholder = e ? ph : 'Todavía no hay errores: rompé la DB';
      input.dispatchEvent(new Event('input'));
    });
    sim.on('reset', () => { input.placeholder = ph; });
    return life(sim);
  };

  /* ---------- 7. logs estructurados y centralizados ---------- */

  // Las cajas «por réplica» son un renderer liviano de la escena (sin barra propia): leen sim.logs filtrados por
  // servicio Pagos y réplica, con el mismo formato de línea que logStream (Widgets.logLine). El modo «central» es un
  // logStream común (.logs.nobar: su barra se oculta y el buscador de la escena le copia la búsqueda).
  const CENTRAL_OPTS = { rate: 6, replicas: 3 };
  const REP_LINES = 20;

  S.centralizar = slide => {
    const sim = setupShop(slide, CENTRAL_OPTS);
    breakButtons(slide, sim);
    const central = slide.querySelector('.logs.nobar');
    const centralSearch = central.querySelector('input.log-search');
    const input = slide.querySelector('input.order-search');
    const boxes = [...slide.querySelectorAll('.rep-box')];
    let where = 'replica', fmt = 'text', dirty = true, last = -Infinity;

    const q = () => input.value.replace('#', '').trim();
    const renderReps = () => {
      dirty = false;
      const query = q();
      boxes.forEach((box, i) => {
        const st = sim.replicaState(i), lines = box.querySelector('.log-lines');
        box.querySelector('.rep-name').textContent = st ? `Pagos ${st.id} · su propio archivo` : '';
        const rows = [];
        for (let k = sim.logs.length - 1; k >= 0 && rows.length < REP_LINES; k--) {
          const l = sim.logs[k];
          if (l.service !== 'pagos' || !st || l.replica !== st.id) continue;
          if (query && String(l.orderId) !== query) continue;
          rows.push(l);
        }
        const atEnd = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 4;
        lines.innerHTML = rows.reverse().map(l => Widgets.logLine(l, fmt)).join('') ||
          `<div class="log-empty">${query ? 'Acá no está.' : 'Sin líneas todavía.'}</div>`;
        if (atEnd) lines.scrollTop = lines.scrollHeight;
      });
    };
    const search = () => {
      centralSearch.value = input.value;
      centralSearch.dispatchEvent(new Event('input'));
      renderReps();
    };
    input.addEventListener('input', search);
    seg(slide, 'where', v => { where = v; showMode(slide, v); renderReps(); });
    seg(slide, 'fmt', v => { fmt = v; central.dataset.format = v; central._w.render(); renderReps(); });
    // Un pedido reciente que pasó por Pagos (el último error si hay), para no tipear en vivo
    on(slide, '[data-act=pick-order]', () => {
      const pl = sim.logs.filter(l => l.service === 'pagos');
      const e = pl.filter(l => l.level === 'error').pop() || pl[pl.length - 1];
      input.value = e ? String(e.orderId) : '';
      search();
    });
    sim.on('log', () => { dirty = true; });
    sim.on('tick', now => { if (dirty && where === 'replica' && now - last >= 0.2) { last = now; renderReps(); } });
    sim.on('reset', () => { last = -Infinity; renderReps(); });
    renderReps();
    return Object.assign(life(sim), { state: () => ({ where, fmt, query: q() }) });
  };

  /* ---------- 8. trazas: seguir un pedido entre servicios ---------- */

  const SLOW_TRACE = 1; // s: «lenta» para el botón de la última traza lenta (como los puntos amarillos)

  S.trazas = slide => {
    const sim = setupShop(slide, { rate: 6, clickToTrace: true });
    breakButtons(slide, sim);
    const tv = slide.querySelector('.trace')._w;
    const note = slide.querySelector('.pick-note'), first = note.textContent;
    let pending = null;
    const show = (tr, msg) => { tv.select(tr); note.textContent = msg; };
    // Clic en un punto: si el pedido ya terminó, su traza; si no, se espera a que termine
    sim.on('pick', id => {
      const tr = sim.traces.find(t => t.orderId === id);
      if (tr) { pending = null; show(tr, `Pedido #${id}: tocá otro para comparar.`); return; }
      pending = id;
      note.textContent = `Siguiendo el pedido #${id}… la traza aparece cuando termina.`;
    });
    sim.on('trace', tr => {
      if (tr.orderId === pending) { pending = null; show(tr, `Pedido #${tr.orderId}: tocá otro para comparar.`); }
      else if (!tv.pinned && pending === null) tv.select(tr); // fija el primero: la cascada no cambia sola
    });
    on(slide, '[data-act=slowest]', () => {
      const tr = sim.traces.filter(t => !t.ok || t.dur > SLOW_TRACE).pop();
      pending = null;
      if (tr) show(tr, `Última traza lenta: pedido #${tr.orderId}.`);
      else note.textContent = 'Ninguna traza lenta todavía: rompé la DB.';
    });
    sim.on('reset', () => { pending = null; note.textContent = first; });
    return Object.assign(life(sim), { state: () => ({ orderId: tv.pinned ? tv.pinned.orderId : null, pending }) });
  };

  /* ---------- 9. las tres juntas: de la métrica a la traza, de la traza al log ---------- */

  // Recorrido por clics: gráfico (clic → momento) → pedidos que empezaron ±TJ_AROUND s de ese momento (los que fallaron
  // primero y después los más lentos: con la DB lenta, los OK que esperaron conexión tardan más que los timeouts) → su cascada → clic en un span → los logs de ese traceId. Los rings de la ShopSim guardan pocos segundos
  // (50 trazas, 300 logs) y el gráfico muestra 30 s, así que la escena guarda su propio historial de trazas y logs por
  // traceId (los últimos TJ_KEEP s), como haría el backend de observabilidad.
  const TJ_OPTS = { rate: 6 };
  const TJ_BREAK_AT = 5;  // s: Pagos se rompe solo para que haya un pico en el gráfico
  const TJ_AROUND = 1, TJ_MAX = 6, TJ_KEEP = 90;
  const STEPS = ['metric', 'traces', 'trace', 'logs'];

  S.tresjuntas = slide => {
    const sim = setupShop(slide, TJ_OPTS);
    sim.drawing = false; // el diagrama de la tienda no se ve en esta slide (svg oculto): no anima puntos
    const cv = slide.querySelector('canvas.svc-chart'), ch = Chart.getChart(cv);
    const box = slide.querySelector('.tj-chart'), mark = box.querySelector('.moment');
    const list = slide.querySelector('.tj-list'), logsEl = slide.querySelector('.tj-logs');
    const traceEl = slide.querySelector('.c-trace .trace'), traceEmpty = slide.querySelector('.tj-trace-empty');
    const tv = traceEl._w; // oculto hasta elegir un pedido; después, fijado con select
    const comma = (x, d = 1) => x.toFixed(d).replace('.', ',');
    let done = [], logsBy = new Map();
    let step = 'metric', moment = null, chosen = null, service = null;

    // historial propio
    sim.on('log', l => { (logsBy.get(l.traceId) || logsBy.set(l.traceId, []).get(l.traceId)).push(l); });
    sim.on('trace', tr => {
      done.push(tr);
      while (done.length && done[0].start < sim.now - TJ_KEEP) logsBy.delete(done.shift().traceId);
      if (step === 'traces' && Math.abs(tr.start - moment) <= TJ_AROUND) renderList(); // terminó uno de ese momento
    });
    const arm = () => sim.after(TJ_BREAK_AT, () => sim.breakPagos('slowdb'));

    const renderList = () => {
      const rows = done.filter(t => Math.abs(t.start - moment) <= TJ_AROUND).sort((a, b) => a.ok - b.ok || b.dur - a.dur).slice(0, TJ_MAX);
      list.innerHTML = rows.length
        ? rows.map(t => `<button type="button" class="tj-row ${t.ok ? (t.dur > SLOW_TRACE ? 'slow' : 'ok') : 'err'}${chosen === t ? ' sel' : ''}" data-trace="${t.traceId}">` +
            `<b>#${t.orderId}</b><span class="d">${comma(t.dur)} s</span><span class="st">${t.ok ? 'ok' : 'error'}</span></button>`).join('')
        : '<div class="tj-empty">Ningún pedido de ese momento terminó todavía. Probá un poco antes.</div>';
    };
    const renderLogs = () => {
      const rows = (logsBy.get(chosen.traceId) || []).slice().sort((a, b) => a.t - b.t);
      logsEl.innerHTML = `<div class="tj-filter">traceId = <b>${chosen.traceId}</b></div><div class="log-lines">` +
        rows.map(l => Widgets.logLine(l, 'text').replace('class="log-line', `class="log-line${l.service === service ? ' hit' : ''}`)).join('') + '</div>';
    };
    const placeMark = () => {
      const i = moment === null ? -1 : ch.times.reduce((b, t, k) => (t !== null && Math.abs(t - moment) < Math.abs((ch.times[b] ?? Infinity) - moment) ? k : b), -1);
      const off = i < 0 || Math.abs(ch.times[i] - moment) > 0.6;
      mark.hidden = off;
      if (!off) mark.style.left = `${cv.offsetLeft + ch.scales.x.getPixelForValue(i)}px`;
    };
    // Pinta la vista según el paso: lo que está después del paso actual queda vacío
    const paint = () => {
      const k = STEPS.indexOf(step);
      slide.querySelector('.c-m').classList.toggle('on', k >= 1);
      slide.querySelector('.c-t').classList.toggle('on', k >= 2);
      slide.querySelector('.c-l').classList.toggle('on', k >= 3);
      slide.querySelectorAll('.crumb').forEach(c => c.classList.toggle('cur', c.dataset.step === (k === 1 ? 'metric' : step)));
      if (k < 1) list.innerHTML = '<div class="tj-empty">Elegí un momento en el gráfico.</div>';
      else renderList();
      traceEl.hidden = k < 2;
      traceEmpty.hidden = k >= 2;
      if (k >= 2) tv.select(chosen);
      if (k < 3) logsEl.innerHTML = `<div class="tj-empty">${k < 2 ? 'Primero elegí un pedido.' : 'Clic en el span de Pagos.'}</div>`;
      else renderLogs();
      placeMark();
    };

    const pickMoment = t => { moment = t; chosen = null; service = null; step = 'traces'; paint(); };
    const pickTrace = tr => { chosen = tr; service = null; step = 'trace'; paint(); };
    const pickSpan = svc => { service = svc; step = 'logs'; paint(); };

    ch.options.onClick = e => {
      const i = Math.round(ch.scales.x.getValueForPixel(e.x));
      const t = ch.times[Math.max(0, Math.min(ch.times.length - 1, i))];
      if (t !== null && t !== undefined) pickMoment(t);
    };
    ch.update('none');
    list.addEventListener('click', e => {
      const b = e.target.closest('.tj-row');
      const tr = b && done.find(t => t.traceId === b.dataset.trace);
      if (tr) pickTrace(tr);
    });
    traceEl.addEventListener('click', e => {
      const r = e.target.closest('.t-row');
      if (r && chosen) pickSpan(r.dataset.service);
    });
    on(slide, '.crumb', b => {
      const want = b.dataset.step;
      if (want === 'metric') { moment = chosen = service = null; step = 'metric'; }
      else if (want === 'trace' && chosen) { service = null; step = 'trace'; }
      else if (want === 'logs' && chosen && service) step = 'logs';
      paint();
    });
    on(slide, '[data-act=heal]', () => sim.heal());
    on(slide, '[data-act=reset]', () => sim.reset(TJ_OPTS));
    sim.on('reset', () => {
      done = []; logsBy = new Map();
      moment = chosen = service = null; step = 'metric';
      arm();
      paint();
    });
    let lastMark = -Infinity;
    sim.on('tick', now => { if (moment !== null && now - lastMark >= 0.5) { lastMark = now; placeMark(); } });
    arm();
    paint();
    return Object.assign(life(sim), {
      pickMoment,
      state: () => ({ step, moment, traceId: chosen ? chosen.traceId : null, service })
    });
  };

  /* ---------- helpers de las slides de alertas (10–12) ---------- */

  const { AlertRule, classifyAlerts, ErrorBudget, rng } = window.ObsKit;
  const comma = (x, d = 1) => x.toFixed(d).replace('.', ',');
  const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];
  const pts = (arr, X, Y) => arr.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  // Pasa un evento de puntero a coordenadas del viewBox del svg
  const svgPoint = (svg, e) => {
    const p = svg.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };
  const txt = (parent, attrs, s) => { const t = svgEl('text', attrs, parent); t.textContent = s; return t; };

  /* ---------- 10. ¿cuándo avisar? umbral y ventana ---------- */

  // Una hora de % de errores del checkout, un punto por minuto de juego: ruido de fondo sembrado, picos cortos de 1, 2 y
  // 3 min y un incidente real sostenido (UMB_INC, 11 min). Calibrado con la semilla: con el umbral y la ventana iniciales
  // de la slide (4%, 3 min) avisa sólo del incidente; con 1% el ruido suena; con 10% el incidente se escapa.
  const UMB_SEED = 26, UMB_MIN = 60, UMB_INC = [36, 46];
  const UMB_SPIKES = { 8: [5.5], 17: [4.8, 6.2], 26: [5.2, 7, 4.6], 52: [8.2] };
  const UMB_INC_V = [4.6, 5.4, 6.1, 6.6, 6.2, 7.1, 6.8, 6.3, 6.7, 5.8, 5.1];
  const UMB_STEP = 0.5, UMB_PAUSE = 2; // s de simulación por minuto de juego; pausa al final de cada pasada
  const UMB_YMAX = 10;

  function umbralSeries() {
    const r = rng(UMB_SEED), spike = {}, out = [];
    for (const k in UMB_SPIKES) UMB_SPIKES[k].forEach((x, i) => { spike[+k + i] = x; });
    let v = 1;
    for (let t = 0; t < UMB_MIN; t++) {
      v = 0.55 * v + 0.45 * (0.45 + 1.1 * r());
      let y = v;
      if (spike[t] !== undefined) y = spike[t] + (r() - 0.5) * 0.3;
      if (t >= UMB_INC[0] && t <= UMB_INC[1]) y = UMB_INC_V[t - UMB_INC[0]] + (r() - 0.5) * 0.3;
      out.push([t, Math.round(y * 100) / 100]);
    }
    return out;
  }

  S.umbral = slide => {
    const { svg, clock, M } = manual(slide, 'alertc');
    const P = M ? { x0: 36, x1: 388, y0: 70, y1: 400 } : { x0: 60, x1: 874, y0: 84, y1: 520 };
    const series = umbralSeries();
    const X = t => P.x0 + (P.x1 - P.x0) * t / (UMB_MIN - 1);
    const Y = v => P.y1 - (P.y1 - P.y0) * Math.max(0, Math.min(v, UMB_YMAX)) / UMB_YMAX;
    const thrIn = slide.querySelector('input.thr'), thrOut = slide.querySelector('.thr-out');
    const ruleOut = slide.querySelector('.rule-out');
    const upd = hstats(slide, [['caught', 'Atrapados'], ['missed', 'Se escaparon'], ['falsePos', 'Falsas alarmas'], ['delay', 'Demora']]);
    let thr = +thrIn.value, win = 3, res = null, live = 'ok', t0 = clock.now;

    // fondo: grilla, incidente real y la serie
    const gGrid = svgEl('g', {}, svg), gInc = svgEl('g', {}, svg), gMarks = svgEl('g', {}, svg);
    const gLine = svgEl('g', {}, svg), gThr = svgEl('g', {}, svg), gCur = svgEl('g', {}, svg);
    for (let v = 0; v <= UMB_YMAX; v += 2) {
      svgEl('line', { class: 'grid', x1: P.x0, x2: P.x1, y1: Y(v), y2: Y(v) }, gGrid);
      txt(gGrid, { class: 'ax', x: P.x0 - 8, y: Y(v) + 4, 'text-anchor': 'end' }, `${v}%`);
    }
    for (let t = 0; t < UMB_MIN; t += M ? 15 : 10) txt(gGrid, { class: 'ax', x: X(t), y: P.y1 + 20, 'text-anchor': 'middle' }, `min ${t}`);
    txt(gGrid, { class: 'ax-title', x: M ? 8 : P.x0, y: M ? 26 : 30 }, M ? '% de error por minuto' : '% de checkouts con error, por minuto');
    svgEl('rect', { class: 'inc-band', x: X(UMB_INC[0]) - 3, y: P.y0, width: X(UMB_INC[1]) - X(UMB_INC[0]) + 6, height: P.y1 - P.y0 }, gInc);
    txt(gInc, { class: 'inc-label', x: (X(UMB_INC[0]) + X(UMB_INC[1])) / 2, y: P.y0 + 16, 'text-anchor': 'middle' }, M ? 'incidente' : 'incidente real');
    svgEl('polyline', { class: 'series', points: pts(series, X, Y) }, gLine);
    const dots = series.map(([t, v]) => svgEl('circle', { class: 'dot', cx: X(t), cy: Y(v), r: M ? 2.6 : 3.5 }, gLine));
    // umbral: línea + manija que se arrastra
    const thrLine = svgEl('line', { class: 'thr-line', x1: P.x0, x2: P.x1 }, gThr);
    const thrHit = svgEl('line', { class: 'thr-hit', x1: P.x0, x2: P.x1 }, gThr);
    const thrTag = svgEl('g', { class: 'thr-tag' }, gThr);
    svgEl('rect', { x: -2, y: -12, width: M ? 50 : 58, height: 24, rx: 7 }, thrTag);
    const thrTxt = txt(thrTag, { x: M ? 23 : 27, y: 5, 'text-anchor': 'middle' }, '');
    // cursor en vivo
    const cur = svgEl('line', { class: 'cursor', y1: P.y0 - 4, y2: P.y1 }, gCur);
    const pill = svgEl('g', { class: 'pill', transform: `translate(${P.x1},${M ? 22 : 26})` }, gCur);
    const pillBg = svgEl('rect', { x: M ? -170 : -230, y: -15, width: M ? 170 : 230, height: 28, rx: 14 }, pill);
    const pillTxt = txt(pill, { x: M ? -85 : -115, y: 5, 'text-anchor': 'middle' }, '');

    const fmtWin = w => (w ? `${w} min` : 'apenas pase');
    const evaluate = () => {
      const { firings } = new AlertRule({ threshold: thr, forSec: win }).evaluate(series);
      const cls = classifyAlerts(firings, [UMB_INC]);
      const hit = firings.find(f => overlaps(f, UMB_INC));
      res = Object.assign(cls, { firings, delay: hit ? Math.max(0, hit[0] - UMB_INC[0]) : null });
    };
    const drawRule = () => {
      const y = Y(thr);
      [thrLine, thrHit].forEach(l => { l.setAttribute('y1', y); l.setAttribute('y2', y); });
      thrTag.setAttribute('transform', `translate(${P.x1 - (M ? 48 : 56)},${y - 16})`);
      thrTxt.textContent = `${comma(thr, thr % 1 ? 1 : 0)}%`;
      dots.forEach((d, i) => d.classList.toggle('bad', series[i][1] > thr));
      gMarks.innerHTML = '';
      const band = (f, cls, label) => {
        const x = X(f[0]), w = Math.max(M ? 6 : 8, X(f[1]) - X(f[0]));
        svgEl('rect', { class: cls, x, y: P.y0 - 26, width: w, height: 12, rx: 3 }, gMarks);
        if (label && !M) txt(gMarks, { class: `mk-label ${cls}-t`, x: x + w / 2, y: P.y0 - 32, 'text-anchor': 'middle' }, label);
      };
      res.firings.forEach(f => {
        if (overlaps(f, UMB_INC)) band(f, 'hit-mark', `🔔 +${res.delay} min`);
        else band(f, 'fp-mark', 'falsa');
      });
      if (res.missed) {
        svgEl('rect', { class: 'miss-mark', x: X(UMB_INC[0]) - 6, y: P.y0 - 3, width: X(UMB_INC[1]) - X(UMB_INC[0]) + 12, height: P.y1 - P.y0 + 6, rx: 6 }, gMarks);
        txt(gMarks, { class: 'mk-label miss-mark-t', x: (X(UMB_INC[0]) + X(UMB_INC[1])) / 2, y: P.y0 - 14, 'text-anchor': 'middle' }, 'se escapó');
      }
      thrOut.textContent = `${comma(thr, thr % 1 ? 1 : 0)}%`;
      ruleOut.innerHTML = `🔔 Avisar si errores &gt; <b>${comma(thr, thr % 1 ? 1 : 0)}%</b> ${win ? `durante <b>${win} min</b> seguidos` : '<b>apenas pase</b>'}`;
      upd({ caught: res.caught, missed: res.missed, falsePos: res.falsePos, delay: res.delay === null ? '—' : `${res.delay} min` });
    };
    const refresh = () => { evaluate(); drawRule(); drawLive(); };

    // Cursor: recorre la serie en tiempo de simulación y muestra el estado de la regla en ese minuto
    let pend = 0;
    const drawLive = () => {
      const cycle = UMB_MIN * UMB_STEP + UMB_PAUSE;
      const minute = Math.min(UMB_MIN - 1, Math.floor(((clock.now - t0) % cycle) / UMB_STEP));
      const rule = new AlertRule({ threshold: thr, forSec: win });
      for (let i = 0; i <= minute; i++) live = rule.step(series[i][0], series[i][1]);
      pend = rule.badSince === null ? 0 : minute - rule.badSince;
      cur.setAttribute('x1', X(minute)); cur.setAttribute('x2', X(minute));
      gCur.setAttribute('class', `live ${live}`);
      pillTxt.textContent = live === 'firing' ? `🔔 SONANDO · min ${minute}`
        : live === 'pending' ? `⏳ pendiente ${pend} de ${win} min` : `✓ ok · min ${minute}`;
    };
    clock.onTick = drawLive;

    thrIn.addEventListener('input', () => { thr = +thrIn.value; refresh(); });
    seg(slide, 'win', v => { win = +v; refresh(); });
    // arrastrar la línea del umbral mueve el slider
    let drag = false;
    const dragTo = e => {
      const p = svgPoint(svg, e);
      const v = (P.y1 - p.y) / (P.y1 - P.y0) * UMB_YMAX;
      const step = +thrIn.step;
      const snapped = Math.max(+thrIn.min, Math.min(+thrIn.max, Math.round(v / step) * step));
      if (snapped !== thr) { thrIn.value = snapped; thrIn.dispatchEvent(new Event('input')); }
    };
    [thrHit, thrTag].forEach(el => el.addEventListener('pointerdown', e => { drag = true; svg.setPointerCapture(e.pointerId); dragTo(e); e.preventDefault(); }));
    svg.addEventListener('pointermove', e => { if (drag) dragTo(e); });
    svg.addEventListener('pointerup', () => { drag = false; });
    svg.addEventListener('pointercancel', () => { drag = false; });
    refresh();
    return {
      start: () => clock.start(), stop: () => clock.stop(), ff: sec => ffClock(clock, sec),
      state: () => ({ threshold: thr, forMin: win, caught: res.caught, missed: res.missed, falsePos: res.falsePos, delay: res.delay, live })
    };
  };

  /* ---------- 11. avisar por síntoma, no por causa ---------- */

  // Una noche de 8 h (un punto por minuto), comprimida a SIN_HOUR s de simulación por hora. Las causas se mueven solas
  // sin que nadie sufra: el job de reportes (02:00) y un backup (07:10) suben la CPU; la caché se llena a las 03:00 y a
  // las 06:20; el supervisor reinicia una réplica a la 01:10 y a las 04:40 (las otras dos atienden). Con incidente, a
  // las 05:00 Pagos se queda sin conexiones a la DB: suben los errores del checkout, la CPU no se entera.
  // El rng se consume igual en las dos noches: lo único que cambia es el incidente.
  const NIGHT_MIN = 480, SIN_HOUR = 4, SIN_SEED = 11;
  const SIN_ALERTS = [
    { k: 'cpu', name: '🔥 CPU alta', rule: '> 85% · 5 min', max: 100, unit: '%', opts: { threshold: 85, forSec: 5 } },
    { k: 'mem', name: '🧠 Memoria alta', rule: '> 85% · 5 min', max: 100, unit: '%', opts: { threshold: 85, forSec: 5 } },
    { k: 'rep', name: '📦 Una réplica caída', rule: '< 3 réplicas · 1 min', max: 3, unit: '', line: 2.5, opts: { threshold: 3, forSec: 1, above: false } },
    { k: 'sym', name: '🛒 Errores de checkout', rule: '> 5% · 5 min', max: 15, unit: '%', opts: { threshold: 5, forSec: 5 } }
  ];

  function nightSeries(incident) {
    const r = rng(SIN_SEED), s = { cpu: [], mem: [], rep: [], sym: [] };
    for (let m = 0; m < NIGHT_MIN; m++) {
      let c = 24 + 10 * r();
      if (m >= 120 && m < 146) c = 90 + 6 * r();
      if (m >= 430 && m < 444) c = 87 + 5 * r();
      let me = 62 + 18 * Math.min(1, m / 180) + 3 * r();
      if (m >= 180 && m < 232) me = 87 + 3 * r();
      else if (m >= 380 && m < 418) me = 87 + 4 * r();
      else if (m >= 232) me = 71 + 4 * r();
      const up = (m >= 70 && m < 73) || (m >= 280 && m < 284) ? 2 : 3;
      let e = 0.2 + 0.5 * r();
      const ri = r();
      if (up < 3) e += 0.8;
      if (incident && m >= 300 && m < 342) e = 8 + 6 * ri;
      s.cpu.push([m, c]); s.mem.push([m, me]); s.rep.push([m, up]); s.sym.push([m, e]);
    }
    return s;
  }

  S.sintoma = slide => {
    const { svg, clock, M } = manual(slide, 'alertc');
    const nights = {};
    ['calm', 'incident'].forEach(n => {
      const series = nightSeries(n === 'incident');
      const firings = {};
      SIN_ALERTS.forEach(a => { firings[a.k] = new AlertRule(a.opts).evaluate(series[a.k]).firings; });
      nights[n] = { series, firings };
    });
    const boxes = [...slide.querySelectorAll('input[data-alert]')];
    const enabled = {};
    boxes.forEach(b => { enabled[b.dataset.alert] = b.checked; });
    const upd = hstats(slide, [['total', 'Alertas por noche'], ['cause', 'Por causa'], ['sym', 'Por síntoma']]);
    const face = slide.querySelector('.pager .face'), pages = slide.querySelector('.pager .pages');
    let night = 'calm', t0 = clock.now, minute = 0, seen = {};

    // geometría: escritorio con rótulos a la izquierda; celular con el rótulo arriba de cada carril
    const LX = M ? { px0: 12, px1: 388 } : { px0: 214, px1: 882 };
    const lane = i => (M ? { y0: 30 + i * 98, top: 30 + i * 98 + 22, bot: 30 + i * 98 + 86 }
      : { y0: 50 + i * 121, top: 50 + i * 121 + 14, bot: 50 + i * 121 + 104 });
    const X = m => LX.px0 + (LX.px1 - LX.px0) * m / NIGHT_MIN;
    const gHead = svgEl('g', {}, svg), gLanes = svgEl('g', {}, svg), gCur = svgEl('g', {}, svg), gPop = svgEl('g', {}, svg);
    const defs = svgEl('defs', {}, svg);
    const clipId = `sin-clip-${Math.random().toString(36).slice(2, 7)}`;
    const clip = svgEl('rect', { x: 0, y: 0, width: 0, height: NetKit.H }, svgEl('clipPath', { id: clipId }, defs));
    for (let h = 0; h <= 8; h++) {
      svgEl('line', { class: 'grid', x1: X(h * 60), x2: X(h * 60), y1: lane(0).y0 + 4, y2: lane(3).bot }, gHead);
      if (!M || h % 2 === 0) txt(gHead, { class: 'ax', x: X(h * 60), y: M ? 22 : 36, 'text-anchor': h === 0 ? 'start' : h === 8 ? 'end' : 'middle' }, `0${h}:00`);
    }
    const lanes = SIN_ALERTS.map((a, i) => {
      const L = lane(i), g = svgEl('g', { class: `lane l-${a.k}` }, gLanes);
      svgEl('rect', { class: 'lane-bg', x: M ? 4 : 10, y: L.y0 + 2, width: M ? 392 : 880, height: M ? 92 : 114, rx: 10 }, g);
      if (M) txt(g, { class: 'lane-name', x: 12, y: L.y0 + 16 }, `${a.name}  ·  ${a.rule}`);
      else {
        txt(g, { class: 'lane-name', x: 24, y: L.y0 + 40 }, a.name);
        txt(g, { class: 'lane-rule', x: 24, y: L.y0 + 62 }, a.rule);
        txt(g, { class: 'lane-kind', x: 24, y: L.y0 + 84 }, a.k === 'sym' ? 'síntoma: lo que sufre el usuario' : 'causa');
      }
      const Y = v => L.bot - (L.bot - L.top) * Math.min(v, a.max) / a.max;
      const thr = Y(a.line || a.opts.threshold); // réplicas: la línea va entre 3 y 2 (si no, tapa la serie)
      svgEl('line', { class: 'thr-line small', x1: LX.px0, x2: LX.px1, y1: thr, y2: thr }, g);
      const dim = svgEl('polyline', { class: 'series dim' }, g);
      const lit = svgEl('polyline', { class: 'series', 'clip-path': `url(#${clipId})` }, g);
      const marks = svgEl('g', {}, g);
      return { a, g, Y, dim, lit, marks, L };
    });
    const cur = svgEl('line', { class: 'cursor', y1: M ? 24 : 40, y2: lane(3).bot }, gCur);
    // la hora actual va en la fila de las horas, sobre un fondo que tapa el rótulo de abajo
    const clockG = svgEl('g', { class: 'night-clock' }, gCur);
    svgEl('rect', { x: M ? -30 : -36, y: M ? -13 : -15, width: M ? 60 : 72, height: M ? 20 : 24, rx: 7 }, clockG);
    const clockTxt = txt(clockG, { y: M ? 2 : 3, 'text-anchor': 'middle' }, '');

    const drawNight = () => {
      const n = nights[night];
      lanes.forEach(ln => {
        const p = pts(n.series[ln.a.k], X, ln.Y);
        ln.dim.setAttribute('points', p);
        ln.lit.setAttribute('points', p);
        ln.marks.innerHTML = '';
        ln.pages = n.firings[ln.a.k].map(f => {
          const x = X(f[0]), w = Math.max(5, X(f[1]) - x);
          const g = svgEl('g', { class: 'page', 'data-start': f[0] }, ln.marks);
          svgEl('rect', { class: 'fire-band', x, y: ln.L.top - 2, width: w, height: ln.L.bot - ln.L.top + 4, rx: 3 }, g);
          txt(g, { class: 'pg-icon', x: x + w / 2, y: ln.L.top + 14, 'text-anchor': 'middle' }, '📟');
          return { g, f };
        });
      });
    };
    const count = () => {
      const f = {};
      SIN_ALERTS.forEach(a => { f[a.k] = nights[night].firings[a.k].filter(x => x[0] <= minute).length; });
      return f;
    };
    const draw = () => {
      minute = Math.min(NIGHT_MIN, (clock.now - t0) / SIN_HOUR * 60);
      const x = X(minute);
      clip.setAttribute('x', LX.px0); clip.setAttribute('width', Math.max(0, x - LX.px0));
      cur.setAttribute('x1', x); cur.setAttribute('x2', x);
      clockG.setAttribute('transform', `translate(${Math.max(LX.px0 + 30, Math.min(LX.px1 - 30, x))},${M ? 18 : 32})`);
      const hh = Math.floor(minute / 60), mm = Math.floor(minute % 60);
      clockTxt.textContent = minute >= NIGHT_MIN ? '🌅 08:00' : `0${hh}:${mm < 10 ? '0' : ''}${mm}`;
      lanes.forEach(ln => {
        const on = enabled[ln.a.k];
        ln.g.classList.toggle('off', !on);
        ln.pages.forEach(p => {
          const shown = p.f[0] <= minute, firing = shown && minute <= p.f[1] && minute < NIGHT_MIN;
          p.g.classList.toggle('shown', shown);
          p.g.classList.toggle('firing', firing && on);
          p.g.querySelector('.pg-icon').textContent = on ? '📟' : '🔕';
          const key = `${night}-${ln.a.k}-${p.f[0]}`;
          if (shown && !seen[key]) {
            seen[key] = true;
            if (on) pop(gPop, X(p.f[0]), ln.L.top - 4, ln.a.k === 'sym' ? '📟 ¡usuarios!' : '📟', C.err);
          }
        });
      });
      const f = count(), cause = ['cpu', 'mem', 'rep'].reduce((s, k) => s + (enabled[k] ? f[k] : 0), 0);
      const sym = enabled.sym ? f.sym : 0, total = cause + sym;
      upd({ total, cause, sym });
      face.textContent = total === 0 ? '😴' : total < 3 ? '😪' : total < 5 ? '😩' : '🧟';
      pages.textContent = total ? `${'📟'.repeat(total)}  te despertaron ${total} ${total === 1 ? 'vez' : 'veces'}` : 'durmiendo…';
    };
    clock.onTick = draw;

    const restart = () => { t0 = clock.now; seen = {}; drawNight(); draw(); };
    seg(slide, 'night', v => { night = v; restart(); });
    boxes.forEach(b => b.addEventListener('change', () => { enabled[b.dataset.alert] = b.checked; draw(); }));
    on(slide, '[data-act=reset]', restart);
    restart();
    return {
      start: () => clock.start(), stop: () => clock.stop(), ff: sec => ffClock(clock, sec),
      state: () => {
        const fired = count();
        const total = SIN_ALERTS.reduce((s, a) => s + (enabled[a.k] ? fired[a.k] : 0), 0);
        return { night, minute, enabled: Object.assign({}, enabled), fired, total, firings: nights[night].firings };
      }
    };
  };

  /* ---------- 12. SLO: cuánto fallar está permitido ---------- */

  // Un SLO sobre los últimos 30 días (ventana móvil), y un mes comprimido a SLO_DAY s de simulación por día, en pasos
  // de una hora de juego con SLO_PER_HOUR checkouts. Los fallidos salen de un acumulador (sin rachas de suerte): sano ≈ 0,04%, roto ≈ 3% (varía por día con el
  // rng sembrado). Los tres objetivos corren a la vez sobre los mismos checkouts, cada uno con su ErrorBudget del mes, su
  // ErrorBudget corto (SLO_SHORT h, para el burn rate) y su AlertRule: cambiar el objetivo muestra el mismo mes con otra
  // vara, sin recalcular. Alerta por velocidad de consumo: burn rate > SLO_BURN durante 1 h (a 2× el presupuesto del mes
  // dura 15 días). Con slo = 1, ErrorBudget pone un piso al denominador (no divide por cero).
  const SLO_DAY = 1, SLO_DAYS = 30, SLO_PER_HOUR = 60, SLO_SHORT = 48, SLO_BURN = 2, SLO_SEED = 12;
  const SLO_SANO = 0.0004, SLO_ROTO = 0.03, SLO_OBJ = ['99', '99.5', '99.9'];

  S.slo = slide => {
    const { svg, clock, M } = manual(slide, 'alertc');
    const H_END = SLO_DAYS * 24;
    const upd = hstats(slide, [['remaining', 'Presupuesto'], ['burn', 'Consumo'], ['bad', 'Fallas / permitidas']]);
    let obj = slide.querySelector('.seg[data-group=slo] .active').dataset.v;
    let t0, hour, acc, r, dayR, broken, breaks, firstBreak, B;

    // Un mes sano antes del día 0: la ventana de 30 días arranca llena (si arrancara vacía, el permitido crecería con el
    // tráfico y el presupuesto "se recuperaría" solo después de un incidente)
    const fresh = () => {
      t0 = clock.now; acc = 0; r = rng(SLO_SEED); dayR = 0; broken = false; breaks = []; firstBreak = null;
      B = {};
      SLO_OBJ.forEach(k => {
        const slo = +k / 100;
        B[k] = { month: new ErrorBudget({ slo, windowSec: H_END }), short: new ErrorBudget({ slo, windowSec: SLO_SHORT }),
          rule: new AlertRule({ threshold: SLO_BURN, forSec: 1 }), curve: [], alerts: [], exhaustedAt: null, st: 'ok' };
      });
      for (hour = -H_END; hour < 0;) addHour();
      SLO_OBJ.forEach(k => {
        const b = B[k];
        b.m = b.month.state(0); b.s = b.short.state(0);
        b.curve.push([0, b.m.remainingPct]);
      });
    };
    // Suma una hora de checkouts a los presupuestos de los tres objetivos
    const addHour = () => {
      if (hour % 24 === 0) dayR = r();
      const rate = broken ? SLO_ROTO * (0.85 + 0.3 * dayR) : SLO_SANO * (0.6 + 0.8 * dayR);
      acc += rate * SLO_PER_HOUR;
      const bad = Math.floor(acc);
      acc -= bad;
      SLO_OBJ.forEach(k => {
        const b = B[k];
        for (let i = 0; i < SLO_PER_HOUR; i++) {
          const t = hour + (i + 0.5) / SLO_PER_HOUR;
          b.month.add(t, i >= bad);
          if (hour >= -SLO_SHORT) b.short.add(t, i >= bad);
        }
      });
      hour++;
    };
    const stepHour = () => {
      addHour();
      const end = hour;
      SLO_OBJ.forEach(k => {
        const b = B[k];
        b.m = b.month.state(end); b.s = b.short.state(end);
        const st = b.rule.step(end, b.s.burnRate);
        if (st === 'firing' && b.st !== 'firing') b.alerts.push([end, end]);
        if (st === 'firing') b.alerts[b.alerts.length - 1][1] = end;
        b.st = st;
        if (b.exhaustedAt === null && firstBreak !== null && b.m.remainingPct <= 0) b.exhaustedAt = end;
        b.curve.push([end, b.m.remainingPct]);
      });
      if (broken) breaks[breaks.length - 1][1] = end;
    };

    // geometría
    const G = M
      ? { x0: 40, x1: 388, head: 24, barY: 44, barH: 34, py0: 110, py1: 330, gy: 372 }
      : { x0: 64, x1: 872, head: 34, barY: 56, barH: 44, py0: 148, py1: 430, gy: 486 };
    const X = h => G.x0 + (G.x1 - G.x0) * h / H_END;
    const Y = v => G.py0 + (G.py1 - G.py0) * (100 - v) / 200; // de 100% (arriba) a -100% (abajo)
    const gBg = svgEl('g', {}, svg), gBands = svgEl('g', {}, svg), gCurve = svgEl('g', {}, svg), gUi = svgEl('g', {}, svg);
    const dayTxt = txt(gUi, { class: 'slo-day', x: G.x0 - (M ? 30 : 50), y: G.head }, '');
    const objTxt = txt(gUi, { class: 'slo-obj', x: G.x1, y: G.head, 'text-anchor': 'end' }, '');
    const barX = G.x0 - (M ? 30 : 50), barW = G.x1 - barX;
    svgEl('rect', { class: 'bud-bg', x: barX, y: G.barY, width: barW, height: G.barH, rx: 10 }, gUi);
    const barFill = svgEl('rect', { class: 'bud-fill', x: barX, y: G.barY, width: barW, height: G.barH, rx: 10 }, gUi);
    const barTxt = txt(gUi, { class: 'bud-txt', x: barX + 14, y: G.barY + G.barH / 2 + 6 }, '');
    for (const v of [100, 50, 0, -100]) {
      svgEl('line', { class: v === 0 ? 'grid zero' : 'grid', x1: G.x0, x2: G.x1, y1: Y(v), y2: Y(v) }, gBg);
      txt(gBg, { class: 'ax', x: G.x0 - 6, y: Y(v) + 4, 'text-anchor': 'end' }, `${v}%`);
    }
    svgEl('rect', { class: 'neg-zone', x: G.x0, y: Y(0), width: G.x1 - G.x0, height: Y(-100) - Y(0) }, gBg);
    txt(gBg, { class: 'neg-label', x: G.x1 - 8, y: Y(0) + 18, 'text-anchor': 'end' }, 'presupuesto agotado');
    for (let d = 0; d <= SLO_DAYS; d += M ? 10 : 5) txt(gBg, { class: 'ax', x: X(d * 24), y: G.py1 + 18, 'text-anchor': d === SLO_DAYS ? 'end' : d ? 'middle' : 'start' }, `día ${d}`);
    txt(gBg, { class: 'ax-title', x: G.x0, y: G.py0 - 10 }, 'presupuesto restante a lo largo del mes');
    const curve = svgEl('polyline', { class: 'series budget' }, gCurve);
    const now = svgEl('line', { class: 'cursor', y1: G.py0, y2: G.py1 }, gCurve);
    // velocidad de consumo
    const burnTxt = txt(gUi, { class: 'burn-txt', x: barX, y: G.gy }, '');
    const lastsTxt = txt(gUi, { class: 'lasts-txt', x: barX, y: G.gy + (M ? 22 : 28) }, '');
    const pill = svgEl('g', { class: 'pill', transform: `translate(${G.x1},${G.gy + (M ? 48 : 4)})` }, gUi);
    svgEl('rect', { x: M ? -220 : -260, y: -17, width: M ? 220 : 260, height: 32, rx: 16 }, pill);
    const pillTxt = txt(pill, { x: M ? -110 : -130, y: 5, 'text-anchor': 'middle' }, '');

    const pct = v => `${comma(v, Math.abs(v) < 10 && v % 1 ? 1 : 0)}%`;
    const draw = () => {
      const b = B[obj], rem = b.m.remainingPct, burn = b.s.burnRate, firing = b.st === 'firing';
      dayTxt.textContent = hour >= H_END ? `Día ${SLO_DAYS} de ${SLO_DAYS} · fin del mes` : `Día ${Math.floor(hour / 24)} de ${SLO_DAYS}`;
      objTxt.textContent = `objetivo ${comma(+obj, obj.includes('.') ? 1 : 0)}%${broken ? ' · 💥 Pagos roto' : ''}`;
      barFill.setAttribute('width', barW * Math.max(0, rem) / 100);
      barFill.setAttribute('class', `bud-fill ${rem > 50 ? 'ok' : rem > 0 ? 'warn' : 'out'}`);
      barTxt.textContent = rem > 0 ? `${M ? 'Presupuesto' : 'Presupuesto de error'}: queda ${pct(rem)}` : '⛔ Presupuesto agotado';
      gBands.innerHTML = '';
      breaks.forEach(([a, z]) => svgEl('rect', { class: 'broken-band', x: X(a), y: G.py0, width: Math.max(2, X(z) - X(a)), height: G.py1 - G.py0 }, gBands));
      b.alerts.forEach(([a, z]) => {
        svgEl('rect', { class: 'hit-mark', x: X(a), y: G.py0 - 2, width: Math.max(4, X(z) - X(a)), height: 7, rx: 2 }, gBands);
      });
      curve.setAttribute('points', pts(b.curve, X, Y));
      now.setAttribute('x1', X(hour)); now.setAttribute('x2', X(hour));
      burnTxt.textContent = `Velocidad de consumo (últimas ${SLO_SHORT} h): ${comma(burn, burn < 10 ? 2 : 1)}×`;
      // lo que queda (no un presupuesto entero) dividido la velocidad: a 1× un presupuesto entero dura SLO_DAYS
      const left = rem / 100 * SLO_DAYS / Math.max(burn, 1e-9);
      lastsTxt.textContent = rem <= 0 ? 'el presupuesto ya se agotó: cada falla nueva es fuera del objetivo'
        : burn < 0.05 || left > 60 ? 'a este ritmo, lo que queda alcanza de sobra'
        : `a este ritmo, lo que queda dura ${left >= 2 ? `${Math.round(left)} días` : `${Math.max(1, Math.round(left * 24))} h`}`;
      gUi.classList.toggle('alerting', firing);
      pill.setAttribute('class', `pill ${firing ? 'firing' : 'ok'}`);
      pillTxt.textContent = firing ? `🔔 Consumo rápido (> ${SLO_BURN}×)` : `✓ Sin alerta (avisa con > ${SLO_BURN}×)`;
      upd({ remaining: rem > 0 ? pct(rem) : 'agotado', burn: `${comma(burn, burn < 10 ? 2 : 1)}×`, bad: `${b.m.bad} / ${comma(b.m.allowed, b.m.allowed % 1 ? 1 : 0)}` });
    };
    let drawn = -1;
    clock.onTick = () => {
      const target = Math.min(H_END, Math.floor((clock.now - t0) / SLO_DAY * 24));
      while (hour < target) stepHour();
      if (hour !== drawn) { drawn = hour; draw(); }
    };

    seg(slide, 'slo', v => { obj = v; showModeIn(slide, v); draw(); });
    on(slide, '[data-act=break]', () => {
      if (broken || hour >= H_END) return;
      broken = true; breaks.push([hour, hour]);
      if (firstBreak === null) firstBreak = hour;
      draw();
    });
    on(slide, '[data-act=heal]', () => { broken = false; draw(); });
    on(slide, '[data-act=reset]', () => { fresh(); drawn = -1; draw(); });
    fresh();
    draw();
    return {
      start: () => clock.start(), stop: () => clock.stop(), ff: sec => ffClock(clock, sec),
      state: () => {
        const b = B[obj];
        return { slo: +obj, day: hour / 24, broken, burnRate: b.s.burnRate, remainingPct: b.m.remainingPct,
          alert: b.st === 'firing', bad: b.m.bad, allowed: b.m.allowed,
          exhaustedAfter: b.exhaustedAt === null ? null : (b.exhaustedAt - firstBreak) / 24 };
      }
    };
  };

  /* ---------- helpers de reaccionar solo (13–17) ---------- */

  // Grupo propio de la escena dentro del svg de la ShopSim: _build vacía el svg al redibujar (reset, escalar),
  // así que se vuelve a colgar si quedó afuera.
  const overlay = (sim, cls) => {
    const g = svgEl('g', { class: cls });
    return () => { if (!g.isConnected) sim.svg.appendChild(g); return g; };
  };
  // Cada tanto en tiempo de simulación (para lo que se dibuja o se calcula sobre ventanas)
  const throttleTick = (sim, sec, fn) => {
    let last = -Infinity;
    sim.on('tick', now => { if (now - last >= sec) { last = now; fn(); } });
    sim.on('reset', () => { last = -Infinity; fn(); });
  };

  /* ---------- 13. health checks: ¿vivo? ¿listo? ---------- */

  // Dos réplicas; colgar = sólo Pagos 1 (así se ve que con readiness la otra atiende todo); deploy lento = Pagos 2
  // se reinicia y tarda HEALTH_WARM s en estar lista. El supervisor siempre levanta lo que liveness mata.
  const HEALTH_WARM = 5;
  const HEALTH_OPTS = { rate: 6, replicas: 2, warmup: HEALTH_WARM, restartPolicy: 'always', hcInterval: 1, hcFall: 2 };
  const PROBES = { live: { liveness: true, readiness: false }, ready: { liveness: false, readiness: true }, both: { liveness: true, readiness: true } };

  S.health = slide => {
    let mode = 'live';
    const opts = () => Object.assign({}, HEALTH_OPTS, PROBES[mode]);
    const sim = setupShop(slide, opts());
    const layer = overlay(sim, 'probe-badges');
    // Debajo de cada réplica, lo que contestaría a cada pregunta (vivo: el proceso contesta; listo: puede atender)
    const draw = () => {
      const g = layer();
      g.innerHTML = '';
      sim.reps.forEach((r, i) => {
        const n = r.node, st = sim.replicaState(i);
        if (!n) return;
        const live = st.up && !st.hang, ready = st.ready;
        const t = svgEl('text', { class: 'probe-badge', 'data-rep': i, x: n.x, y: n.y + n.hh + (sim.v ? 15 : 19), 'text-anchor': 'middle' }, g);
        const span = (cls, s) => { const x = svgEl('tspan', { class: cls }, t); x.textContent = s; return x; };
        span(`p-live ${live ? 'ok' : 'no'}`, `vivo ${live ? '✓' : '✗'}`);
        span('p-sep', ' · ');
        span(`p-ready ${ready ? 'ok' : 'no'}`, `listo ${ready ? '✓' : '✗'}`);
      });
    };
    throttleTick(sim, 0.1, draw);
    seg(slide, 'probe', v => { mode = v; showModeIn(slide, v); sim.reset(opts()); });
    on(slide, '[data-act=hang]', () => sim.hangReplica(0));
    on(slide, '[data-act=deploy]', () => sim.restartReplica(1));
    on(slide, '[data-act=heal]', () => sim.heal());
    on(slide, '[data-act=reset]', () => sim.reset(opts()));
    draw();
    return Object.assign(life(sim), { state: () => ({ mode }) });
  };

  /* ---------- 14. supervisor: si se cae, levantalo ---------- */

  // Una réplica. «Una caída» la tira (arranca bien); «bug al arrancar» es un crash loop hasta 🔧.
  // La línea de tiempo sale de los eventos 'react' restart (detail.delay = la espera antes de ese reinicio).
  const SUP_OPTS = { rate: 6 };
  const SUP_ROWS = 5, SUP_CAP = 16;

  S.supervisor = slide => {
    let policy = 'on-failure';
    const opts = () => Object.assign({}, SUP_OPTS, { restartPolicy: policy });
    const sim = setupShop(slide, opts());
    const tl = slide.querySelector('.tl');
    let rows = [], downAt = null;
    const bar = (sec, cls = '') => `<span class="tl-bar"><i class="${cls}" style="width:${Math.max(4, Math.min(1, sec / SUP_CAP) * 100).toFixed(1)}%"></i></span>`;
    sim.on('react', e => { if (e.kind === 'restart') rows.push({ n: e.detail.restarts, delay: e.detail.delay }); });
    const draw = () => {
      const st = sim.replicaState(0), now = sim.now;
      const down = !st.up && !st.booting;
      if (down && downAt === null) downAt = now;
      if (!down) downAt = null;
      let html = rows.slice(-SUP_ROWS).map(r =>
        `<div class="tl-row" data-delay="${r.delay}"><span class="tl-n">🤖 ↻${r.n}</span>${bar(r.delay)}<span class="tl-d">${r.delay} s</span></div>`).join('');
      if (down && st.backoffUntil > now) {
        const left = Math.ceil(st.backoffUntil - now - 1e-9), total = Math.round(st.backoffUntil - downAt);
        html += `<div class="tl-row wait"><span class="tl-n">💥 caído</span>${bar(total, 'wait')}<span class="tl-d">faltan ${left} s</span></div>`;
      } else if (down) {
        html += `<div class="tl-row dead"><span class="tl-n">💥 caído</span><span class="tl-msg">nadie lo levanta</span></div>`;
      } else if (st.booting && rows.length) {
        html += `<div class="tl-row boot"><span class="tl-n">⏳</span><span class="tl-msg">arrancando…</span></div>`;
      }
      tl.innerHTML = html || '<div class="tl-empty">Todavía no se cayó.</div>';
    };
    throttleTick(sim, 0.1, draw);
    sim.on('reset', () => { rows = []; downAt = null; draw(); });
    seg(slide, 'policy', v => { policy = v; showModeIn(slide, v); sim.reset(opts()); });
    on(slide, '[data-act=crash]', () => sim.crashReplica(0));
    on(slide, '[data-act=loop]', () => sim.breakPagos('crash'));
    on(slide, '[data-act=heal]', () => sim.heal());
    on(slide, '[data-act=reset]', () => sim.reset(opts()));
    draw();
    return Object.assign(life(sim), { state: () => ({ policy, delays: rows.map(r => r.delay) }) });
  };

  /* ---------- 15. autoscaling: sumar réplicas con la carga ---------- */

  // Con readiness: las réplicas nuevas no reciben pedidos mientras calientan (sin readiness devolverían 503).
  // «Enfriamiento» es a la vez el tiempo mínimo entre dos cambios y la ventana para bajar (cuánto tiempo seguido
  // tiene que sobrar capacidad antes de sacar una réplica): con 0 suma antes de que las nuevas estén listas y oscila.
  const AS_OPTS = { readiness: true, showPool: true };
  const AS_START = 3, AS_POINTS = 60, AS_EVERY_CHART = 0.5, AS_DEMAND = 5;

  S.autoscaling = slide => {
    const q = c => slide.querySelector(c);
    const target = q('input.target'), cool = q('input.cooldown'), rate = q('input.rate');
    const cfg = () => ({ target: +target.value / 100, min: 1, max: 6, cooldown: +cool.value, startup: AS_START, downWindow: +cool.value });
    const opts = () => Object.assign({}, AS_OPTS, { rate: +rate.value, autoscale: cfg() });
    const sim = setupShop(slide, opts());
    rateSlider(slide, sim);
    const syncAS = () => {
      q('.target-out').textContent = `${target.value}%`;
      q('.cooldown-out').textContent = `${cool.value} s`;
      sim.set('autoscale', cfg());
    };
    target.addEventListener('input', syncAS);
    cool.addEventListener('input', syncAS);
    syncAS();

    let arrivals = [], dirs = [];
    sim.on('request', () => arrivals.push(sim.now));
    sim.on('react', e => { if (e.kind === 'scale') dirs.push(Math.sign(e.detail.to - e.detail.from)); });
    const changes = () => dirs.reduce((c, d, i) => c + (i && d !== dirs[i - 1] ? 1 : 0), 0);

    const blank = () => Array(AS_POINTS).fill(null);
    const ch = new Chart(q('canvas.as-chart'), {
      type: 'line',
      data: { labels: Array(AS_POINTS).fill(''), datasets: [
        { label: 'réplicas', data: blank(), yAxisID: 'y0', borderColor: '#60a5fa', backgroundColor: '#60a5fa22', stepped: true, fill: true, pointRadius: 0, borderWidth: 2.5 },
        { label: 'pedidos/s', data: blank(), yAxisID: 'y1', borderColor: '#a78bfa', backgroundColor: '#a78bfa00', tension: 0.35, pointRadius: 0, borderWidth: 2 }
      ] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 10, boxHeight: 10, font: { size: 12 } } } },
        scales: {
          x: { display: false },
          y0: { position: 'left', min: 0, max: 6, ticks: { color: '#60a5fa', stepSize: 2, font: { size: 11 } }, grid: { color: 'rgba(148,163,184,.12)' } },
          y1: { position: 'right', min: 0, suggestedMax: 24, ticks: { color: '#a78bfa', font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
    const out = q('.as-out');
    const sample = () => {
      const from = sim.now - AS_DEMAND;
      while (arrivals.length && arrivals[0] <= from) arrivals.shift();
      const [rep, dem] = ch.data.datasets;
      rep.data.push(sim.replicaCount); rep.data.shift();
      dem.data.push(+(arrivals.length / Math.min(AS_DEMAND, Math.max(sim.now, 1))).toFixed(1)); dem.data.shift();
      ch.update('none');
      const c = changes();
      out.innerHTML = `🤖 <b>${sim.replicaCount}</b> ${sim.replicaCount === 1 ? 'réplica' : 'réplicas'}` +
        (c ? ` · <b class="${c >= 3 ? 'bad' : ''}">${c} ${c === 1 ? 'cambio' : 'cambios'} de dirección</b>` : '');
    };
    let last = -Infinity;
    sim.on('tick', now => { if (now - last >= AS_EVERY_CHART) { last = now; sample(); } });
    sim.on('reset', () => { arrivals = []; dirs = []; last = -Infinity; ch.data.datasets.forEach(d => { d.data = blank(); }); sample(); });
    on(slide, '[data-act=reset]', () => { resetSliders(slide); sim.reset(opts()); });
    sample();
    return Object.assign(life(sim), { state: () => ({ replicas: sim.replicaCount, changes: changes() }) });
  };

  /* ---------- 16. circuit breaker: cortar a tiempo ---------- */

  const BRK_OPTS = { rate: 6 };
  const GUARDS = { none: {}, timeout: { timeout: 2 }, breaker: { timeout: 2, breaker: { failures: 5, openFor: 5 } } };

  S.breaker = slide => {
    let mode = 'none';
    const opts = () => Object.assign({}, BRK_OPTS, GUARDS[mode]);
    const sim = setupShop(slide, opts());
    breakButtons(slide, sim);
    seg(slide, 'guard', v => { mode = v; showModeIn(slide, v); sim.reset(opts()); });
    on(slide, '[data-act=reset]', () => sim.reset(opts()));
    return Object.assign(life(sim), { state: () => ({ mode, breaker: sim.brState }) });
  };

  /* ---------- 17. límites: cuando lo automático empeora las cosas ---------- */

  // El mismo incidente (slowdb a los LIM_BREAK_AT s) con una reacción automática distinta en cada modo:
  // reiniciar = regla de la escena (Pagos con más de LIM_RULE % de errores en LIM_RULE_WIN s → 🤖 reinicio, como
  // mucho cada LIM_RULE_GAP s); escalar = autoscaler sobre el pool lleno; reintentos = Órdenes reintenta 2 veces.
  const LIM_BREAK_AT = 3, LIM_RULE = 30, LIM_RULE_WIN = 5, LIM_RULE_GAP = 15, LIM_WIN = 10;
  const LIM_OPTS = { rate: 6, showPool: true };
  const LIM_MODES = {
    restart: {},
    scale: { readiness: true, autoscale: { target: 0.7, min: 1, max: 6, cooldown: 5, startup: 3 } },
    retry: { retries: 2 }
  };

  S.limites = slide => {
    let mode = 'restart', restarts = [], arrivals = [];
    const opts = () => Object.assign({}, LIM_OPTS, LIM_MODES[mode]);
    const sim = setupShop(slide, opts());
    const upd = hstats(slide, [['err', 'Errores'], ['db', 'DB p95'], ['load', 'A Pagos'], ['reps', 'Réplicas']]);
    const out = slide.querySelector('.lim-out');
    const arm = () => {
      sim.after(LIM_BREAK_AT, () => sim.breakPagos('slowdb'));
      if (mode !== 'restart') return;
      let lastAt = -Infinity;
      sim.every(1, () => {
        if (sim.now - lastAt < LIM_RULE_GAP || !sim.replicaState(0).up) return;
        if (sim.window(LIM_RULE_WIN, 'pagos').errPct <= LIM_RULE) return;
        lastAt = sim.now;
        restarts.push(sim.now);
        sim.restartReplica(0, { auto: true, why: `más de ${LIM_RULE}% de errores` });
      });
    };
    sim.on('request', () => arrivals.push(sim.now));
    const draw = () => {
      const from = sim.now - LIM_WIN;
      while (arrivals.length && arrivals[0] <= from) arrivals.shift();
      const span = Math.min(LIM_WIN, Math.max(sim.now, 1));
      const demand = arrivals.length / span, toPagos = sim.window(LIM_WIN, 'pagos').n / span;
      const ratio = demand > 0 ? toPagos / demand : 0;
      const err = sim.window(5).errPct, db = sim.window(LIM_WIN, 'db').p95, n = sim.replicaCount;
      upd({ err: `${Math.round(err)}%`, db: `${comma(db)} s`, load: `×${comma(ratio)}`, reps: n });
      const bad = { err: err > 10, db: db > 1.5, load: ratio >= 1.5, reps: n > 1 && mode === 'scale' && sim.fault };
      for (const k in bad) slide.querySelector(`.hstats .s-${k}`).classList.toggle('bad', !!bad[k]);
      out.innerHTML = !sim.fault && sim.now < LIM_BREAK_AT ? `Todo sano. La DB se pone lenta a los ${LIM_BREAK_AT} s…`
        : !sim.fault ? '🔧 DB arreglada: ahora sí se recupera.'
        : mode === 'restart' ? (restarts.length ? `🤖 reinició Pagos <b>${restarts.length} ${restarts.length === 1 ? 'vez' : 'veces'}</b> · la DB sigue lenta` : '💥 DB lenta: Pagos empieza a fallar…')
        : mode === 'scale' ? `🤖 ${n} ${n === 1 ? 'réplica' : 'réplicas'} = <b>${n * sim.o.pool} conexiones</b> contra la misma DB`
        : `Pagos recibe <b>${comma(toPagos)}/s</b> para ${comma(demand)} checkouts/s`;
    };
    throttleTick(sim, 0.5, draw);
    sim.on('reset', () => { restarts = []; arrivals = []; arm(); draw(); });
    seg(slide, 'react', v => { mode = v; showModeIn(slide, v); sim.reset(opts()); });
    on(slide, '[data-act=heal]', () => { sim.heal(); draw(); });
    on(slide, '[data-act=reset]', () => sim.reset(opts()));
    arm();
    draw();
    return Object.assign(life(sim), { state: () => ({ mode, restarts: restarts.slice() }) });
  };

  window.Scenes = S;
})();
