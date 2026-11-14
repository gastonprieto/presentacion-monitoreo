// Pruebas de interacción con Chrome headless: escenas del deck de monitoreo.
// Uso: node tests/interact.js [filtro]   (filtro = parte del nombre de la prueba)
// Requiere `npm i` en presentaciones-guideline/tools (usa su puppeteer-core).
const path = require('path');
const puppeteer = require(path.resolve(__dirname, '../../presentaciones-guideline/tools/node_modules/puppeteer-core'));

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const filter = process.argv[2] || '';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- helpers ---------- */

async function open(page, idx = 0, mobile = false) {
  await page.goto(`file://${ROOT}/index.html?mobile=${mobile ? 1 : 0}#/${idx}`);
  await sleep(600);
}

// Va a la slide idx y espera a que su escena exista (section._scene)
async function goto(page, idx) {
  await page.evaluate(i => Reveal.slide(i, 0, 99), idx);
  await page.waitForFunction(i => window.__sec(i)._scene, { timeout: 4000 }, idx);
}

// Ejecuta fn(section, ...args) en la página sobre la slide idx
async function evalScene(page, idx, fn, ...args) {
  await goto(page, idx);
  return page.evaluate(`(${fn})(window.__sec(${idx}), ...${JSON.stringify(args)})`);
}

// Ejecuta fn(svg, ...args) con un <svg> nuevo en la página (para probar motores sin slide)
async function engine(page, fn, ...args) {
  return page.evaluate(`(() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('style', 'position:fixed;left:0;top:0;width:900px;height:590px;opacity:0;pointer-events:none');
    document.body.appendChild(svg);
    try { return (${fn})(svg, ...${JSON.stringify(args)}); } finally { svg.remove(); }
  })()`);
}

function check(cond, msg) { if (!cond) throw new Error(msg); }

/* ---------- pruebas ---------- */

test('base: carga sin errores de consola', async (page, errors) => {
  await open(page, 0);
  check(errors.length === 0, `errores: ${errors.join(' | ')}`);
});

test('notas: todas las slides tienen pregunta', async page => {
  await open(page, 0);
  const r = await page.evaluate(() => [...document.querySelectorAll('.reveal .slides > section')]
    .map((s, i) => { const n = s.querySelector('aside.notes'); return n && n.textContent.includes('?') ? null : i; }));
  check(!r.filter(x => x !== null).length, `sin pregunta: ${r.filter(x => x !== null)}`);
});

test('outro: link al repo y preset', async page => {
  await open(page, 0);
  const r = await page.evaluate(() => {
    const o = document.querySelector('section.outro');
    const a = o.querySelector('a.repo-link');
    return { href: a && a.href, text: o.textContent, links: [...o.querySelectorAll('a')].map(x => x.href) };
  });
  check(r.href === 'https://github.com/gastonprieto/presentacion-monitoreo', `repo-link: ${r.href}`);
  check(r.text.includes('load-balancer'), 'el outro no menciona el preset load-balancer');
  check(r.links.some(h => h.includes('architecture-playground')), 'el outro no linkea al playground');
});

/* ---------- ObsKit: métricas y alertas ---------- */

test('obs: percentiles', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const a = Array.from({ length: 100 }, (_, i) => i + 1);
    const { percentile } = window.ObsKit;
    return [percentile(a, 50), percentile(a, 95), percentile(a, 99), percentile([], 95)];
  });
  check(r[0] === 50 && r[1] === 95 && r[2] === 99, `percentiles: ${r}`);
  check(r[3] === 0, `vacío: ${r[3]}`);
});

test('obs: ventana descarta lo viejo', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const w = new window.ObsKit.MetricWindow({ span: 5 });
    w.add(1, { latency: 10, ok: true });
    w.add(8, { latency: 1, ok: true });
    return w.stats(9);
  });
  check(r.n === 1 && r.avg === 1, `stats: ${JSON.stringify(r)}`);
});

test('obs: el promedio esconde la cola', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const w = new window.ObsKit.MetricWindow({ span: 2000 });
    for (let i = 0; i < 1000; i++) w.add(i * 0.001, { latency: i % 20 === 0 ? 2 : 0.1, ok: true });
    return w.stats(1);
  });
  check(r.avg < 0.25, `avg ${r.avg}`);
  check(r.p99 >= 2, `p99 ${r.p99}`);
});

test('obs: alerta con ventana', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const a = new window.ObsKit.AlertRule({ threshold: 5, forSec: 3 });
    return a.evaluate([0, 9, 0, 9, 9, 9, 9, 0].map((v, t) => [t, v]));
  });
  check(r.firings.length === 1 && r.firings[0][0] === 6, `firings: ${JSON.stringify(r.firings)}`);
});

test('obs: clasificar alertas', async page => {
  await open(page, 0);
  const r = await engine(page, () => window.ObsKit.classifyAlerts([[2, 3], [10, 12]], [[10, 15], [20, 25]]));
  check(r.caught === 1 && r.missed === 1 && r.falsePos === 1, JSON.stringify(r));
});

test('obs: presupuesto de error', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const b = new window.ObsKit.ErrorBudget({ slo: 0.99, windowSec: 100 });
    for (let i = 0; i < 1000; i++) b.add(i * 0.01, i % 50 !== 0);
    return b.state(10);
  });
  check(r.total === 1000 && r.bad === 20, JSON.stringify(r));
  check(Math.abs(r.allowed - 10) < 1e-6 && Math.abs(r.burnRate - 2) < 1e-6, JSON.stringify(r));
  check(r.remainingPct <= 0 && r.remainingPct >= -100, `remaining ${r.remainingPct}`);
});

test('obs: presupuesto con objetivo 100% no divide por cero', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const b = new window.ObsKit.ErrorBudget({ slo: 1, windowSec: 100 });
    b.add(1, true);
    const sano = b.state(2);
    b.add(1.5, false);
    const roto = b.state(2);
    return { sano, roto, fin: [sano.burnRate, roto.burnRate].every(Number.isFinite) };
  });
  check(r.fin, `burnRate no finito: ${JSON.stringify(r)}`);
  check(r.sano.burnRate === 0 && r.sano.remainingPct === 100, JSON.stringify(r.sano));
  check(r.roto.burnRate > 0 && r.roto.remainingPct === -100, JSON.stringify(r.roto));
});

/* ---------- ObsKit: reacciones automáticas ---------- */

test('obs: crash loop con backoff', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const s = new window.ObsKit.Supervisor({ policy: 'on-failure' });
    const d = [0, 1, 2, 3, 4, 5].map(t => s.onExit(t, true));
    const n = new window.ObsKit.Supervisor({ policy: 'no' });
    return { d, no: n.onExit(0, true), restarts: s.restarts, state: s.state };
  });
  check(JSON.stringify(r.d) === '[1,2,4,8,16,16]', `delays: ${r.d}`);
  check(r.no === null, `policy no: ${r.no}`);
  check(r.restarts === 6 && r.state === 'backoff', `${r.restarts} ${r.state}`);
});

test('obs: backoff se resetea si estuvo sano', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const s = new window.ObsKit.Supervisor({ policy: 'always' });
    s.onExit(0, true); s.onExit(1, true);
    s.onHealthy(5);
    return s.onExit(16, true);
  });
  check(r === 1, `delay ${r}`);
});

test('obs: autoscaler respeta cooldown y límites', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const a = new window.ObsKit.Autoscaler({ target: 0.7 });
    const out = [a.step(0, 1.4, 1), a.step(3, 1.4, 2), a.step(9, 1.4, 2)];
    const b = new window.ObsKit.Autoscaler({ target: 0.7 });
    out.push(b.step(0, 1e6, 3));
    const c = new window.ObsKit.Autoscaler({ target: 0.7 });
    out.push(c.step(0, 0, 3));
    return out;
  });
  check(JSON.stringify(r) === '[2,2,4,6,1]', `pasos: ${r}`);
});

test('obs: breaker abre, prueba y cierra', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const b = new window.ObsKit.CircuitBreaker({});
    for (let i = 0; i < 5; i++) { b.allow(i); b.record(i, false); }
    const o = { open: b.state, allowOpen: b.allow(5) };
    o.first = b.allow(9);
    o.half = b.state;
    o.second = b.allow(9);
    b.record(9, true);
    o.closed = b.state;
    return o;
  });
  check(r.open === 'open' && r.allowOpen === false, JSON.stringify(r));
  check(r.half === 'half' && r.first === true && r.second === false, JSON.stringify(r));
  check(r.closed === 'closed', JSON.stringify(r));
});

test('obs: breaker tick pasa a half sin esperar a allow', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const b = new window.ObsKit.CircuitBreaker({ failures: 2, openFor: 5 });
    b.record(0, false); b.record(1, false);
    const o = { open: b.state };
    b.tick(4); o.still = b.state;
    b.tick(6); o.half = b.state;
    return o;
  });
  check(r.open === 'open' && r.still === 'open' && r.half === 'half', JSON.stringify(r));
});

test('obs: breaker half → open si la prueba falla', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const b = new window.ObsKit.CircuitBreaker({ failures: 1, openFor: 5 });
    b.record(0, false);
    const o = { probe: b.allow(5) };
    b.record(6, false);
    o.state = b.state; o.after = b.allow(7); o.again = b.allow(11);
    return o;
  });
  check(r.probe === true && r.state === 'open' && r.after === false && r.again === true, JSON.stringify(r));
});

test('obs: breaker re-arma la prueba que nunca volvió', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const b = new window.ObsKit.CircuitBreaker({ failures: 1, openFor: 5 });
    b.record(0, false);
    const o = { probe: b.allow(5), mid: b.allow(8), rearm: b.allow(10.5), state: b.state };
    return o;
  });
  check(r.probe && !r.mid && r.rearm && r.state === 'half', JSON.stringify(r));
});

