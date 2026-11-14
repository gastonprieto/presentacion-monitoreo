// Servicio de la tienda para el laboratorio de monitoreo. La misma imagen corre tres veces:
//   SERVICIO=ordenes  GET /checkout  → llama a Pagos (con timeout)
//   SERVICIO=pagos    POST /pagar    → consulta Postgres con un pool chico (POOL) → llama a Envíos
//   SERVICIO=envios   POST /enviar   → contesta enseguida
// Fallas para romper (se guardan en el volumen compartido /estado, así todas las réplicas las ven
// y sobreviven a un reinicio):
//   POST /romper?servicio=pagos&modo=lento|colgado|crash|cpu   ·   POST /arreglar?servicio=pagos
//   lento: en Pagos cada cobro tarda más en la caja (una fila que se bloquea), en Envíos la respuesta.
//   cpu: sólo Pagos.
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const { trace, metrics, logs, SeverityNumber } = require('@opentelemetry/api');

const SERVICIO = process.env.SERVICIO || 'ordenes';
const SIGUIENTE = process.env.SIGUIENTE || '';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 2000);
const POOL = Number(process.env.POOL || 4);
const POOL_ESPERA_MS = Number(process.env.POOL_ESPERA_MS || 1000); // espera máxima por una conexión libre
const LENTO_S = Number(process.env.LENTO_S || 0.13);              // con lento, lo que tarda cada cobro en la caja
const LENTO_RAMPA_S = Number(process.env.LENTO_RAMPA_S || 60);    // en cuántos segundos llega a LENTO_S
const NORMAL_S = 0.01;
const ESTADO = '/estado';
const MODOS = ['lento', 'colgado', 'crash', 'cpu'];
const replica = os.hostname().slice(0, 6);

// ---------- Logs: JSON por stdout y el mismo registro por OTLP (llega a Loki con su trace_id) ----------
const otelLogger = logs.getLogger(SERVICIO);
const SEVERIDAD = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };
function log(nivel, mensaje, campos = {}) {
  const ctx = trace.getActiveSpan()?.spanContext();
  const linea = JSON.stringify({
    ts: new Date().toISOString(), nivel, servicio: SERVICIO, replica, mensaje,
    trace_id: ctx?.traceId, span_id: ctx?.spanId, ...campos,
  });
  console.log(linea);
  otelLogger.emit({ severityNumber: SEVERIDAD[nivel], severityText: nivel.toUpperCase(), body: linea, attributes: campos });
}

// ---------- Fallas ----------
const archivoModo = (s) => `${ESTADO}/${s}.modo`;
const leerModo = () => { try { return fs.readFileSync(archivoModo(SERVICIO), 'utf8').trim(); } catch { return ''; } };
// Desde cuándo está roto: la fecha del archivo (la misma para todas las réplicas).
const desdeModo = () => { try { return fs.statSync(archivoModo(SERVICIO)).mtimeMs; } catch { return Date.now(); } };
let modoDesde = desdeModo();
let modo = leerModo();
let colgado = false; // una vez colgado, el proceso no vuelve solo: hay que reiniciarlo

if (modo === 'crash') {
  // El "bug al arrancar": falla siempre al iniciar hasta que alguien arregle.
  log('error', 'falla al arrancar: configuración rota (modo crash)');
  setTimeout(() => process.exit(1), 500);
}
setInterval(() => {
  const nuevo = leerModo();
  if (nuevo !== modo) { modo = nuevo; modoDesde = desdeModo(); }
  if (modo === 'colgado') colgado = true;
  if (modo === 'crash') { log('error', 'se cae el proceso (modo crash)'); process.exit(1); }
}, 500).unref();

// ---------- Métricas propias (las de HTTP las pone la auto-instrumentación) ----------
const meter = metrics.getMeter('tienda');
let cpuAntes = process.cpuUsage(); let tAntes = process.hrtime.bigint();
meter.createObservableGauge('proceso.cpu.uso', { description: 'Fracción de un núcleo que usa el proceso', unit: '1' })
  .addCallback((r) => {
    const cpu = process.cpuUsage(cpuAntes); const t = process.hrtime.bigint();
    const usado = (cpu.user + cpu.system) / (Number(t - tAntes) / 1000);
    cpuAntes = process.cpuUsage(); tAntes = t;
    r.observe(usado);
  });

let pool;
if (SERVICIO === 'pagos') {
  const { Pool } = require('pg');
  // connectionTimeoutMillis: cuánto espera un pedido por una conexión libre antes de fallar
  // (menos que el timeout de Órdenes, así el 503 de Pagos llega antes de que Órdenes se canse).
  pool = new Pool({ max: POOL, connectionTimeoutMillis: POOL_ESPERA_MS });
  pool.on('error', (e) => log('error', 'error en el pool', { error: e.message }));
  const gauge = (nombre, descripcion, f) =>
    meter.createObservableGauge(nombre, { description: descripcion }).addCallback((r) => r.observe(f()));
  gauge('pagos.pool.tamano', 'Conexiones máximas del pool de Pagos', () => POOL);
  gauge('pagos.pool.en_uso', 'Conexiones del pool ocupadas', () => pool.totalCount - pool.idleCount);
  gauge('pagos.pool.esperando', 'Pedidos esperando una conexión libre', () => pool.waitingCount);
}

