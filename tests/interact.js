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