test('obs: supervisor always reinicia aunque salga bien', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const a = new window.ObsKit.Supervisor({ policy: 'always' });
    const f = new window.ObsKit.Supervisor({ policy: 'on-failure' });
    return { a: a.onExit(0, false), f: f.onExit(0, false), fs: f.state };
  });
  check(r.a === 1 && r.f === null && r.fs === 'stopped', JSON.stringify(r));
});

test('obs: autoscaler baja sólo si lo pidió todo el downWindow', async page => {
  await open(page, 0);
  const r = await engine(page, () => {
    const a = new window.ObsKit.Autoscaler({ target: 0.7, cooldown: 0, downWindow: 10 });
    return [a.step(0, 1.4, 1), a.step(1, 0.3, 2), a.step(5, 0.3, 2), a.step(11.5, 0.3, 2), a.step(12, 1.4, 1)];
  });
  check(JSON.stringify(r) === '[2,2,2,1,2]', `pasos: ${r}`);
});

/* ---------- ShopSim: la tienda ---------- */

// Crea una ShopSim sobre el svg suelto (código que corre en la página)
const SHOP = `(svg, opts) => new ShopSimKit.ShopSim(svg, opts)`;

test('shop: sano', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOP})(svg);
    s.fastForward(30);
    return { c: s.window(10, 'checkout'), p: s.window(10, 'pagos') };
  }`);
  check(r.c.n > 30, `pocos checkouts: ${r.c.n}`);
  check(r.c.errPct < 1, `errPct ${r.c.errPct}`);
  check(r.p.sat < 0.8, `sat ${r.p.sat}`);
});

test('shop: slowdb satura el pool', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOP})(svg);
    s.fastForward(30);
    const sano = s.window(10, 'checkout');
    s.breakPagos('slowdb');
    s.fastForward(30);
    return { sano, c: s.window(10, 'checkout'), p: s.window(10, 'pagos') };
  }`);
  check(r.p.sat >= 0.95, `sat ${r.p.sat}`);
  check(r.c.errPct > 5, `errPct ${r.c.errPct}`);
  check(r.c.p95 > 3 * r.sano.p95, `p95 ${r.c.p95} vs sano ${r.sano.p95}`);
});

test('shop: primero la latencia, después los errores', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOP})(svg);
    s.fastForward(30);
    const sano = s.window(10, 'checkout').p95;
    s.breakPagos('slowdb');
    let lat = null, err = null;
    for (let i = 1; i <= 30; i++) {
      s.fastForward(1);
      const w = s.window(5, 'checkout');
      if (lat === null && w.p95 > 2 * sano) lat = i;
      if (err === null && w.errPct > 1) err = i;
    }
    return { sano, lat, err };
  }`);
  check(r.lat !== null && r.err !== null, JSON.stringify(r));
  check(r.lat < r.err, `latencia en ${r.lat} s, errores en ${r.err} s`);
});

test('shop: logs del incidente', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOP})(svg);
    s.fastForward(10);
    s.breakPagos('slowdb');
    s.fastForward(30);
    const e = s.logs.find(l => l.level === 'error' && l.service === 'pagos' && l.msg.includes('timeout acquiring db connection'));
    return { e, n: s.logs.length, sinTrace: s.logs.filter(l => !l.traceId || !l.orderId).length,
      warn: s.logs.some(l => l.level === 'warn'), info: s.logs.some(l => l.level === 'info') };
  }`);
  check(r.e, 'no hay log de timeout en pagos');
  check(r.e.orderId && /^[0-9a-f]{8}$/.test(r.e.traceId), JSON.stringify(r.e));
  check(r.n > 0 && r.n <= 300, `logs ${r.n}`);
  check(r.sinTrace === 0, `${r.sinTrace} logs sin traceId u orderId`);
  check(r.warn && r.info, JSON.stringify(r));
});

test('shop: la traza muestra dónde', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOP})(svg);
    s.fastForward(10);
    s.breakPagos('slowdb');
    s.fastForward(20);
    const ok = s.traces.filter(t => t.spans.every(x => x.ok));
    return { n: s.traces.length, t: ok[ok.length - 1] };
  }`);
  check(r.n <= 50, `trazas ${r.n}`);
  check(r.t, 'no hay trazas OK');
  const by = Object.fromEntries(r.t.spans.map(x => [x.service, x]));
  check(by.ordenes && by.pagos && by.envios, JSON.stringify(r.t.spans));
  const total = Math.max(...r.t.spans.map(x => x.end)) - Math.min(...r.t.spans.map(x => x.start));
  const pagos = by.pagos.end - by.pagos.start;
  check(pagos > 0.7 * total, `pagos ${pagos} de ${total}`);
});

test('shop: arreglar vuelve a sano', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOP})(svg);
    s.fastForward(10);
    s.breakPagos('slowdb'); s.breakPagos('slowdb'); s.breakPagos('slowdb');
    s.fastForward(20);
    const roto = s.window(10).errPct;
    s.heal(); s.heal();
    s.fastForward(40);
    return { roto, w: s.window(10), fault: s.fault };
  }`);
  check(r.roto > 5, `roto ${r.roto}`);
  check(r.w.errPct < 1, `errPct ${r.w.errPct}`);
  check(r.fault === null, `fault ${r.fault}`);
});

test('shop: la velocidad no cambia los números', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const { Speed } = NetKit, sp = Speed.value;
    try {
      Speed.value = 0.25;
      const a = (${SHOP})(svg); a.fastForward(30);
      Speed.value = 1.5;
      const b = (${SHOP})(svg); b.fastForward(30);
      // y en "tiempo real", con ticks de 50 ms a 1,5× y dibujando
      const c = (${SHOP})(svg);
      while (c.now < 30 - 1e-6) c.clock._tick(0, 50);
      return { a: a.window(10, 'checkout'), b: b.window(10, 'checkout'), c: c.window(10, 'checkout'), cNow: c.now };
    } finally { Speed.value = sp; }
  }`);
  check(r.a.n > 0 && JSON.stringify(r.a) === JSON.stringify(r.b), `${JSON.stringify(r.a)} vs ${JSON.stringify(r.b)}`);
  check(JSON.stringify(r.a) === JSON.stringify(r.c), `tiempo real (${r.cNow}): ${JSON.stringify(r.c)}`);
});

test('shop: intervención programada es determinista', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const { Speed } = NetKit, sp = Speed.value;
    const script = s => {
      s.after(10, () => s.breakPagos('slowdb'));
      s.after(25, () => s.heal());
      let n = 0; s.every(1, () => n++);
      return () => n;
    };
    try {
      Speed.value = 0.25;
      const a = (${SHOP})(svg); const na = script(a); a.fastForward(30);
      Speed.value = 1.5;
      const c = (${SHOP})(svg); const nc = script(c);
      while (c.now < 30 - 1e-6) c.clock._tick(0, 100);
      const d = (${SHOP})(svg); script(d); d.fastForward(5); d.reset(); d.fastForward(30);
      // un timer del Clock (no recomendado) igual ve la simulación al día en su instante
      const e = (${SHOP})(svg); let seen = null;
      e.clock.after(0.37, () => { seen = e.now; });
      e.clock._tick(0, 100); e.clock._tick(0, 100); e.clock._tick(0, 100); e.clock._tick(0, 100);
      return { seen, a: a.window(10, 'pagos'), c: c.window(10, 'pagos'), na: na(), nc: nc(), dFault: d.fault, dN: d.window(30, 'pagos').errPct };
    } finally { Speed.value = sp; }
  }`);
  check(r.a.errPct > 0, `la falla no se notó: ${JSON.stringify(r.a)}`);
  check(JSON.stringify(r.a) === JSON.stringify(r.c), `${JSON.stringify(r.a)} vs ${JSON.stringify(r.c)}`);
  check(r.na === r.nc && r.na >= 29 && r.na <= 30, `every: ${r.na} / ${r.nc}`);
  check(Math.abs(r.seen - 0.37) < 1e-9, `timer del Clock vio now=${r.seen}`);
  check(r.dFault === null && r.dN === 0, `reset no limpió los timers: ${r.dFault} ${r.dN}`);
});

test('shop: wait resuelve y reset la corta', async page => {
  await open(page, 0);
  const r = await page.evaluate(async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg);
    const s = new ShopSimKit.ShopSim(svg);
    let a = false, b = false;
    s.wait(2).then(() => { a = true; });
    s.fastForward(3);
    await Promise.resolve();
    s.wait(2).then(() => { b = true; });
    s.reset();
    s.fastForward(3);
    await Promise.resolve();
    svg.remove();
    return { a, b };
  });
  check(r.a && !r.b, JSON.stringify(r));
});

