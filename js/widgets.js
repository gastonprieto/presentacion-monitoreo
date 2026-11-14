/* Widgets HTML que leen una ShopSim: métricas por servicio, logs y trazas. */
(function () {
  'use strict';

  const fmtLat = v => (v == null ? '—' : v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(1)} s`);

  // Ejecuta fn cada `every` segundos de tiempo de simulación
  function throttle(sim, every, fn) {
    let last = -Infinity;
    sim.on('tick', now => { if (now - last >= every) { last = now; fn(); } });
    sim.on('reset', () => { last = -Infinity; fn(true); });
  }

  /* ---------- widgets del dashboard de la tienda (ShopSim): métricas, logs y trazas ---------- */

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const comma = (x, d = 1) => x.toFixed(d).replace('.', ',');
  const fmtMs = v => (v == null ? '—' : v < 1 ? `${Math.round(v * 1000)} ms` : `${comma(v)} s`);
  const SVC_NAME = { checkout: 'Checkout', ordenes: 'Órdenes', pagos: 'Pagos', envios: 'Envíos', db: 'DB' };
  const SVC_COLOR = { ordenes: '#38bdf8', pagos: '#f472b6', envios: '#2dd4bf' };

  const FIELD = {
    n: { label: 'Pedidos', fmt: w => String(w.n) },
    rps: { label: 'Pedidos/s', fmt: w => comma(w.rps) },
    errPct: { label: '% error', fmt: w => `${w.errPct.toFixed(0)}%` },
    avg: { label: 'Promedio', fmt: w => fmtMs(w.n ? w.avg : null) },
    p50: { label: 'p50', fmt: w => fmtMs(w.n ? w.p50 : null) },
    p95: { label: 'p95', fmt: w => fmtMs(w.n ? w.p95 : null) },
    p99: { label: 'p99', fmt: w => fmtMs(w.n ? w.p99 : null) },
    sat: { label: 'Pool en uso', fmt: (w, svc) => (svc === 'pagos' ? `${Math.round(w.sat * 100)}%` : '—') }
  };

  // Contadores de un servicio: <div class="sstats" data-service="pagos" data-fields="rps,p95,errPct" data-window="10">
  function svcStats(el, sim, opts) {
    opts = opts || {};
    const svc = opts.service || el.dataset.service || 'checkout';
    const fields = (opts.fields || (el.dataset.fields ? el.dataset.fields.split(',') : ['rps', 'p95', 'errPct', 'sat']))
      .filter(f => FIELD[f]);
    const win = +(opts.window || el.dataset.window || 10);
    el.innerHTML = fields
      .map(f => `<div class="sstat s-${f}"><b data-f="${f}">—</b><span>${FIELD[f].label}</span></div>`).join('');
    const cells = {};
    fields.forEach(f => { cells[f] = el.querySelector(`[data-f="${f}"]`); });
    const update = () => {
      const w = sim.window(win, svc);
      fields.forEach(f => { cells[f].textContent = FIELD[f].fmt(w, svc); });
    };
    throttle(sim, 0.25, update);
    update();
    return { update };
  }

  // Serie en el tiempo de un servicio. Por defecto p95 (s, eje izquierdo) y % error (eje derecho).
  const SERIES = {
    avg: { label: 'Promedio', color: '#cbd5e1', unit: 's', val: w => (w.n ? w.avg : null) },
    p50: { label: 'p50', color: '#4ade80', unit: 's', val: w => (w.n ? w.p50 : null) },
    p95: { label: 'Latencia p95', color: '#a78bfa', unit: 's', val: w => (w.n ? w.p95 : null) },
    p99: { label: 'p99', color: '#f472b6', unit: 's', val: w => (w.n ? w.p99 : null) },
    errPct: { label: '% error', color: '#f87171', unit: '%', val: w => (w.n ? w.errPct : null) },
    sat: { label: 'Pool en uso', color: '#facc15', unit: '%', val: w => w.sat * 100 },
    rps: { label: 'Pedidos/s', color: '#38bdf8', unit: '/s', val: w => w.rps }
  };
  const UNIT_TICK = { s: v => `${v}s`, '%': v => `${v}%`, '/s': v => `${v}/s` };

  function svcChart(canvas, sim, opts) {
    opts = opts || {};
    const svc = opts.service || canvas.dataset.service || 'checkout';
    const fields = (opts.fields || (canvas.dataset.fields ? canvas.dataset.fields.split(',') : ['p95', 'errPct']))
      .filter(f => SERIES[f]);
    const N = 60;
    const blank = () => Array(N).fill(null);
    const units = [...new Set(fields.map(f => SERIES[f].unit))].slice(0, 2);
    const axisOf = f => `y${Math.max(0, units.indexOf(SERIES[f].unit))}`;
    const scales = { x: { display: false } };
    units.forEach((u, i) => {
      const color = SERIES[fields.find(f => SERIES[f].unit === u)].color;
      scales[`y${i}`] = Object.assign({
        position: i ? 'right' : 'left', min: 0,
        ticks: { color, font: { size: 11 }, callback: UNIT_TICK[u] },
        grid: i ? { display: false } : { color: 'rgba(148,163,184,.12)' }
      }, u === '%' ? { max: 100 } : { suggestedMax: u === 's' ? 1 : 10 });
    });
    const ch = new Chart(canvas, {
      type: 'line',
      data: {
        labels: Array(N).fill(''),
        datasets: fields.map(f => ({
          label: SERIES[f].label, data: blank(), yAxisID: axisOf(f),
          borderColor: SERIES[f].color, backgroundColor: SERIES[f].color + '1f',
          fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true
        }))
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 10, boxHeight: 10, font: { size: 12 } } } },
        scales
      }
    });
    // ch.times[i] = instante de simulación del punto i (para saber qué momento se clickeó)
    ch.times = blank();
    throttle(sim, 0.5, isReset => {
      if (isReset) { ch.data.datasets.forEach(d => { d.data = blank(); }); ch.times = blank(); ch.update('none'); return; }
      const w = sim.window(3, svc);
      ch.data.datasets.forEach((d, i) => { d.data.push(SERIES[fields[i]].val(w)); d.data.shift(); });
      ch.times.push(sim.now); ch.times.shift();
      ch.update('none');
    });
    return ch;
  }

  // Líneas de log en vivo (últimas 40). Filtro por nivel, búsqueda por pedido y data-format="text" | "json".
  const LOG_LINES = 40;
  const pad2 = n => String(n).padStart(2, '0');
  const clock = t => {
    const d = Math.floor(t * 10) / 10, s = Math.floor(d) % 60;
    return `${pad2(Math.floor(d / 3600))}:${pad2(Math.floor(d / 60) % 60)}:${pad2(s)}.${Math.round((d - Math.floor(d)) * 10)}`;
  };

  // Una línea de log en HTML, en texto o JSON (data-trace lleva el traceId). La usan logStream y las escenas.
  function logLine(l, format) {
    const lv = l.level, tr = `data-trace="${esc(l.traceId)}"`;
    if (format === 'json') {
      return `<div class="log-line lv-${lv}" ${tr}>${esc(JSON.stringify({ t: +l.t.toFixed(1), level: lv, service: l.service, replica: l.replica, msg: l.msg, orderId: l.orderId, traceId: l.traceId }))}</div>`;
    }
    return `<div class="log-line lv-${lv}" ${tr}><span class="l-t">${clock(l.t)}</span> <span class="l-lv">${lv.toUpperCase().padEnd(5)}</span> ` +
      `<span class="l-svc">${esc(l.service)}#${l.replica}</span> <span class="l-msg">${esc(l.msg)}</span> ` +
      `<span class="l-ord">order=#${l.orderId}</span> <span class="l-trace">trace=${esc(l.traceId)}</span></div>`;
  }

  function logStream(el, sim) {
    el.innerHTML =
      '<div class="log-bar">' +
      ['all:Todos', 'info:info', 'warn:warn', 'error:error']
        .map(x => { const [v, l] = x.split(':'); return `<button type="button" class="log-btn lv-${v}${v === 'all' ? ' active' : ''}" data-level="${v}">${l}</button>`; }).join('') +
      '<input class="log-search" type="search" placeholder="Pedido (ej. 1001)" aria-label="Buscar por pedido" inputmode="numeric">' +
      '</div><div class="log-lines" role="log"></div>';
    const box = el.querySelector('.log-lines');
    const input = el.querySelector('.log-search');
    const btns = [...el.querySelectorAll('[data-level]')];
    let level = 'all', dirty = true;

    const line = l => logLine(l, el.dataset.format || 'text');
    const render = () => {
      dirty = false;
      const q = input.value.replace('#', '').trim();
      const rows = [];
      for (let i = sim.logs.length - 1; i >= 0 && rows.length < LOG_LINES; i--) {
        const l = sim.logs[i];
        if (level !== 'all' && l.level !== level) continue;
        if (q && String(l.orderId) !== q) continue; // el pedido exacto: «1001» no trae el #10012
        rows.push(l);
      }
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      box.innerHTML = rows.reverse().map(line).join('') || '<div class="log-empty">Sin líneas que coincidan.</div>';
      if (atEnd) box.scrollTop = box.scrollHeight;
    };

    btns.forEach(b => b.addEventListener('click', () => {
      level = b.dataset.level;
      btns.forEach(x => x.classList.toggle('active', x === b));
      b.blur();
      render();
    }));
    input.addEventListener('input', render);
    new MutationObserver(render).observe(el, { attributes: true, attributeFilter: ['data-format'] });
    sim.on('log', () => { dirty = true; });
    let last = -Infinity;
    sim.on('reset', () => { last = -Infinity; dirty = true; render(); });
    sim.on('tick', now => { if (dirty && now - last >= 0.2) { last = now; render(); } });
    render();
    return { render };
  }

  // Cascada de una traza: una barra por span, el span más largo (sin contar el de Órdenes, que envuelve a todos) resaltado.
  // Sin fijar sigue la última traza. select(traceId | traza) fija una: se guarda el objeto, así que sigue aunque el ring
  // de 50 la descarte; un id que ya no está (o null) vuelve a seguir la última, y un reset la suelta.
  function traceView(el, sim, traceId) {
    let pinned = null, shown = null, dirty = true;
    const find = id => sim.traces.find(t => t.traceId === id) || null;
    const pin = x => { pinned = x && typeof x === 'object' ? x : (x ? find(x) : null); };
    pin(traceId);
    const render = () => {
      dirty = false;
      const tr = pinned || sim.traces[sim.traces.length - 1];
      shown = tr ? tr.traceId : null;
      if (!tr) { el.innerHTML = '<div class="tr-empty">Todavía no hay trazas.</div>'; return; }
      const t0 = Math.min(...tr.spans.map(s => s.start));
      const total = Math.max(...tr.spans.map(s => s.end)) - t0 || 1e-6;
      const kids = tr.spans.filter(s => s.service !== 'ordenes');
      const pool = kids.length ? kids : tr.spans;
      const longest = pool.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
      el.innerHTML =
        `<div class="tr-head"><b>Pedido #${tr.orderId}</b><span class="tr-dur">${fmtMs(total)}</span>` +
        `<span class="tr-id">trace=${esc(tr.traceId)}</span><span class="tr-st ${tr.ok ? 'ok' : 'err'}">${tr.ok ? 'OK' : 'error'}</span></div>` +
        tr.spans.map(s => {
          const left = (s.start - t0) / total * 100, w = Math.max((s.end - s.start) / total * 100, 1.5);
          const top = s === longest;
          return `<div class="t-row${top ? ' longest' : ''}" data-service="${s.service}">` +
            `<span class="t-name">${SVC_NAME[s.service] || esc(s.service)}</span>` +
            `<span class="t-track"><i class="t-bar${s.ok ? '' : ' fail'}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%;background:${SVC_COLOR[s.service] || '#fb923c'}"></i></span>` +
            `<span class="t-ms">${fmtMs(s.end - s.start)}</span>` +
            `</div>`;
        }).join('') +
        `<div class="tr-note">El span más lento: <b>${SVC_NAME[longest.service] || esc(longest.service)}</b> · ${fmtMs(longest.end - longest.start)}</div>`;
    };
    sim.on('trace', () => { if (!pinned) dirty = true; });
    sim.on('tick', () => { if (dirty) render(); });
    sim.on('reset', () => { pinned = null; render(); });
    render();
    return {
      render,
      select(x) { pin(x); render(); },
      get current() { return shown; },
      get pinned() { return pinned; }
    };
  }

  window.Widgets = { fmtLat, svcStats, svcChart, logStream, logLine, traceView };

})();
