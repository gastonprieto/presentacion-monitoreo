/* Una función por slide interactiva. Cada una recibe el <section> y devuelve { start, stop }.
   main.js las crea la primera vez que se visita la slide y las pausa al salir.
   Para una slide nueva: <section data-scene="nombre"> en index.html + S.nombre = slide => { … } acá. */
(function () {
  'use strict';

  const { Sim, Clock, svgEl, cubic, curve, edge, pop, C } = window.NetKit;
  const S = {};

  /* ---------- helpers ---------- */

  // Crea la Sim sobre <svg class="sim"> y conecta los widgets que haya en la slide:
  // .stats (data-fields, data-window), .strip, canvas.chart, canvas.histo
  function setup(slide, opts) {
    const sim = new Sim(slide.querySelector('svg.sim'), opts);
    const st = slide.querySelector('.stats');
    if (st) Widgets.stats(st, sim, st.dataset.fields ? st.dataset.fields.split(',') : null, +(st.dataset.window || 5));
    const strip = slide.querySelector('.strip');
    if (strip) Widgets.strip(strip, sim);
    const cv = slide.querySelector('canvas.chart');
    if (cv) Widgets.chart(cv, sim);
    const hist = slide.querySelector('canvas.histo');
    if (hist) Widgets.histogram(hist, sim);
    return sim;
  }

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

  S.title = slide => {
    const sim = new Sim(slide.querySelector('svg.bg'), {
      clients: 3, servers: 4, rate: 5, colorByClient: true, showHandled: false, serviceTime: 0.6
    });
    return life(sim);
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

  window.Scenes = S;
})();