test('shop: reset limpia todo', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOP})(svg);
    s.breakPagos('slowdb');
    s.fastForward(15);
    const before = { logs: s.logs.length, traces: s.traces.length, gen: s.gen };
    s.reset();
    return { before, logs: s.logs.length, traces: s.traces.length, fault: s.fault, gen: s.gen, now: s.now, n: s.window(10).n };
  }`);
  check(r.before.logs > 0 && r.before.traces > 0, JSON.stringify(r.before));
  check(r.logs === 0 && r.traces === 0 && r.fault === null, JSON.stringify(r));
  check(r.gen === r.before.gen + 1 && r.n === 0, JSON.stringify(r));
});

test('shop: dibuja el pool en escritorio y celular', async page => {
  const run = `(svg) => {
    const s = (${SHOP})(svg, { showPool: true, replicas: 2 });
    s.fastForward(5);
    return { vb: svg.getAttribute('viewBox'), slots: svg.querySelectorAll('.slot').length,
      on: svg.querySelectorAll('.slot.on').length, nodes: svg.querySelectorAll('.node-box').length, pool: s.o.pool };
  }`;
  await open(page, 0);
  const d = await engine(page, run);
  await open(page, 0, true);
  const m = await engine(page, run);
  check(d.vb === '0 0 900 590' && m.vb === '0 0 400 440', `${d.vb} / ${m.vb}`);
  check(d.slots === 2 * d.pool && m.slots === 2 * d.pool, `casilleros ${d.slots} / ${m.slots} (pool ${d.pool})`);
  check(d.nodes === 6, `nodos ${d.nodes}`);
});

/* ---------- ShopSim: reacciones automáticas ---------- */

// Crea la tienda y junta sus eventos 'react'
const SHOPR = `(svg, opts) => { const s = new ShopSimKit.ShopSim(svg, opts); s.ev = []; s.on('react', e => s.ev.push(e)); return s; }`;

test('react: liveness reinicia lo colgado', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const run = live => {
      const s = (${SHOPR})(svg, { liveness: live, restartPolicy: 'always' });
      s.fastForward(10);
      s.breakPagos('hang');
      const t0 = s.now;
      s.fastForward(15);
      const re = s.ev.find(e => e.kind === 'restart');
      return { dt: re ? re.t - t0 : null, err: s.window(5).errPct, kinds: s.ev.map(e => e.kind), st: s.replicaState(0) };
    };
    return { on: run(true), off: run(false) };
  }`);
  check(r.on.dt !== null && r.on.dt < 1 * 2 + 2 + 1, `restart: ${JSON.stringify(r.on)}`);
  check(r.on.kinds.includes('remove'), `sin remove: ${r.on.kinds}`);
  check(r.on.err < 5 && r.on.st.up && r.on.st.restarts === 1, JSON.stringify(r.on));
  check(r.off.err > 50 && r.off.dt === null, JSON.stringify(r.off));
});

test('react: readiness no manda tráfico al que arranca', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const run = ready => {
      const s = (${SHOPR})(svg, { replicas: 2, readiness: ready, warmup: 5 });
      s.fastForward(10);
      s.restartReplica(1);
      const got = s.replicaState(1).received;
      s.fastForward(5);
      const mid = { got: s.replicaState(1).received - got, err: s.window(5).errPct, ready: s.replicaState(1).ready };
      s.fastForward(10);
      return { mid, end: s.replicaState(1), err: s.window(6).errPct };
    };
    return { on: run(true), off: run(false) };
  }`);
  check(r.on.mid.got === 0 && r.on.mid.err === 0 && !r.on.mid.ready, JSON.stringify(r.on));
  check(r.on.end.ready && r.on.end.up && r.on.err === 0, JSON.stringify(r.on));
  check(r.off.mid.got > 0 && r.off.mid.err > 0, `sin readiness: ${JSON.stringify(r.off)}`);
});

test('react: crash loop', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOPR})(svg, { restartPolicy: 'on-failure' });
    s.fastForward(5);
    s.breakPagos('crash');
    const t0 = s.now;
    s.fastForward(30);
    const re = s.ev.filter(e => e.kind === 'restart');
    return { t0, rt: s.o.restartTime, times: re.map(e => e.t), delays: re.map(e => e.detail.delay), st: s.replicaState(0),
      pagos: s.window(10, 'pagos') };
  }`);
  const waits = r.times.map((t, i) => i ? t - r.times[i - 1] - r.rt : t - r.t0);
  [1, 2, 4, 8].forEach((d, i) => check(Math.abs(waits[i] - d) <= 0.1 && r.delays[i] === d, `esperas ${waits} · delays ${r.delays}`));
  check(r.st.restarts >= 4 && !r.st.up, JSON.stringify(r.st));
  check(r.pagos.errPct === 100 && r.pagos.n > 0, `pagos caído se ve sano: ${JSON.stringify(r.pagos)}`);
});

test('react: autoscaling con pico sano', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOPR})(svg, { autoscale: { target: 0.7, min: 1, max: 6, cooldown: 8, startup: 3 } });
    s.fastForward(5);
    s.set('rate', 20);
    s.fastForward(35);
    const ids = []; for (let i = 0; i < s.replicaCount; i++) ids.push(s.replicaState(i).id);
    return { n: s.replicaCount, w: s.window(10), ids, scales: s.ev.filter(e => e.kind === 'scale').map(e => [Math.round(e.t), e.detail.to]) };
  }`);
  check(r.n >= 3, `réplicas ${r.n} · ${JSON.stringify(r.scales)}`);
  check(r.w.errPct < 2, `errPct ${r.w.errPct}`);
  check(new Set(r.ids).size === r.ids.length, `ids repetidos ${r.ids}`);
});

test('react: escalar empeora el incidente del pool', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const run = n => {
      const s = (${SHOPR})(svg, { replicas: n, fault: 'slowdb' });
      s.fastForward(60);
      return { db: s.window(40, 'db').p95, err: s.window(40).errPct };
    };
    return { one: run(1), three: run(3) };
  }`);
  check(r.three.db > 2 * r.one.db, `p95 DB ${r.one.db} → ${r.three.db}`);
  check(r.three.err >= r.one.err - 2, `errPct ${r.one.err} → ${r.three.err}`);
});

test('react: breaker falla rápido', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const run = opts => {
      const s = (${SHOPR})(svg, opts);
      s.fastForward(5);
      s.breakPagos('hang');
      s.fastForward(40);
      return { p95: s.window(25, 'ordenes').p95, states: s.ev.filter(e => e.kind === 'breaker').map(e => e.detail.to) };
    };
    return { none: run({}), tmo: run({ timeout: 2 }), brk: run({ timeout: 2, breaker: { failures: 5, openFor: 5 } }) };
  }`);
  check(r.brk.p95 < r.tmo.p95 && r.tmo.p95 < r.none.p95, `p95 ${r.brk.p95} < ${r.tmo.p95} < ${r.none.p95}`);
  check(r.brk.states.includes('open') && r.brk.states.includes('half'), `estados ${r.brk.states}`);
});

test('react: reintentos multiplican la carga', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOPR})(svg, { fault: 'slowdb', retries: 2 });
    s.fastForward(50);
    return { p: s.window(30, 'pagos').rps, c: s.window(30).rps };
  }`);
  check(r.p >= 2 * r.c, `pagos ${r.p} rps vs checkout ${r.c} rps`);
});

test('react: reset corta backoff y enfriamiento', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    // crash loop en backoff
    const a = (${SHOPR})(svg, { restartPolicy: 'on-failure', replicas: 1 });
    a.fastForward(3); a.breakPagos('crash'); a.fastForward(9);
    const aBefore = a.ev.length;
    a.reset(); a.fastForward(30);
    // autoscaler a mitad de camino (réplica arrancando y enfriamiento en curso); antes del reset baja la carga
    const b = (${SHOPR})(svg, { autoscale: { target: 0.7, min: 1, max: 6, cooldown: 8, startup: 3 } });
    b.set('rate', 20); b.fastForward(12);
    const bBefore = b.ev.length, bN = b.replicaCount;
    b.set('rate', 3); b.reset(); b.fastForward(30);
    return { aBefore, aAfter: a.ev.length - aBefore, aN: a.replicaCount, aUp: a.replicaState(0).up,
      bBefore, bN, bAfter: b.ev.length - bBefore, bCount: b.replicaCount };
  }`);
  check(r.aBefore > 0 && r.aAfter === 0 && r.aN === 1 && r.aUp, JSON.stringify(r));
  check(r.bBefore > 0 && r.bN > 1 && r.bAfter === 0 && r.bCount === 1, JSON.stringify(r));
});

test('react: las reacciones no dependen de la velocidad', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const { Speed } = NetKit, sp = Speed.value;
    const opts = { liveness: true, readiness: true, warmup: 1, restartPolicy: 'always', timeout: 1.5, retries: 1,
      breaker: { failures: 4, openFor: 3 }, autoscale: { target: 0.7, min: 1, max: 4, cooldown: 5, startup: 2 } };
    const script = s => { s.after(3, () => s.set('rate', 18)); s.after(12, () => s.breakPagos('hang')); s.after(22, () => s.heal()); };
    const sig = s => JSON.stringify({ ev: s.ev.map(e => [e.t.toFixed(6), e.kind, e.detail]), c: s.window(30), o: s.window(30, 'ordenes'), n: s.replicaCount });
    try {
      Speed.value = 0.25;
      const a = (${SHOPR})(svg, opts); script(a); a.fastForward(35);
      Speed.value = 1.5;
      const b = (${SHOPR})(svg, opts); script(b);
      while (b.now < 35 - 1e-6) b.clock._tick(0, 50);
      return { a: sig(a), b: sig(b), kinds: [...new Set(a.ev.map(e => e.kind))] };
    } finally { Speed.value = sp; }
  }`);
  check(r.a === r.b, `fastForward ≠ tiempo real\n${r.a.slice(0, 300)}\n${r.b.slice(0, 300)}`);
  check(['scale', 'remove', 'restart', 'breaker'].every(k => r.kinds.includes(k)), `reacciones: ${r.kinds}`);
});

test('react: dibuja réplicas, estados y el robot', async page => {
  const run = `(svg) => {
    const s = new ShopSimKit.ShopSim(svg, { replicas: 6, showPool: true, readiness: true, liveness: true, restartPolicy: 'always', breaker: { failures: 3, openFor: 5 }, timeout: 2 });
    s.fastForward(5);
    s.restartReplica(2);
    s.breakPagos('hang');
    s.fastForward(2.5);
    const mo = new MutationObserver(() => {});
    mo.observe(svg, { childList: true, subtree: true });
    let t = 0; while (t < 4) { s.clock._tick(0, 50); t += 0.05 * NetKit.Speed.value; }
    const pops = mo.takeRecords().flatMap(x => [...x.addedNodes]).filter(n => n.classList && n.classList.contains('pop')).map(n => n.textContent);
    mo.disconnect();
    return { n: svg.querySelectorAll('.pagos').length, pops, brk: !!svg.querySelector('.breaker') };
  }`;
  for (const mobile of [false, true]) {
    await open(page, 0, mobile);
    const r = await engine(page, run);
    check(r.n === 6, `réplicas dibujadas ${r.n}`);
    check(r.pops.some(p => p.includes('🤖')), `sin 🤖: ${r.pops}`);
    check(r.brk, 'no se dibuja el breaker');
  }
});