// ---------- HTTP ----------
const app = express();

// Colgado: no contesta nada (ni el healthcheck), pero el proceso sigue vivo.
app.use((req, res, next) => { if (!colgado) next(); });

app.get('/salud', (req, res) => res.json({ servicio: SERVICIO, replica, modo: modo || 'normal' }));

app.post('/romper', (req, res) => {
  const servicio = req.query.servicio || 'pagos';
  const m = req.query.modo;
  if (!MODOS.includes(m)) return res.status(400).json({ error: `modo tiene que ser uno de ${MODOS.join(', ')}` });
  fs.writeFileSync(archivoModo(servicio), m);
  res.json({ servicio, modo: m });
});

app.post('/arreglar', (req, res) => {
  const servicio = req.query.servicio || 'pagos';
  fs.rmSync(archivoModo(servicio), { force: true });
  res.json({ servicio, modo: 'normal' });
});

async function llamar(ruta, cuerpo) {
  const r = await fetch(SIGUIENTE + ruta, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(datos.error || `HTTP ${r.status}`), { status: r.status });
  return datos;
}

let ultimo = 1000;
if (SERVICIO === 'ordenes') {
  app.get('/checkout', async (req, res) => {
    const pedido = ++ultimo;
    log('info', 'nuevo pedido', { pedido });
    try {
      const pago = await llamar('/pagar', { pedido, monto: 1000 + (pedido % 50) * 100 });
      log('info', 'pedido confirmado', { pedido, envio: pago.envio });
      res.json({ pedido, estado: 'confirmado', ...pago });
    } catch (e) {
      const timeout = e.name === 'TimeoutError';
      log('error', timeout ? `Pagos no contestó en ${TIMEOUT_MS} ms` : `falló el pago: ${e.message}`, { pedido });
      res.status(timeout ? 504 : 502).json({ pedido, estado: 'fallido', error: e.message });
    }
  });
}

if (SERVICIO === 'pagos') {
  app.post('/pagar', express.json(), async (req, res) => {
    const { pedido, monto } = req.body;
    if (modo === 'cpu') { const fin = Date.now() + 60; while (Date.now() < fin); } // quema CPU, pero contesta bien
    let cliente;
    try {
      cliente = await pool.connect();
    } catch (e) {
      // Sin conexión libre a tiempo ("timeout exceeded when trying to connect") o la DB
      // rechaza una conexión nueva ("remaining connection slots are reserved…", al escalar Pagos).
      log('error', `sin conexión a la base: ${e.message}`, { pedido, esperando: pool.waitingCount });
      return res.status(503).json({ error: e.message });
    }
    let fallo;
    try {
      // Cada cobro suma a la misma fila (la caja del día): el UPDATE la bloquea hasta el COMMIT,
      // así que los cobros pasan de a uno, sin importar cuántas réplicas o conexiones haya.
      // Normal: 10 ms por cobro (100 por segundo). Lento: crece de a poco hasta LENTO_S (con 0,13 s,
      // unos 7,7 por segundo): primero sube la latencia y, cuando no da abasto, aparecen los errores.
      const demora = modo === 'lento'
        ? Math.min(LENTO_S, NORMAL_S + (LENTO_S - NORMAL_S) * (Date.now() - modoDesde) / 1000 / LENTO_RAMPA_S)
        : NORMAL_S;
      await cliente.query('BEGIN');
      await cliente.query('UPDATE caja SET total = total + $1, cobros = cobros + 1 WHERE id = 1', [monto]);
      await cliente.query('SELECT pg_sleep($1)', [demora]);
      await cliente.query('INSERT INTO pagos (pedido, monto) VALUES ($1, $2)', [pedido, monto]);
      await cliente.query('COMMIT');
    } catch (e) {
      fallo = e;
      await cliente.query('ROLLBACK').catch(() => {});
      log('error', 'error de la base', { pedido, error: e.message });
      return res.status(500).json({ error: e.message });
    } finally {
      cliente.release(fallo);
    }
    try {
      const envio = await llamar('/enviar', { pedido });
      log('info', 'pago aprobado', { pedido, monto });
      res.json({ pago: 'aprobado', envio: envio.envio });
    } catch (e) {
      log('error', `falló el envío: ${e.message}`, { pedido });
      res.status(502).json({ error: `envíos: ${e.message}` });
    }
  });
}

if (SERVICIO === 'envios') {
  app.post('/enviar', express.json(), async (req, res) => {
    await new Promise((r) => setTimeout(r, modo === 'lento' ? 1500 : 10 + Math.random() * 30));   // lento: 1,5 s
    const envio = `ENV-${req.body.pedido}`;
    log('info', 'envío programado', { pedido: req.body.pedido, envio });
    res.json({ envio });
  });
}

// Con el bug al arrancar no llega a escuchar: se cae antes (el medio segundo es para que salga el log).
if (modo !== 'crash') app.listen(3000, () => log('info', `${SERVICIO} escuchando en :3000`, { modo: modo || 'normal' }));
