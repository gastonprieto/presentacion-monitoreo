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
  // canvas.svc-chart (data-service, data-fields), .logs y .trace.
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
    slide.querySelectorAll('.logs').forEach(el => Widgets.logStream(el, sim));
    slide.querySelectorAll('.trace').forEach(el => Widgets.traceView(el, sim));
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
    return life(sim);
  };

  window.Scenes = S;
})();