test('react: el rótulo del escalado va en plural', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOPR})(svg, { rate: 20, autoscale: { target: 0.3, min: 1, max: 6, cooldown: 0, startup: 1 } });
    const mo = new MutationObserver(() => {});
    mo.observe(svg, { childList: true, subtree: true });
    let t = 0; while (t < 8) { s.clock._tick(0, 50); t += 0.05 * NetKit.Speed.value; }
    const pops = mo.takeRecords().flatMap(x => [...x.addedNodes]).filter(n => n.classList && n.classList.contains('pop')).map(n => n.textContent);
    mo.disconnect();
    return { pops: pops.filter(p => p.includes('🤖')), jumps: s.ev.filter(e => e.kind === 'scale').map(e => e.detail.to - e.detail.from) };
  }`);
  check(r.jumps.some(j => j > 1), `sin saltos de más de una réplica: ${r.jumps}`);
  check(r.pops.some(p => /\+[2-9] réplicas/.test(p)), `rótulos: ${r.pops}`);
  check(!r.pops.some(p => /\+[2-9] réplica$/.test(p)), `singular con varias: ${r.pops}`);
});

test('react: el autoscaler no decide sin réplicas listas', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOPR})(svg, { restartPolicy: 'on-failure', autoscale: { target: 0.7, min: 1, max: 6, cooldown: 2, startup: 1 } });
    s.fastForward(5);
    s.breakPagos('crash');
    s.fastForward(30);
    return { n: s.replicaCount, scales: s.ev.filter(e => e.kind === 'scale').map(e => e.detail.to) };
  }`);
  check(r.n === 1 && r.scales.length === 0, `crash loop escaló: ${r.n} réplicas · ${r.scales}`);
});

test('react: al achicar saca primero las que no están listas', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const s = (${SHOPR})(svg, { replicas: 3, restartTime: 3 });
    s.fastForward(3);
    s.restartReplica(0); // la 1 queda arrancando
    s.set('replicas', 2);
    return [s.replicaState(0).id, s.replicaState(1).id];
  }`);
  check(r.join() === '2,3', `quedaron ${r}`);
});

test('react: colgar y tirar una sola réplica', async page => {
  await open(page, 0);
  const r = await engine(page, `(svg) => {
    const a = (${SHOPR})(svg, { replicas: 2, readiness: true });
    a.fastForward(5);
    a.hangReplica(0);
    a.fastForward(20);
    const hung = { s0: a.replicaState(0), s1: a.replicaState(1), err: a.window(3).errPct, fault: a.fault };
    a.heal();
    a.fastForward(3);
    const healed = a.replicaState(0);
    const b = (${SHOPR})(svg, { restartPolicy: 'on-failure' });
    b.fastForward(5);
    b.crashReplica(0);
    b.fastForward(20);
    const once = { st: b.replicaState(0), restarts: b.ev.filter(e => e.kind === 'restart').length, err: b.window(5).errPct };
    const c = (${SHOPR})(svg, {});
    c.fastForward(5);
    c.crashReplica(0);
    c.fastForward(5);
    const down = c.replicaState(0).up;
    c.heal();
    c.fastForward(5);
    c.restartReplica(0, { auto: true });
    return { hung, healed, once, down, upAgain: c.replicaState(0).up || c.replicaState(0).booting, auto: c.ev.map(e => e.kind) };
  }`);
  check(r.hung.s0.hang && !r.hung.s0.inRotation && r.hung.s1.ready && !r.hung.s1.hang && r.hung.fault === null, JSON.stringify(r.hung));
  check(r.hung.err === 0, `con una colgada y readiness: errPct ${r.hung.err}`);
  check(!r.healed.hang && r.healed.inRotation, `arreglar no la descolgó: ${JSON.stringify(r.healed)}`);
  check(r.once.st.up && r.once.st.restarts === 1 && r.once.restarts === 1 && r.once.err === 0, JSON.stringify(r.once));
  check(!r.down && r.upAgain, `heal no levanta la caída: ${r.down} → ${r.upAgain}`);
  check(r.auto.includes('restart'), `reinicio automático sin 🤖: ${r.auto}`);
});

test('react: el breaker es una píldora sobre el enlace a Pagos', async page => {
  for (const mobile of [false, true]) {
    await open(page, 0, mobile);
    const r = await engine(page, `(svg) => {
      const s = new ShopSimKit.ShopSim(svg, { timeout: 2, breaker: { failures: 3, openFor: 5 } });
      const g = svg.querySelector('.breaker'), rect = g && g.querySelector('rect');
      const m = g && /translate\\(([-\\d.]+)/.exec(g.getAttribute('transform'));
      const x = rect && m ? +m[1] + +rect.getAttribute('x') + rect.getAttribute('width') / 2 : null;
      return { rect: !!rect, text: g && g.textContent, x, ox: s.ordenes.x, px: s.reps[0].node.x, oy: s.ordenes.y, py: s.reps[0].node.y };
    }`);
    check(r.rect && r.text.includes('cerrado'), `píldora: ${JSON.stringify(r)}`);
    const lo = Math.min(r.ox, r.px), hi = Math.max(r.ox, r.px);
    check(r.x > lo && r.x < hi, `no está entre Órdenes y Pagos (${mobile ? 'celular' : 'escritorio'}): ${JSON.stringify(r)}`);
  }
});

/* ---------- widgets del dashboard ---------- */

// Arma en la página una "slide de prueba" con los cuatro widgets sobre una ShopSim y la deja correr `ff` s.
// fn(ctx) corre en la página con ctx = { sim, root, logs, trace, ... }.
function widgetPage(body, ff = 20) {
  return `(async () => {
    const root = document.createElement('div');
    root.id = 'wtest'; root.className = 'panel';
    root.style.cssText = 'box-sizing:border-box;position:absolute;left:0;top:0;z-index:99;width:' + (document.documentElement.classList.contains('mobile') ? '100%' : '560px') + ';padding:8px;background:#0a0f1f';
    root.innerHTML = '<svg class="sim" style="display:none"></svg>' +
      '<div class="sstats" data-service="pagos" data-fields="n,rps,errPct,avg,p50,p95,p99,sat" data-window="10"></div>' +
      '<div class="chart-box"><canvas class="svc-chart"></canvas></div>' +
      '<div class="logs"></div><div class="trace"></div>';
    document.body.appendChild(root);
    const sim = new ShopSimKit.ShopSim(root.querySelector('svg'), {});
    const logs = root.querySelector('.logs'), trace = root.querySelector('.trace');
    const stats = root.querySelector('.sstats');
    Widgets.svcStats(stats, sim);
    const chart = Widgets.svcChart(root.querySelector('canvas'), sim, { service: 'pagos' });
    const logW = Widgets.logStream(logs, sim);
    const traceW = Widgets.traceView(trace, sim);
    sim.fastForward(${ff});
    return (${body})({ sim, root, logs, trace, stats, chart, logW, traceW });
  })()`;
}

test('widget: estadísticas y gráfico siguen la simulación', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    const cells = [...c.stats.querySelectorAll('.sstat b')].map(b => b.textContent);
    c.sim.breakPagos('slowdb');
    c.sim.fastForward(30);
    return { n: cells.length, vals: cells, sat: c.stats.querySelector('[data-f="sat"]').textContent,
      pts: c.chart.data.datasets.map(d => d.data.filter(x => x !== null).length), cls: c.root.querySelector('canvas').className };
  }`));
  check(r.n === 8, `campos: ${r.n}`);
  check(r.vals.every(v => v !== '' ), `vacíos: ${r.vals}`);
  check(parseInt(r.sat) >= 95, `sat tras slowdb: ${r.sat}`);
  check(r.pts.every(n => n > 10), `puntos del gráfico: ${r.pts}`);
  check(r.cls === 'svc-chart', `clase del canvas: ${r.cls}`);
});

test('widget: logs filtra por nivel y pedido', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    c.sim.breakPagos('slowdb');
    c.sim.fastForward(30);
    c.logW.render();
    const all = [...c.logs.querySelectorAll('.log-line')];
    c.logs.querySelector('[data-level="error"]').click();
    const err = [...c.logs.querySelectorAll('.log-line')].map(l => l.className);
    const first = c.sim.logs.filter(l => l.level === 'error').slice(-1)[0].orderId;
    const input = c.logs.querySelector('input.log-search');
    input.value = String(first); input.dispatchEvent(new Event('input'));
    const byOrder = [...c.logs.querySelectorAll('.log-line')].map(l => l.textContent);
    return { all: all.length, err, first, byOrder };
  }`));
  check(r.all > 0 && r.all <= 40, `líneas: ${r.all}`);
  check(r.err.length > 0 && r.err.every(c => c.includes('lv-error')), `no todas error: ${r.err}`);
  check(r.byOrder.length > 0 && r.byOrder.every(t => t.includes(`#${r.first}`)), `no todas con #${r.first}: ${r.byOrder.slice(0, 3)}`);
});

