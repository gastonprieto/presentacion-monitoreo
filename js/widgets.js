/* Widgets HTML que leen una Sim: contadores, gráfico en vivo y barra de disponibilidad. */
(function () {
  'use strict';

  const fmtLat = v => (v == null ? '—' : v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(1)} s`);

  const LABELS = {
    sent: 'Enviadas', ok: 'OK', slow: 'Lentas', err: 'Errores',
    p50: 'Latencia p50', p95: 'Latencia p95', p99: 'Latencia p99',
    errPct: '% error (5 s)', rps: 'Respuestas/s'
  };

  // Ejecuta fn cada `every` segundos de tiempo de simulación
  function throttle(sim, every, fn) {
    let last = -Infinity;
    sim.on('tick', now => { if (now - last >= every) { last = now; fn(); } });
    sim.on('reset', () => { last = -Infinity; fn(true); });
  }

  function stats(el, sim, fields, win = 5) {
    fields = fields || ['sent', 'ok', 'slow', 'err', 'p95', 'errPct'];
    el.innerHTML = fields
      .map(f => `<div class="stat s-${f}"><b data-f="${f}">0</b><span>${LABELS[f]}</span></div>`)
      .join('');
    const cells = {};
    fields.forEach(f => { cells[f] = el.querySelector(`[data-f="${f}"]`); });
    const update = () => {
      const w = sim.window(win);
      const v = Object.assign({}, sim.stats, {
        p50: fmtLat(w.p50), p95: fmtLat(w.p95), p99: fmtLat(w.p99), errPct: `${w.errPct.toFixed(0)}%`, rps: w.rps.toFixed(1)
      });
      fields.forEach(f => { cells[f].textContent = v[f]; });
    };
    throttle(sim, 0.25, update);
    update();
  }

  function chart(canvas, sim) {
    const N = 60;
    const blank = () => Array(N).fill(null);
    const ch = new Chart(canvas, {
      type: 'line',
      data: {
        labels: Array(N).fill(''),
        datasets: [
          {
            label: 'Latencia p95 (s)', data: blank(), yAxisID: 'y',
            borderColor: '#facc15', backgroundColor: 'rgba(250,204,21,.12)',
            fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true
          },
          {
            label: '% errores', data: blank(), yAxisID: 'y1',
            borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,.12)',
            fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2, spanGaps: true
          }
        ]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 10, boxHeight: 10, font: { size: 12 } } } },
        scales: {
          x: { display: false },
          y: {
            position: 'left', min: 0, suggestedMax: 3,
            ticks: { color: '#facc15', font: { size: 11 }, callback: v => `${v}s` },
            grid: { color: 'rgba(148,163,184,.12)' }
          },
          y1: {
            position: 'right', min: 0, max: 100,
            ticks: { color: '#f87171', font: { size: 11 }, callback: v => `${v}%` },
            grid: { display: false }
          }
        }
      }
    });
    const [lat, err] = ch.data.datasets;
    throttle(sim, 0.5, isReset => {
      if (isReset) { lat.data = blank(); err.data = blank(); ch.update('none'); return; }
      const w = sim.window(3);
      lat.data.push(w.p95); lat.data.shift();
      err.data.push(w.n ? w.errPct : null); err.data.shift();
      ch.update('none');
    });
    return ch;
  }

  // Histograma de latencias (requests exitosas de los últimos `win` s) con marcas de p50 / p95 / p99
  function histogram(canvas, sim, win = 30) {
    const BIN = 0.2, MAX = 5;
    const nb = Math.round(MAX / BIN);
    const centers = Array.from({ length: nb }, (_, i) => +(i * BIN + BIN / 2).toFixed(3));
    const marks = [['p50', '#4ade80'], ['p95', '#facc15'], ['p99', '#f87171']];
    let pct = {};

    const markers = {
      id: 'pmarks',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea: a, scales: { x } } = chart;
        ctx.save();
        ctx.font = '700 12px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        marks.forEach(([k, color], i) => {
          const v = pct[k];
          if (v == null) return;
          const px = x.getPixelForValue(Math.min(v, MAX));
          ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(px, a.top + 14 + i * 14); ctx.lineTo(px, a.bottom); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillText(k, px, a.top + 10 + i * 14);
        });
        ctx.restore();
      }
    };

    const ch = new Chart(canvas, {
      type: 'bar',
      data: {
        datasets: [{
          data: centers.map(c => ({ x: c, y: 0 })),
          backgroundColor: 'rgba(56,189,248,.65)', borderRadius: 2,
          barPercentage: 1, categoryPercentage: 1
        }]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: {
            type: 'linear', min: 0, max: MAX, offset: false,
            ticks: { color: '#94a3b8', stepSize: 1, callback: v => `${v}s` },
            grid: { color: 'rgba(148,163,184,.08)' },
            title: { display: true, text: 'latencia', color: '#64748b', font: { size: 11 } }
          },
          y: {
            beginAtZero: true, ticks: { color: '#64748b', precision: 0 },
            grid: { color: 'rgba(148,163,184,.12)' },
            title: { display: true, text: 'requests', color: '#64748b', font: { size: 11 } }
          }
        }
      },
      plugins: [markers]
    });

    throttle(sim, 0.5, isReset => {
      const counts = Array(nb).fill(0);
      if (!isReset) {
        const from = sim.now - win;
        for (let i = sim.log.length - 1; i >= 0; i--) {
          const e = sim.log[i];
          if (e.t < from) break;
          if (e.status !== 'err') counts[Math.min(nb - 1, Math.floor(e.lat / BIN))]++;
        }
      }
      const w = sim.window(win);
      pct = isReset ? {} : { p50: w.p50, p95: w.p95, p99: w.p99 };
      ch.data.datasets[0].data = centers.map((c, i) => ({ x: c, y: counts[i] }));
      ch.update('none');
    });
    return ch;
  }

  function strip(el, sim) {
    const N = 80;
    throttle(sim, 0.5, isReset => {
      if (isReset) { el.innerHTML = ''; return; }
      const w = sim.window(0.5);
      const i = document.createElement('i');
      i.className = w.n === 0 ? 'idle' : w.err === 0 ? 'up' : w.err === w.n ? 'down' : 'partial';
      el.appendChild(i);
      while (el.children.length > N) el.firstChild.remove();
    });
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
    throttle(sim, 0.5, isReset => {
      if (isReset) { ch.data.datasets.forEach(d => { d.data = blank(); }); ch.update('none'); return; }
      const w = sim.window(3, svc);
      ch.data.datasets.forEach((d, i) => { d.data.push(SERIES[fields[i]].val(w)); d.data.shift(); });
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

    const line = l => {
      const lv = l.level;
      if ((el.dataset.format || 'text') === 'json') {
        return `<div class="log-line lv-${lv}">${esc(JSON.stringify({ t: +l.t.toFixed(1), level: lv, service: l.service, replica: l.replica, msg: l.msg, orderId: l.orderId, traceId: l.traceId }))}</div>`;
      }
      return `<div class="log-line lv-${lv}"><span class="l-t">${clock(l.t)}</span> <span class="l-lv">${lv.toUpperCase().padEnd(5)}</span> ` +
        `<span class="l-svc">${esc(l.service)}#${l.replica}</span> <span class="l-msg">${esc(l.msg)}</span> ` +
        `<span class="l-ord">order=#${l.orderId}</span> <span class="l-trace">trace=${esc(l.traceId)}</span></div>`;
    };
    const render = () => {
      dirty = false;
      const q = input.value.replace('#', '').trim();
      const rows = [];
      for (let i = sim.logs.length - 1; i >= 0 && rows.length < LOG_LINES; i--) {
        const l = sim.logs[i];
        if (level !== 'all' && l.level !== level) continue;
        if (q && !String(l.orderId).includes(q)) continue;
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
  function traceView(el, sim, traceId) {
    let pinned = traceId || null, shown = null, dirty = true;
    const find = id => sim.traces.find(t => t.traceId === id) || null;
    const render = () => {
      dirty = false;
      const tr = pinned ? find(pinned) : sim.traces[sim.traces.length - 1];
      shown = tr ? tr.traceId : null;
      if (!tr) { el.innerHTML = '<div class="tr-empty">Todavía no hay trazas.</div>'; return; }
      const t0 = Math.min(...tr.spans.map(s => s.start));
      const total = Math.max(...tr.spans.map(s => s.end)) - t0 || 1e-6;
      const kids = tr.spans.slice(1);
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
    sim.on('reset', () => { pinned = traceId ? pinned : null; render(); });
    render();
    return {
      render,
      select(id) { pinned = id || null; render(); },
      get current() { return shown; }
    };
  }

  window.Widgets = { stats, chart, histogram, strip, fmtLat, svcStats, svcChart, logStream, traceView };

})();
