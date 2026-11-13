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