test('widget: logs en json', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    c.logs.dataset.format = 'json';
    c.logW.render();
    return [...c.logs.querySelectorAll('.log-line')].map(l => l.textContent);
  }`));
  check(r.length > 0, 'sin líneas');
  const objs = r.map(l => JSON.parse(l));
  check(objs.every(o => /^[0-9a-f]{8}$/.test(o.traceId) && o.level && o.service && o.msg && o.orderId), 'faltan campos');
});

test('widget: cascada resalta pagos', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    c.sim.breakPagos('slowdb');
    c.sim.fastForward(25);
    const ok = c.sim.traces.filter(t => t.ok).slice(-1)[0];
    c.traceW.select(ok.traceId);
    const rows = [...c.trace.querySelectorAll('.t-row')].map(r => r.dataset.service);
    const hl = [...c.trace.querySelectorAll('.t-row.longest')].map(r => r.dataset.service);
    const colors = [...c.trace.querySelectorAll('.t-bar')].map(b => b.style.background);
    return { rows, hl, colors, head: c.trace.querySelector('.tr-head').textContent, id: ok.orderId };
  }`, 10));
  check(r.rows.join() === 'ordenes,pagos,envios', `spans: ${r.rows}`);
  check(r.hl.join() === 'pagos', `resaltado: ${r.hl}`);
  check(new Set(r.colors).size === 3, `colores: ${r.colors}`);
  check(r.head.includes(`#${r.id}`) && /\d/.test(r.head), `header: ${r.head}`);
});

test('widget: legibles en celular', async page => {
  await page.setViewport({ width: 400, height: 800, isMobile: true, hasTouch: true });
  await open(page, 0, true);
  const r = await page.evaluate(widgetPage(`(c) => {
    c.logs.dataset.format = 'text'; c.logW.render();
    const out = {};
    for (const [k, el] of [['logs', c.logs], ['trace', c.trace], ['stats', c.stats]]) out[k] = el.scrollWidth <= el.clientWidth + 1;
    out.page = c.root.scrollWidth <= c.root.clientWidth + 1 && c.root.getBoundingClientRect().right <= document.documentElement.clientWidth + 1;
    out.lines = c.logs.querySelectorAll('.log-line').length;
    out.hits = [...c.logs.querySelectorAll('button, input')].map(b => {
      const r = b.getBoundingClientRect();
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return t === b || b.contains(t);
    });
    return out;
  }`));
  check(r.logs && r.trace && r.stats, `scroll horizontal: ${JSON.stringify(r)}`);
  check(r.page, 'el contenedor de los widgets desborda');
  check(r.lines > 0, 'sin líneas');
  check(r.hits.length >= 5 && r.hits.every(Boolean), `controles sin toque: ${r.hits}`);
});

test('widget: logs siguen después de un reset', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    c.sim.fastForward(30);
    c.sim.reset();
    const vacio = c.logs.querySelectorAll('.log-line').length;
    c.sim.fastForward(3);
    const lines = [...c.logs.querySelectorAll('.log-line')].map(l => l.textContent);
    return { vacio, lines, t: c.sim.t };
  }`));
  check(r.vacio === 0, `tras reset quedan ${r.vacio} líneas`);
  check(r.lines.length > 0, `no aparecen líneas nuevas tras el reset (t=${r.t})`);
});

test('widget: logs busca el pedido exacto', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    const input = c.logs.querySelector('input.log-search');
    input.value = '100'; input.dispatchEvent(new Event('input'));
    const parcial = c.logs.querySelectorAll('.log-line').length;
    const id = c.sim.logs[c.sim.logs.length - 10].orderId;
    input.value = '#' + id; input.dispatchEvent(new Event('input'));
    const exacto = [...c.logs.querySelectorAll('.log-line')].map(l => l.textContent);
    return { parcial, exacto, id };
  }`));
  check(r.parcial === 0, `«100» encuentra ${r.parcial} líneas (substring)`);
  check(r.exacto.length > 0 && r.exacto.every(t => t.includes(`order=#${r.id} `)), `#${r.id}: ${r.exacto.slice(0, 2)}`);
});

test('widget: cascada fijada sobrevive al ring y se suelta con reset', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    const tr = c.sim.traces[0];
    c.traceW.select(tr.traceId);
    c.sim.fastForward(20); // el ring de 50 trazas ya la descartó
    const evicted = !c.sim.traces.includes(tr);
    c.traceW.render();
    const kept = c.trace.querySelector('.tr-head').textContent;
    c.sim.reset();
    c.sim.fastForward(5);
    const after = c.trace.textContent;
    return { evicted, kept, id: tr.orderId, after, cur: c.traceW.current, latest: c.sim.traces.slice(-1)[0].traceId };
  }`, 5));
  check(r.evicted, 'la prueba no llegó a vaciar el ring');
  check(r.kept.includes(`#${r.id}`), `la fijada se perdió: ${r.kept}`);
  check(!r.after.includes('Todavía no hay trazas'), 'trabada en «Todavía no hay trazas» tras el reset');
  check(r.cur === r.latest, `tras el reset no sigue la última: ${r.cur} vs ${r.latest}`);
});

test('widget: cascada con un id que no está vuelve a la última', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    c.traceW.select('ffffffff');
    const cur = c.traceW.current, latest = c.sim.traces.slice(-1)[0].traceId;
    c.sim.fastForward(2);
    return { cur, latest, cur2: c.traceW.current, latest2: c.sim.traces.slice(-1)[0].traceId };
  }`, 5));
  check(r.cur === r.latest && r.cur2 === r.latest2, JSON.stringify(r));
});

test('widget: cascada resalta el más largo sin contar Órdenes aunque no sea el primero', async page => {
  await open(page, 0);
  const r = await page.evaluate(widgetPage(`(c) => {
    c.traceW.select({ traceId: 'abcd0123', orderId: 9999, ok: true, spans: [
      { service: 'pagos', start: 0.1, end: 1.6, ok: true },
      { service: 'ordenes', start: 0, end: 1.8, ok: true },
      { service: 'envios', start: 1.6, end: 1.7, ok: true }] });
    return { hl: [...c.trace.querySelectorAll('.t-row.longest')].map(r => r.dataset.service), head: c.trace.querySelector('.tr-head').textContent };
  }`, 2));
  check(r.hl.join() === 'pagos', `resaltado: ${r.hl}`);
  check(r.head.includes('#9999'), r.head);
});

/* ---------- escenas: el problema y las métricas ---------- */

// Índices de slide (0-based)
const SL = { sinsenales: 1, preguntas: 2, metricas: 3, percentiles: 4, doradas: 5, logs: 6, centralizar: 7, trazas: 8, tresjuntas: 9,
  umbral: 10, sintoma: 11, slo: 12,
  health: 13, supervisor: 14, autoscaling: 15, breaker: 16, limites: 17 };

// Mueve un slider de la slide y dispara 'input'
const SLIDE_INPUT = `(sec, sel, v) => { const r = sec.querySelector(sel); r.value = v; r.dispatchEvent(new Event('input')); }`;

test('escena sinsenales: la queja llega después del error', async page => {
  await open(page);
  const r = await evalScene(page, SL.sinsenales, sec => {
    const sc = sec._scene, sim = sc.sim;
    sim.fastForward(10);
    const antes = sc.state();
    sec.querySelector('[data-act=break]').click();
    sim.fastForward(30);
    const st = sc.state();
    const bubble = sec.querySelector('.complaint');
    const shown = !bubble.hidden;
    sec.querySelector('[data-act=reset]').click();
    return { antes, st, shown, after: !sec.querySelector('.complaint').hidden };
  });
  check(r.antes.firstErr === null && r.antes.complaintAt === null, `antes de romper: ${JSON.stringify(r.antes)}`);
  check(r.st.firstErr !== null && r.st.complaintAt !== null, JSON.stringify(r.st));
  check(r.st.complaintAt - r.st.firstErr >= 5, `queja ${r.st.complaintAt} vs error ${r.st.firstErr}`);
  check(r.shown, 'el globo de la queja no se ve');
  check(!r.after, 'el globo sigue después del reset');
});

test('escena percentiles: subir % lentos mueve p99 y no el promedio', async page => {
  await open(page);
  const r = await evalScene(page, SL.percentiles, `(sec, SI) => {
    const sim = sec._scene.sim;
    eval(SI)(sec, 'input.slow', 0);
    sim.fastForward(40);
    const w0 = sim.window(30, 'checkout');
    eval(SI)(sec, 'input.slow', 5);
    sim.fastForward(40);
    const w5 = sim.window(30, 'checkout');
    return { w0, w5, ratio: sim.o.slowRatio, out: sec.querySelector('.slow-out').textContent };
  }`, SLIDE_INPUT);
  check(r.ratio === 0.05, `slowRatio ${r.ratio}`);
  check(r.out.includes('5'), `rótulo: ${r.out}`);
  check(r.w5.p99 >= 5 * r.w0.p99, `p99 ${r.w0.p99} → ${r.w5.p99}`);
  check(r.w5.avg < 1.5 * r.w0.avg, `avg ${r.w0.avg} → ${r.w5.avg}`);
});

test('escena doradas: la saturación llega antes que los errores', async page => {
  await open(page);
  const r = await evalScene(page, SL.doradas, sec => {
    const sim = sec._scene.sim;
    sim.fastForward(20);
    const sano = sim.window(5, 'pagos');
    sec.querySelector('[data-act=break]').click();
    // la misma ventana que muestran los números de la slide (data-window="3"), en pasos de 0,2 s
    const win = +sec.querySelector('.sstats').dataset.window;
    let sat = null, err = null;
    for (let i = 1; i <= 150; i++) {
      sim.fastForward(0.2);
      const w = sim.window(win, 'pagos'), t = Math.round(i * 2) / 10;
      if (sat === null && w.sat >= 0.95) sat = t;
      if (err === null && w.errPct > 1) err = t;
    }
    return { sano: { sat: sano.sat, errPct: sano.errPct }, sat, err, win, pool: sim.o.showPool };
  });
  check(r.pool === true, 'showPool apagado');
  check(r.sano.sat < 0.95 && r.sano.errPct <= 1, `sano: ${JSON.stringify(r.sano)}`);
  check(r.sat !== null && r.err !== null, JSON.stringify(r));
  check(r.err - r.sat >= 1, `saturación en ${r.sat} s, errores en ${r.err} s (ventana ${r.win} s)`);
});

test('escena doradas: tráfico es la demanda, no lo que termina Pagos', async page => {
  await open(page);
  const r = await evalScene(page, SL.doradas, sec => {
    const sim = sec._scene.sim, rate = sim.o.rate;
    const arr = [];
    sim.on('request', () => arr.push(sim.now)); // llegadas, contadas aparte
    sim.fastForward(20);
    sec.querySelector('[data-act=break]').click();
    const cell = () => +sec.querySelector('.sstats [data-f=rps]').textContent.replace(',', '.');
    const rows = [];
    for (let i = 0; i < 20; i++) {
      sim.fastForward(0.5);
      const t = sim.now, win = sec._scene.trafficWindow;
      rows.push({ shown: cell(), arrivals: arr.filter(x => x > t - win).length / win, done: sim.window(3, 'pagos').rps });
    }
    return { rate, rows };
  });
  const bad = r.rows.filter(x => Math.abs(x.shown - x.arrivals) > 0.06);
  check(!bad.length, `no muestra las llegadas: ${JSON.stringify(bad[0])}`);
  // Llegadas Poisson a 6/s: en 10 s varían ±25% solas; lo que no puede pasar es el salto de las respuestas acumuladas
  const off = r.rows.filter(x => Math.abs(x.shown - r.rate) > 0.3 * r.rate);
  check(!off.length, `tráfico lejos de ${r.rate}/s: ${off.map(x => x.shown)}`);
  check(r.rows.some(x => x.done > 1.4 * r.rate), 'la prueba ya no reproduce el pico de respuestas que quería evitar');
});

test('escena doradas: el slider de pool redibuja las conexiones', async page => {
  await open(page);
  const r = await evalScene(page, SL.doradas, `(sec, SI) => {
    eval(SI)(sec, 'input.pool', 6);
    return { pool: sec._scene.sim.o.pool, slots: sec.querySelectorAll('svg.sim .slot').length, out: sec.querySelector('.pool-out').textContent };
  }`, SLIDE_INPUT);
  check(r.pool === 6 && r.slots === 6, JSON.stringify(r));
});

/* ---------- escenas: logs y trazas ---------- */

test('escena logs: buscar el último error muestra sólo ese pedido', async page => {
  await open(page);
  const r = await evalScene(page, SL.logs, sec => {
    const sim = sec._scene.sim;
    sim.fastForward(8);
    sec.querySelector('[data-act=break]').click();
    sim.fastForward(15);
    sec.querySelector('[data-act=last-error]').click();
    const q = sec.querySelector('input.log-search').value;
    const lines = [...sec.querySelectorAll('.log-line')].map(l => l.textContent);
    return { q, lines };
  });
  check(/^\d+$/.test(r.q), `búsqueda: ${r.q}`);
  check(r.lines.length > 0 && r.lines.every(t => t.includes(`order=#${r.q} `)), `líneas: ${r.lines.slice(0, 3)}`);
  check(r.lines.some(t => t.includes('ERROR')), 'el pedido buscado no tiene su error');
});

