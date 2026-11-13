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
      on: svg.querySelectorAll('.slot.on').length, nodes: svg.querySelectorAll('.node-box').length };
  }`;
  await open(page, 0);
  const d = await engine(page, run);
  await open(page, 0, true);
  const m = await engine(page, run);
  check(d.vb === '0 0 900 590' && m.vb === '0 0 400 440', `${d.vb} / ${m.vb}`);
  check(d.slots === 12 && m.slots === 12, `casilleros ${d.slots} / ${m.slots}`);
  check(d.nodes === 6, `nodos ${d.nodes}`);
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