test('escena centralizar: por réplica el pedido aparece en una sola caja', async page => {
  await open(page);
  const r = await evalScene(page, SL.centralizar, sec => {
    const sim = sec._scene.sim;
    sec.querySelector('.seg[data-group=where] [data-v=replica]').click();
    sim.fastForward(12);
    const id = sim.logs.filter(l => l.service === 'pagos').slice(-5)[0].orderId;
    const input = sec.querySelector('input.order-search');
    input.value = String(id); input.dispatchEvent(new Event('input'));
    const boxes = [...sec.querySelectorAll('.rep-box')].map(b => ({ vis: !b.closest('[hidden]'), n: b.querySelectorAll('.log-line').length }));
    sec.querySelector('.seg[data-group=fmt] [data-v=json]').click();
    const json = [...sec.querySelectorAll('.rep-box .log-line')].map(l => l.textContent);
    sec.querySelector('.seg[data-group=where] [data-v=central]').click();
    const central = [...sec.querySelectorAll('.logs .log-line')].filter(l => !l.closest('[hidden]')).map(l => l.textContent);
    return { id, reps: sim.replicaCount, boxes, json, central };
  });
  check(r.reps === 3, `réplicas: ${r.reps}`);
  check(r.boxes.length === 3 && r.boxes.every(b => b.vis), JSON.stringify(r.boxes));
  check(r.boxes.filter(b => b.n > 0).length === 1, `cajas con el pedido #${r.id}: ${JSON.stringify(r.boxes)}`);
  check(r.json.length > 0 && r.json.every(t => JSON.parse(t).orderId === r.id), `json: ${r.json[0]}`);
  const svcs = new Set(r.central.map(t => JSON.parse(t).service));
  check(svcs.has('ordenes') && svcs.has('pagos'), `central no junta servicios: ${[...svcs]}`);
});

test('escena trazas: el clic abre la traza de ese pedido', async page => {
  await open(page);
  await goto(page, SL.trazas);
  await page.waitForFunction(i => window.__sec(i).querySelector('svg.sim circle.pick[data-order]'), { timeout: 4000 }, SL.trazas);
  const r = await page.evaluate(i => {
    const sec = window.__sec(i), sim = sec._scene.sim;
    const dot = sec.querySelector('svg.sim circle.pick[data-order]');
    const id = +dot.dataset.order;
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    sim.fastForward(6);
    return { id, head: sec.querySelector('.trace .tr-head').textContent, cur: sec._scene.state() };
  }, SL.trazas);
  check(r.head.includes(`#${r.id} `) || r.head.includes(`#${r.id}`) && !r.head.includes(`#${r.id}0`), `cascada: ${r.head} (clic en #${r.id})`);
  check(r.cur.orderId === r.id, JSON.stringify(r.cur));
});

test('escena trazas: con Pagos roto la cascada muestra Pagos largo', async page => {
  await open(page);
  const r = await evalScene(page, SL.trazas, sec => {
    const sim = sec._scene.sim;
    sim.fastForward(5);
    sec.querySelector('[data-act=break]').click();
    sim.fastForward(15);
    sec.querySelector('[data-act=slowest]').click();
    return { hl: [...sec.querySelectorAll('.trace .t-row.longest')].map(r => r.dataset.service), dur: sec.querySelector('.tr-dur').textContent };
  });
  check(r.hl.join() === 'pagos', `resaltado: ${r.hl}`);
  check(/\d+,\d s/.test(r.dur), `duración: ${r.dur}`);
});

test('escena tresjuntas: el recorrido llega a logs del mismo trace', async page => {
  await open(page);
  await goto(page, SL.tresjuntas);
  // avanza a un momento con Pagos ya roto (se rompe solo a los pocos segundos)
  const pt = await page.evaluate(i => {
    const sec = window.__sec(i), sim = sec._scene.sim;
    sim.fastForward(25);
    const cv = sec.querySelector('canvas.svc-chart'), ch = Chart.getChart(cv);
    const idx = ch.data.labels.length - 11; // unos 5 s atrás: esos pedidos ya terminaron
    const b = cv.getBoundingClientRect(), sx = b.width / cv.offsetWidth, sy = b.height / cv.offsetHeight;
    const x = ch.scales.x.getPixelForValue(idx), y = (ch.chartArea.top + ch.chartArea.bottom) / 2;
    return { x: b.left + x * sx, y: b.top + y * sy };
  }, SL.tresjuntas);
  await page.mouse.click(pt.x, pt.y);
  await sleep(250); // Chart.js atiende los eventos en el próximo frame
  const r = await page.evaluate(i => {
    const sec = window.__sec(i), sc = sec._scene;
    const s1 = sc.state();
    const rows = [...sec.querySelectorAll('.tj-row')];
    const row = rows.find(x => x.classList.contains('err'));
    if (!row) return { s1, rows: rows.length };
    row.click();
    const s2 = sc.state();
    const head = sec.querySelector('.trace .tr-head').textContent;
    sec.querySelector('.trace .t-row[data-service=pagos]').click();
    const s3 = sc.state();
    const lines = [...sec.querySelectorAll('.tj-logs .log-line')].map(l => ({ trace: l.dataset.trace, text: l.textContent }));
    const crumbs = [...sec.querySelectorAll('.crumbs .crumb.on')].map(c => c.textContent);
    return { s1, s2, s3, head, lines, crumbs, rows: rows.length };
  }, SL.tresjuntas);
  check(r.s1.step === 'traces' && r.s1.moment > 6, `tras el clic en el gráfico: ${JSON.stringify(r.s1)}`);
  check(r.rows > 0 && r.rows <= 6, `trazas listadas: ${r.rows}`);
  check(r.s2 && r.s2.step === 'trace' && r.head.includes(r.s2.traceId), `cascada: ${r.head} ${JSON.stringify(r.s2)}`);
  check(r.s3.step === 'logs' && r.s3.traceId === r.s2.traceId, JSON.stringify(r.s3));
  check(r.lines.length > 0 && r.lines.every(l => l.trace === r.s2.traceId), `logs de otra traza: ${JSON.stringify(r.lines.slice(0, 3))}`);
  check(r.lines.some(l => l.text.includes('timeout acquiring db connection')), `sin el timeout: ${r.lines.map(l => l.text)}`);
  check(r.crumbs.length === 3, `migas: ${r.crumbs}`);
});

test('escena tresjuntas: las migas vuelven atrás', async page => {
  await open(page);
  const r = await evalScene(page, SL.tresjuntas, sec => {
    const sc = sec._scene, sim = sc.sim;
    sim.fastForward(25);
    sc.pickMoment(sim.now - 5);
    sec.querySelector('.tj-row').click();
    sec.querySelector('.trace .t-row[data-service=pagos]').click();
    const a = sc.state().step;
    sec.querySelector('.crumb[data-step=trace]').click();
    const b = sc.state().step, logsHidden = sec.querySelector('.tj-logs .log-line') === null;
    sec.querySelector('.crumb[data-step=metric]').click();
    return { a, b, logsHidden, c: sc.state().step };
  });
  check(r.a === 'logs' && r.b === 'trace' && r.logsHidden && r.c === 'metric', JSON.stringify(r));
});

/* ---------- escenas: alertas y SLO ---------- */

test('escena umbral: hay un punto medio', async page => {
  await open(page);
  const r = await evalScene(page, SL.umbral, `(sec, SI) => {
    const sc = sec._scene, thr = sec.querySelector('input.thr');
    const marks = () => ({ fp: sec.querySelectorAll('svg.sim .fp-mark').length, miss: sec.querySelectorAll('svg.sim .miss-mark').length, hit: sec.querySelectorAll('svg.sim .hit-mark').length });
    const cells = () => [...sec.querySelectorAll('.hstats b')].map(b => b.textContent);
    const init = Object.assign(sc.state(), marks(), { cells: cells() });
    eval(SI)(sec, 'input.thr', thr.min);
    const low = Object.assign(sc.state(), marks());
    eval(SI)(sec, 'input.thr', thr.max);
    const high = Object.assign(sc.state(), marks());
    eval(SI)(sec, 'input.thr', thr.defaultValue);
    sec.querySelector('.seg[data-group=win] [data-v="0"]').click();
    const w0 = sc.state();
    sec.querySelector('.seg[data-group=win] [data-v="5"]').click();
    const w5 = sc.state();
    sc.ff(40);
    return { init, low, high, w0, w5, live: sc.state().live };
  }`, SLIDE_INPUT);
  const tri = s => `${s.caught}/${s.missed}/${s.falsePos}`;
  check(tri(r.init) === '1/0/0', `inicial (umbral ${r.init.threshold}, ventana ${r.init.forMin}): ${tri(r.init)}`);
  check(r.init.hit === 1 && r.init.fp === 0 && r.init.miss === 0, `marcas iniciales: ${JSON.stringify(r.init)}`);
  check(r.init.cells.slice(0, 3).join() === '1,0,0', `contadores: ${r.init.cells}`);
  check(r.low.falsePos >= 3 && r.low.fp === r.low.falsePos, `umbral bajo: ${JSON.stringify(r.low)}`);
  check(r.high.missed >= 1 && r.high.miss === r.high.missed, `umbral alto: ${JSON.stringify(r.high)}`);
  check(r.w0.falsePos >= 3 && r.w0.caught === 1, `sin ventana los picos suenan: ${JSON.stringify(r.w0)}`);
  check(r.w5.caught === 1 && r.w5.delay > r.init.delay, `ventana larga avisa más tarde: ${r.init.delay} → ${r.w5.delay}`);
  check(['ok', 'pending', 'firing'].includes(r.live), `estado en vivo: ${r.live}`);
});

test('escena sintoma: las de causa hacen ruido', async page => {
  await open(page);
  const r = await evalScene(page, SL.sintoma, sec => {
    const sc = sec._scene;
    sc.ff(40);
    const calm = sc.state();
    sec.querySelector('.seg[data-group=night] [data-v=incident]').click();
    const start = sc.state();
    sc.ff(40);
    const inc = sc.state();
    sec.querySelectorAll('input[data-alert]').forEach(cb => {
      if (cb.dataset.alert !== 'sym') { cb.checked = false; cb.dispatchEvent(new Event('change')); }
    });
    const symOnly = sc.state();
    const shown = +sec.querySelector('.hstats [data-f=total]').textContent;
    return { calm, start, inc, symOnly, shown };
  });
  const f = r.calm.fired;
  check(f.cpu > 0 && f.mem > 0 && f.rep > 0, `noche tranquila, causas: ${JSON.stringify(f)}`);
  check(f.sym === 0, `noche tranquila, síntoma: ${f.sym}`);
  check(r.calm.total === f.cpu + f.mem + f.rep, `total ${r.calm.total} vs ${JSON.stringify(f)}`);
  check(r.start.total === 0, `la noche nueva no arranca en cero: ${r.start.total}`);
  check(r.inc.fired.sym >= 1, `con incidente, síntoma: ${JSON.stringify(r.inc.fired)}`);
  const during = ['cpu', 'mem', 'rep'].flatMap(k => r.inc.firings[k].filter(f => f[0] <= 342 && 300 <= f[1]).map(f => `${k} ${f}`));
  check(!during.length, `una alerta de causa suena durante el incidente (05:00–05:42): ${during}`);
  check(r.symOnly.total === r.inc.fired.sym && r.shown === r.symOnly.total, `sólo síntoma: ${JSON.stringify(r.symOnly)} (muestra ${r.shown})`);
});

test('escena slo: romper acelera el consumo', async page => {
  await open(page);
  const r = await evalScene(page, SL.slo, sec => {
    const sc = sec._scene;
    const run = v => {
      sec.querySelector(`.seg[data-group=slo] [data-v="${v}"]`).click();
      sec.querySelector('[data-act=reset]').click();
      sc.ff(8);
      const sano = sc.state();
      sec.querySelector('[data-act=break]').click();
      sc.ff(3);
      const roto = sc.state();
      sc.ff(25);
      return { sano, roto, end: sc.state() };
    };
    // texto «a este ritmo…»: lo que queda del presupuesto, no un presupuesto entero
    const lasts = () => ({ st: sc.state(), text: sec.querySelector('svg.sim .lasts-txt').textContent });
    sec.querySelector('.seg[data-group=slo] [data-v="99"]').click();
    sec.querySelector('[data-act=reset]').click();
    sc.ff(8);
    sec.querySelector('[data-act=break]').click();
    sc.ff(3);
    const mid = lasts();
    sc.ff(10);
    const out = lasts();
    sec.querySelector('[data-act=heal]').click();
    sc.ff(4);
    const healed = lasts();
    return { s999: run('99.9'), s99: run('99'), s995: run('99.5'), mid, out, healed };
  });
  const m = r.mid.st, want = m.remainingPct / 100 * 30 / m.burnRate;
  check(m.remainingPct > 0 && m.burnRate > 1, `a mitad del incidente: ${JSON.stringify(m)}`);
  const mt = r.mid.text.match(/dura (?:unos? )?(\d+) (días|h)/);
  check(mt, `texto: ${r.mid.text}`);
  const shown = mt[2] === 'h' ? +mt[1] / 24 : +mt[1];
  check(Math.abs(shown - want) <= Math.max(0.6, want * 0.1), `muestra ${r.mid.text}, queda ${m.remainingPct}% a ${m.burnRate}× → ${want.toFixed(2)} días`);
  check(r.out.st.remainingPct <= 0 && r.out.text.includes('ya se agotó'), `agotado: ${r.out.text} (${r.out.st.remainingPct})`);
  check(r.healed.st.remainingPct <= 0 && r.healed.text.includes('ya se agotó'), `agotado y arreglado: ${r.healed.text}`);
  for (const k of ['s99', 's995', 's999']) {
    const x = r[k];
    check(x.sano.burnRate > 0, `${k}: el sano no consume nada (${x.sano.burnRate})`);
    check(x.roto.burnRate > 5 * x.sano.burnRate, `${k}: burnRate ${x.sano.burnRate} → ${x.roto.burnRate}`);
    check(x.sano.alert === false && x.roto.alert === true, `${k}: alerta ${x.sano.alert} → ${x.roto.alert}`);
  }
  check(r.s999.end.exhaustedAfter !== null, `99,9 no se agotó: ${JSON.stringify(r.s999.end)}`);
  check(r.s99.end.exhaustedAfter === null || r.s999.end.exhaustedAfter < r.s99.end.exhaustedAfter,
    `se agota: 99,9 a los ${r.s999.end.exhaustedAfter} d, 99 a los ${r.s99.end.exhaustedAfter} d`);
  check(r.s999.sano.remainingPct < r.s99.sano.remainingPct, `restante sano: 99,9 ${r.s999.sano.remainingPct}, 99 ${r.s99.sano.remainingPct}`);
});

/* ---------- escenas: reaccionar solo ---------- */

test('escena health: con ¿vivo? colgar reinicia y se recupera', async page => {
  await open(page);
  const r = await evalScene(page, SL.health, sec => {
    const sim = sec._scene.sim;
    const run = mode => {
      sec.querySelector(`.seg[data-group=probe] [data-v=${mode}]`).click();
      const ev = [];
      let fails = 0;
      const onR = e => ev.push(e.kind), onT = tr => { if (!tr.ok) fails++; };
      sim.on('react', onR); sim.on('trace', onT);
      sim.fastForward(5);
      sec.querySelector('[data-act=hang]').click();
      sim.fastForward(1);
      const badge = sec.querySelector('svg.sim .probe-badge[data-rep="0"]');
      const mid = { live: badge && badge.querySelector('.p-live').classList.contains('no'), text: badge && badge.textContent };
      sim.fastForward(24);
      sim.listeners.react.splice(sim.listeners.react.indexOf(onR), 1);
      sim.listeners.trace.splice(sim.listeners.trace.indexOf(onT), 1);
      return { ev, mid, st: sim.replicaState(0), err: sim.window(5).errPct, fails };
    };
    return { live: run('live'), ready: run('ready'), both: run('both') };
  });
  check(r.live.ev.includes('restart') && r.live.st.up && r.live.st.restarts === 1, `¿vivo?: ${JSON.stringify(r.live)}`);
  check(r.live.err < 5, `¿vivo? no se recuperó: ${r.live.err}`);
  check(r.live.mid.live && /vivo/.test(r.live.mid.text) && /listo/.test(r.live.mid.text), `estado en el dibujo: ${JSON.stringify(r.live.mid)}`);
  check(!r.ready.ev.includes('restart') && r.ready.st.hang && !r.ready.st.inRotation && r.ready.err === 0, `¿listo?: ${JSON.stringify(r.ready)}`);
  check(r.both.ev.includes('restart') && r.both.fails < r.live.fails, `las dos: ${r.both.fails} fallas vs ${r.live.fails}`);
});

test('escena health: deploy lento con ¿listo? no da errores', async page => {
  await open(page);
  const r = await evalScene(page, SL.health, sec => {
    const sim = sec._scene.sim;
    const run = mode => {
      sec.querySelector(`.seg[data-group=probe] [data-v=${mode}]`).click();
      let fails = 0;
      const onT = tr => { if (!tr.ok) fails++; };
      sim.on('trace', onT);
      sim.fastForward(5);
      sec.querySelector('[data-act=deploy]').click();
      sim.fastForward(15);
      sim.listeners.trace.splice(sim.listeners.trace.indexOf(onT), 1);
      return { fails, st: sim.replicaState(1) };
    };
    return { live: run('live'), ready: run('ready') };
  });
  check(r.live.fails > 0, `con sólo ¿vivo? el deploy no falla: ${JSON.stringify(r.live)}`);
  check(r.ready.fails === 0 && r.ready.st.restarts === 1 && r.ready.st.ready, `¿listo?: ${JSON.stringify(r.ready)}`);
});

test('escena supervisor: crash loop con esperas crecientes', async page => {
  await open(page);
  const r = await evalScene(page, SL.supervisor, sec => {
    const sim = sec._scene.sim;
    const rows = () => [...sec.querySelectorAll('.tl .tl-row[data-delay]')].map(x => +x.dataset.delay);
    sec.querySelector('.seg[data-group=policy] [data-v=on-failure]').click();
    sim.fastForward(3);
    sec.querySelector('[data-act=loop]').click();
    sim.fastForward(40);
    const loop = { rows: rows(), up: sim.replicaState(0).up, wait: !!sec.querySelector('.tl .tl-row.wait') };
    sec.querySelector('[data-act=heal]').click();
    sim.fastForward(5);
    const healed = sim.replicaState(0).up;
    sec.querySelector('[data-act=reset]').click();
    sim.fastForward(3);
    sec.querySelector('[data-act=crash]').click();
    sim.fastForward(10);
    const once = { rows: rows(), up: sim.replicaState(0).up };
    sec.querySelector('.seg[data-group=policy] [data-v=no]').click();
    sim.fastForward(3);
    sec.querySelector('[data-act=crash]').click();
    sim.fastForward(10);
    const no = { rows: rows(), up: sim.replicaState(0).up, dead: !!sec.querySelector('.tl .tl-row.dead') };
    return { loop, healed, once, no };
  });
  check(r.loop.rows.length >= 4, `reinicios en la línea de tiempo: ${r.loop.rows}`);
  check(r.loop.rows.slice(0, 4).join() === '1,2,4,8', `esperas: ${r.loop.rows}`);
  check(!r.loop.up && r.healed, `crash loop: ${JSON.stringify(r.loop)} · arreglado ${r.healed}`);
  check(r.once.rows.join() === '1' && r.once.up, `una vez: ${JSON.stringify(r.once)}`);
  check(r.no.rows.length === 0 && !r.no.up && r.no.dead, `sin reiniciar: ${JSON.stringify(r.no)}`);
});

test('escena autoscaling: sube con la carga y oscila sin enfriamiento', async page => {
  await open(page);
  const r = await evalScene(page, SL.autoscaling, (sec, input) => {
    const sim = sec._scene.sim, slide = eval(input);
    sim.fastForward(10);
    const before = sim.replicaCount;
    slide(sec, 'input.rate', 18);
    sim.fastForward(30);
    const after = sim.replicaCount, err = sim.window(10).errPct;
    sec.querySelector('[data-act=reset]').click();
    slide(sec, 'input.target', 30);
    slide(sec, 'input.cooldown', 0);
    const ev = [];
    sim.on('react', e => e.kind === 'scale' && ev.push(e.detail.to - e.detail.from));
    sim.fastForward(60);
    let changes = 0;
    for (let i = 1; i < ev.length; i++) if (Math.sign(ev[i]) !== Math.sign(ev[i - 1])) changes++;
    const chart = Chart.getChart(sec.querySelector('canvas.as-chart'));
    return { before, after, err, changes, state: sec._scene.state(), points: chart.data.datasets[0].data.filter(x => x !== null).length };
  }, SLIDE_INPUT);
  check(r.before === 1 && r.after >= 3, `réplicas ${r.before} → ${r.after}`);
  check(r.err < 2, `errPct con el pico ${r.err}`);
  check(r.changes >= 3, `cambios de dirección en 60 s: ${r.changes}`);
  check(r.state.changes >= 3, `state: ${JSON.stringify(r.state)}`);
  check(r.points > 10, `el gráfico no tiene puntos: ${r.points}`);
});

test('escena breaker: breaker < timeout < sin límite', async page => {
  await open(page);
  const r = await evalScene(page, SL.breaker, sec => {
    const sim = sec._scene.sim, out = {};
    for (const m of ['none', 'timeout', 'breaker']) {
      sec.querySelector(`.seg[data-group=guard] [data-v=${m}]`).click();
      const seen = new Set();
      const onTick = () => { const g = sec.querySelector('svg.sim .breaker'); if (g) seen.add(g.textContent); };
      sim.on('tick', onTick);
      sim.fastForward(5);
      sec.querySelector('[data-act=break]').click();
      for (let i = 0; i < 40; i++) { sim.fastForward(1); onTick(); }
      sim.listeners.tick.splice(sim.listeners.tick.indexOf(onTick), 1);
      out[m] = { p95: sim.window(25, 'ordenes').p95, seen: [...seen] };
    }
    return out;
  });
  check(r.breaker.p95 < r.timeout.p95 && r.timeout.p95 < r.none.p95, `p95 ${r.breaker.p95} < ${r.timeout.p95} < ${r.none.p95}`);
  check(['cerrado', 'abierto', 'medio abierto'].every(s => r.breaker.seen.some(x => x.endsWith(s))), `píldora: ${r.breaker.seen}`);
  check(r.none.seen.length === 0, `píldora sin breaker: ${r.none.seen}`);
});

test('escena limites: reiniciar alivia y vuelve a fallar', async page => {
  await open(page);
  const r = await evalScene(page, SL.limites, sec => {
    const sim = sec._scene.sim;
    sec.querySelector('.seg[data-group=react] [data-v=restart]').click();
    const series = [];
    for (let i = 0; i < 60; i++) { sim.fastForward(1); series.push([sim.now, sim.window(3).errPct]); }
    return { series, st: sec._scene.state(), out: sec.querySelector('.lim-out').textContent };
  });
  const rs = r.st.restarts;
  check(rs.length >= 2, `reinicios: ${rs}`);
  const at = (a, b) => r.series.filter(([t]) => t >= rs[0] + a && t <= rs[0] + b).map(x => x[1]);
  const dip = Math.min(...at(4, 8)), back = Math.max(...at(8, 18)), before = Math.max(...at(-4, 0));
  check(before > 30, `antes del reinicio: ${before}`);
  check(dip < 10, `no alivia: mínimo ${dip} después del reinicio en ${rs[0]}`);
  check(back > 30, `no vuelve a fallar: máximo ${back}`);
  check(/reinici/.test(r.out), `texto: ${r.out}`);
});

test('escena limites: escalar satura la DB y los reintentos multiplican la carga', async page => {
  await open(page);
  const r = await evalScene(page, SL.limites, sec => {
    const sim = sec._scene.sim, out = {};
    for (const m of ['restart', 'scale', 'retry']) {
      sec.querySelector(`.seg[data-group=react] [data-v=${m}]`).click();
      sim.fastForward(60);
      out[m] = { db: sim.window(40, 'db').p95, pagos: sim.window(30, 'pagos').rps, checkout: sim.window(30).rps, n: sim.replicaCount,
        bad: [...sec.querySelectorAll('.hstats .stat.bad')].map(x => x.className) };
    }
    return out;
  });
  check(r.scale.n > 1 && r.scale.db > 2 * r.restart.db, `p95 DB: reiniciar ${r.restart.db} · escalar ${r.scale.db} (${r.scale.n} réplicas)`);
  check(r.retry.pagos >= 2 * r.retry.checkout, `reintentos: pagos ${r.retry.pagos} rps vs checkout ${r.retry.checkout}`);
  check(r.scale.bad.some(c => c.includes('s-db')), `DB no está en rojo: ${r.scale.bad}`);
  check(r.retry.bad.some(c => c.includes('s-load')), `la carga no está en rojo: ${r.retry.bad}`);
});

/* ---------- runner ---------- */

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  let fails = 0, ran = 0;
  for (const t of tests.filter(t => t.name.includes(filter))) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluateOnNewDocument(() => {
      window.__sec = i => document.querySelectorAll('.reveal .slides > section')[i];
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => m.type() === 'error' && errors.push(m.text()));
    ran++;
    try {
      await t.fn(page, errors);
      check(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      fails++;
      console.log(`  FAIL ${t.name}\n       ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
  console.log(`${ran - fails}/${ran} ok`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})();

module.exports = { open, goto, evalScene, engine, check, sleep };
