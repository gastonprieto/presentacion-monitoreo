# Presentación de monitoreo y supervisión — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un deck interactivo de ~20 slides (medir → avisar → reaccionar solo) en el que un mismo incidente de la tienda (a Pagos se le acaba el pool de conexiones a su DB) se ve con métricas, logs, trazas, alertas y reacciones automáticas. Viene con un laboratorio Docker.

**Architecture:** Se copia `presentaciones-guideline/template`. Hay dos capas nuevas, separadas como en el deck de caché:
- `js/obs.js` (`window.ObsKit`): modelos puros y testeables sin dibujo. Ventana de métricas y percentiles, regla de alerta, SLO, supervisor, autoscaler y circuit breaker.
- `js/shopsim.js` (`window.ShopSimKit`): la simulación dibujada Usuarios → Órdenes → Pagos (pool → DB) → Envíos. Emite métricas por servicio, logs y trazas, y aplica las reacciones de `ObsKit`.

Los widgets de dashboard leen la simulación. Las escenas manuales (alertas, SLO) usan `ObsKit` con el `Clock` de `NetKit`.

**Tech Stack:** reveal.js 5.1.0, GSAP 3.12.5, Chart.js 4.4.1 (en `vendor/`), SVG a mano, scripts clásicos con globals. Pruebas con puppeteer-core de `presentaciones-guideline/tools`. Laboratorio: Docker Compose, Node 20, Postgres 16, OpenTelemetry Collector, Prometheus, Alertmanager, Grafana, Loki, Tempo y k6.

**Spec:** `docs/superpowers/specs/2026-11-13-monitoreo-design.md`

## Global Constraints

- Todo el texto visible y las notas en español con tildes. El tono es el de la serie.
- Se abre con doble clic y funciona offline. Sin CDN y sin ES modules. Orden de scripts: reveal → notes → gsap → chart → `sim.js` → `obs.js` → `shopsim.js` → `widgets.js` → `scenes.js` → `main.js`.
- Lienzo de 1280×720. El panel mide 566px de alto y no puede desbordar. No usar la clase `.controls`; los botones van en `.actions`.
- Cada slide tiene `aside.notes` con guion y al menos una pregunta (`?`).
- Vocabulario de la tienda: Usuarios, Órdenes, Pagos, Envíos. No se nombran productos (Prometheus, Grafana, etc.) antes de la slide 18 "Herramientas reales".
- Colores de la serie: request `#7dd3fc`, ok `#4ade80`, lenta `#facc15`, error `#f87171`, servicios cian, DB verde agua. Propios de este deck, fijos en todo el deck: métricas violeta `#a78bfa`, logs gris `#cbd5e1`, trazas naranja `#fb923c`, alerta disparada rojo con pulso, reacción automática azul `#60a5fa` con ícono 🤖.
- Toda aleatoriedad pasa por un `rng(seed)` sembrado (mulberry32, el de `presentacion-cache/js/cache.js`). Los efectos se ven siempre igual.
- El tiempo de simulación sale de `Clock` (`now += dt × Speed.value`). Nunca `setTimeout`/`setInterval` para la dinámica.
- Repo `gastonprieto/presentacion-monitoreo`. En la portada va `github.com/gastonprieto/presentacion-monitoreo`. La slide final "Seguir explorando" lleva el QR a `https://gastonprieto.github.io/presentacion-monitoreo/` y el preset **load-balancer**, sin prometer health checks en el playground.
- **No crear el repo remoto ni hacer push**: el autor revisa en local primero. Solo `git init` y commits locales.
- Imágenes Docker con tag fijo. Verificar la configuración de cada herramienta del laboratorio con `npx ctx7@latest` antes de escribirla.

## Review Focus

1. **Cambiar la velocidad (🐢/🐇) o pausar la pestaña a mitad del incidente** no tiene que cambiar los números: dos corridas con distinta `Speed.value` dan las mismas métricas a igual tiempo de simulación. Lo prueba la Task 3.
2. **Apretar "reset" o salir de la slide mientras corre un backoff de reinicio, un enfriamiento del autoscaler o un breaker abierto** no deja timers huérfanos. Después del reset no aparecen reinicios ni réplicas nuevas. Lo prueba la Task 4.
3. **Apretar "romper Pagos" varias veces seguidas, o romper y arreglar rápido**, deja un estado consistente: la falla es idempotente y "arreglar" vuelve a los números sanos. Lo prueba la Task 3.
4. **Celular (400px)**: el stream de logs, la cascada de la traza y el mini dashboard se leen y sus botones reciben el toque. Lo prueban la Task 6 (widgets) y la Task 10 (`mobile.js`).
5. **Panel de 566px** con dashboards, sliders y texto: ninguna slide desborda. Lo prueba `smoke.js` al final de cada task de slides.

---

### Task 1: Esqueleto del deck

**Files:**
- Create: `presentacion-monitoreo/` con el contenido de `presentaciones-guideline/template/` (`index.html`, `css/`, `js/`, `vendor/`, `img/`, `CLAUDE.md`).
- Create: `tests/interact.js`, `README.md`, `.gitignore`.
- Modify: `index.html` (título, portada, outro, borrar slides de ejemplo), `js/scenes.js` (borrar escenas de ejemplo, incluida `S.manual`), `CLAUDE.md`, `img/qr.svg`.

**Interfaces:**
- Produces: el harness `tests/interact.js` con `open(page, idx, mobile)`, `goto(page, idx)`, `evalScene(page, idx, fn, ...args)`, `engine(page, fn, ...args)`, `check(cond, msg)` y `test(name, fn)`, copiados de `presentacion-cache/tests/interact.js`. Uso: `node tests/interact.js [filtro]`.

- [ ] **Step 1:** `git init` en `presentacion-monitoreo` (ya tiene `docs/`) y un commit inicial vacío (`git commit --allow-empty -m "Commit inicial"`). Después, un commit con `docs/`.
- [ ] **Step 2:** Copiar el template. En `index.html`:
  - `<title>Monitoreo y supervisión</title>`;
  - portada con kicker "Monitoreo y supervisión" y h1 "Enterarse antes que el usuario";
  - reemplazar `REPO` por `presentacion-monitoreo`;
  - en el outro, el preset `load-balancer`, con la frase "apagá una réplica y mirá qué pasa".
  
  Borrar las slides de ejemplo. Dejar portada, una slide placeholder por sección (con notas y pregunta) y el outro.
- [ ] **Step 3:** Regenerar `img/qr.svg` con el comando de segno de `GUIDELINE.md` §11 para `https://gastonprieto.github.io/presentacion-monitoreo/`. Decodificarlo (p. ej. `zbarimg` o `segno`/`pyzbar` en un venv del scratchpad) y confirmar la URL exacta.
- [ ] **Step 4:** Actualizar `CLAUDE.md` con el tema y la audiencia, en la misma forma que `presentacion-cache/CLAUDE.md`. La sección Arquitectura se completa en las Tasks 2 a 6.
- [ ] **Step 5:** Crear `tests/interact.js` con el harness y dos pruebas: `base: carga sin errores de consola` y `notas: todas las slides tienen pregunta` (las mismas del deck de caché). Agregar `outro: link al repo y preset`: verifica que `a.repo-link` apunte a `https://github.com/gastonprieto/presentacion-monitoreo` y que el outro contenga `load-balancer` y `architecture-playground`.
- [ ] **Step 6:** Correr `node tests/interact.js`, `node smoke.js ../../presentacion-monitoreo` y `node mobile.js ../../presentacion-monitoreo` desde `presentaciones-guideline/tools`. Todo tiene que salir en verde. Mirar `png/d00.png` y la captura del outro.
- [ ] **Step 7:** Commit: `Esqueleto del deck desde el template`.

### Task 2: ObsKit, métricas y alertas

**Files:**
- Create: `js/obs.js`
- Modify: `index.html` (script), `tests/interact.js`

**Interfaces:**
- Produces (en `window.ObsKit`):
  - `rng(seed) → () => number` en [0,1).
  - `percentile(values: number[], p: number) → number`: método nearest-rank; con un arreglo vacío devuelve 0.
  - `class MetricWindow({ span })`:
    - `add(t, { latency, ok })`;
    - `stats(now) → { n, rps, errPct, avg, p50, p95, p99 }`: considera solo las muestras con `t > now - span`; `errPct` va de 0 a 100 y las latencias están en segundos.
  - `class AlertRule({ threshold, forSec, above = true })`:
    - `step(t, value) → 'ok' | 'pending' | 'firing'`;
    - `evaluate(series: [t, value][]) → { firings: [start, end][] }`.
    
    `firing` arranca cuando el valor sigue del lado malo del umbral durante `forSec` seguidos. Vuelve a `ok` ni bien cruza de vuelta.
  - `classifyAlerts(firings, incidents: [start, end][]) → { caught, missed, falsePos }`. Un firing que se superpone con un incidente lo atrapa. Un incidente sin firing superpuesto cuenta como perdido. Un firing sin incidente es un falso positivo.
  - `class ErrorBudget({ slo, windowSec })`:
    - `add(t, ok)`;
    - `state(now) → { total, bad, allowed, remainingPct, burnRate }`, con `allowed = (1 - slo) × total` y `burnRate = (bad/total) / (1 - slo)`.

- [ ] **Step 1: Pruebas que fallan**, con `engine()` sobre `window.ObsKit`:
  - `obs: percentiles`: para `[1..100]`, p50 = 50, p95 = 95, p99 = 99; `percentile([], 95) === 0`.
  - `obs: ventana descarta lo viejo`: span 5. Muestras en t = 1 (lat 10) y t = 8 (lat 1). `stats(9).n === 1` y `avg === 1`.
  - `obs: el promedio esconde la cola`: 1000 muestras, 95% con 0,1 s y 5% con 2 s. `avg < 0,25` y `p99 ≥ 2`.
  - `obs: alerta con ventana`: umbral 5, `forSec` 3, serie por segundo `[0,9,0,9,9,9,9,0]`. Exactamente un firing, que empieza en t = 6 (el pico de t = 1 no dispara).
  - `obs: clasificar alertas`: firings `[[2,3],[10,12]]` e incidentes `[[10,15],[20,25]]` → `{ caught: 1, missed: 1, falsePos: 1 }`.
  - `obs: presupuesto de error`: slo 0,99. 1000 eventos con 20 malos → `allowed = 10`, `burnRate = 2`, `remainingPct ≤ 0` (acotado a −100).
- [ ] **Step 2:** `node tests/interact.js obs:`. Esperado: FAIL (`ObsKit` no existe).
- [ ] **Step 3:** Implementar las piezas de arriba en `js/obs.js` (IIFE, `'use strict'`, comentario de cabecera como en `cache.js`). Cargarlo en `index.html` después de `sim.js`.
- [ ] **Step 4:** `node tests/interact.js obs:`. Esperado: PASS.
- [ ] **Step 5:** Commit: `ObsKit: ventana de métricas, alertas y SLO`.

### Task 3: ObsKit, reacciones automáticas

**Files:**
- Modify: `js/obs.js`, `tests/interact.js`

**Interfaces:**
- Produces (en `window.ObsKit`):
  - `class Supervisor({ policy: 'no'|'on-failure'|'always', base = 1, factor = 2, cap = 16, resetAfter = 10 })`:
    - `onExit(t, failed: boolean) → number | null`: segundos hasta el próximo arranque, o `null` si no reinicia;
    - `onHealthy(t)`;
    - getter `state → 'running'|'backoff'|'stopped'`;
    - `restarts: number`.
    
    El backoff crece `base × factor^k` hasta `cap`. Vuelve a `base` si el proceso estuvo sano `resetAfter` segundos.
  - `class Autoscaler({ min = 1, max = 6, target, cooldown = 8, startup = 3 })`:
    - `step(t, metricPerReplica: number, replicas: number) → number`: devuelve las réplicas deseadas, con `desired = ceil(replicas × metric / target)` acotado a [min, max];
    - entre dos cambios pasa al menos `cooldown`.
    
    `startup` lo usa ShopSim para la demora de la réplica nueva.
  - `class CircuitBreaker({ failures = 5, openFor = 5 })`:
    - `allow(t) → boolean`;
    - `record(t, ok)`;
    - getter `state → 'closed'|'open'|'half'`.
    
    Pasa de closed a open con `failures` fallas seguidas. De open pasa a half después de `openFor`. En half deja pasar una prueba: si sale ok se cierra, si falla vuelve a abrirse.

- [ ] **Step 1: Pruebas que fallan:**
  - `obs: crash loop con backoff`: policy `on-failure`. Cinco `onExit(t, true)` seguidos devuelven `[1,2,4,8,16]` y el sexto devuelve 16. Con policy `no`, `onExit` devuelve `null`.
  - `obs: backoff se resetea si estuvo sano`: tras dos fallas, `onHealthy` y luego `onExit` 11 s después → 1.
  - `obs: autoscaler respeta cooldown y límites`: target 0,7. Con `step(0, 1.4, 1)` → 2. `step(3, 1.4, 2)` → 2 (cooldown). `step(9, 1.4, 2)` → 4. Una métrica enorme → nunca más de 6. Una métrica 0 → nunca menos de 1.
  - `obs: breaker abre, prueba y cierra`: 5 fallas → `open` y `allow` false. En t + 5 → `half` y un `allow` true; el segundo `allow` es false. Con `record(ok)` → `closed`.
- [ ] **Step 2:** `node tests/interact.js obs:`. Esperado: las nuevas fallan.
- [ ] **Step 3:** Implementar las tres clases en `js/obs.js`.
- [ ] **Step 4:** `node tests/interact.js obs:`. Esperado: PASS.
- [ ] **Step 5:** Commit: `ObsKit: supervisor, autoscaler y circuit breaker`.

### Task 4: ShopSim, la tienda que emite señales

**Files:**
- Create: `js/shopsim.js`
- Modify: `index.html` (script), `css/theme.css` (estilos de nodos y estados), `tests/interact.js`

**Interfaces:**
- Consumes: `NetKit.{ Clock, Speed, svgEl, cubic, curve, edge, pop, C, MOBILE, W, H }` y `ObsKit.{ rng, MetricWindow }`.
- Produces: `window.ShopSimKit = { ShopSim, DEFAULTS, COL }`.
  - `new ShopSim(svg, opts)`.
  - `DEFAULTS` (calibración inicial; el builder la ajusta para que los efectos se vean siempre):
    - `seed: 1`, `rate: 6`;
    - `pool: 6`, `dbTime: 0.25`, `dbMax: 12` (la DB contesta más lento cuando hay más de `dbMax` consultas a la vez: `dbTime × max(1, activas/dbMax)`);
    - `poolWait: 2` (esperar conexión más de 2 s → `timeout acquiring db connection`, 503);
    - `ordenesTime: 0.05`, `enviosTime: 0.08`;
    - `replicas: 1`;
    - `fault: null` (`'slowdb'` multiplica `dbTime` × 6; `'hang'` deja a Pagos sin responder con el proceso vivo; `'crash'` hace que Pagos falle al arrancar);
    - `slowRatio: 0`, `slowFactor: 10` (para la slide de percentiles);
    - `travel: 0.48`, `showPool: false`, `clickToTrace: false`.
  - API:
    - `on('tick'|'reset'|'log'|'trace'|'request', fn)`, `start()`, `stop()`, getter `now`, `reset(opts)` (sube `gen` y limpia timers y estado);
    - `set(key, value)` en vivo;
    - `breakPagos(fault)` y `heal()`: idempotentes;
    - `window(sec, service = 'checkout') → { n, rps, errPct, avg, p50, p95, p99, sat }`, con `service` ∈ `'checkout'|'ordenes'|'pagos'|'envios'`. `sat` es la fracción del pool en uso, promediada en la ventana; solo tiene sentido para Pagos;
    - `logs: { t, level: 'info'|'warn'|'error', service, replica, msg, orderId, traceId }[]` (ring de 300);
    - `traces: { traceId, orderId, start, spans: { service, start, end, ok }[] }[]` (últimas 50);
    - `fastForward(sec)`: avanza el reloj sin dibujar, para las pruebas.
  - Cada pedido de un usuario es un checkout con `orderId` incremental (`#1001`, …) y un `traceId` de 8 hex. Las latencias en `window` son tiempo de servicio, sin el viaje animado (GUIDELINE §6).
  - Dibujo: horizontal 900×590 en escritorio y vertical 400×440 en celular (`NetKit.MOBILE`). Si `showPool`, el pool de Pagos se ve como N casilleros.

- [ ] **Step 1: Pruebas que fallan** (motor con `engine()` y `fastForward`):
  - `shop: sano`: con los defaults, `fastForward(30)` → `window(10,'checkout').errPct < 1` y `window(10,'pagos').sat < 0.8`.
  - `shop: slowdb satura el pool`: `breakPagos('slowdb')` + `fastForward(30)` → `pagos.sat ≥ 0.95`, `checkout.errPct > 5` y `checkout.p95 > 3 ×` el p95 sano.
  - `shop: primero la latencia, después los errores`: tras romper, el primer segundo con `p95` mayor al doble del sano llega antes que el primero con `errPct > 1`.
  - `shop: logs del incidente`: tras `slowdb`, existe un log `level === 'error'` en `service === 'pagos'` cuyo `msg` contiene `timeout acquiring db connection`, con `orderId` y `traceId`. Además, todo log tiene `traceId`.
  - `shop: la traza muestra dónde`: tras `slowdb`, una traza OK reciente tiene spans `ordenes`, `pagos`, `envios`, y el span de pagos dura más del 70% del total.
  - `shop: arreglar vuelve a sano` (Review Focus 3): `breakPagos('slowdb')` tres veces, `heal()` y `fastForward(40)` → `window(10).errPct < 1`.
  - `shop: la velocidad no cambia los números` (Review Focus 1): dos sims con la misma seed, una con `Speed.value = 0.25` y otra con `1.5`, `fastForward(30)` → mismo `window(10,'checkout')`.
  - `shop: reset limpia todo`: tras romper y avanzar, `reset()` → `logs.length === 0`, `traces.length === 0` y `fault === null`.
- [ ] **Step 2:** `node tests/interact.js shop:`. Esperado: FAIL.
- [ ] **Step 3:** Implementar `ShopSim` en `js/shopsim.js`, con la forma de `presentacion-cache/js/cachesim.js` (constructor, `reset`, `_build`, `_frame`, `fastForward`). Ajustar los defaults si un efecto no se ve con margen.
- [ ] **Step 4:** `node tests/interact.js shop:`. Esperado: PASS.
- [ ] **Step 5:** Commit: `ShopSim: tienda con métricas, logs y trazas`.

### Task 5: ShopSim, reacciones automáticas

**Files:**
- Modify: `js/shopsim.js`, `tests/interact.js`

**Interfaces:**
- Consumes: `ObsKit.{ Supervisor, Autoscaler, CircuitBreaker }`.
- Produces: opciones nuevas en `ShopSim`:
  - `liveness: false`, `readiness: false`, `hcInterval: 1`, `hcFall: 2`, `warmup: 0` (segundos que tarda una réplica en estar lista);
  - `restartPolicy: 'no'` (se pasa al `Supervisor` de cada réplica), `restartTime: 2`;
  - `autoscale: null | { target, min, max, cooldown, startup }` (la métrica es `sat` por réplica);
  - `timeout: null` (segundos que Órdenes espera a Pagos), `breaker: null | { failures, openFor }`, `retries: 0`.
- Produces: estado expuesto por réplica, `replicaState(i) → { up, ready, restarts, backoffUntil }`, y getter `replicaCount`. También el evento `'react'` con `{ t, kind: 'restart'|'scale'|'remove'|'breaker', detail }`, que el dibujo muestra con el ícono 🤖.

- [ ] **Step 1: Pruebas que fallan:**
  - `react: liveness reinicia lo colgado`: `liveness:true`, `restartPolicy:'always'`, `breakPagos('hang')`. Antes de `hcInterval × hcFall + restartTime + 1` s hubo un `'react'` restart y, después del reinicio, `errPct` de la ventana de 5 s baja a menos de 5. Sin liveness, `errPct > 50` a los 15 s.
  - `react: readiness no manda tráfico al que arranca`: 2 réplicas, `readiness:true`, `warmup:5`. Al reiniciar la réplica 1, durante 5 s no recibe pedidos y el checkout no suma errores.
  - `react: crash loop`: `restartPolicy:'on-failure'`, `breakPagos('crash')`. Los reinicios ocurren con esperas crecientes `[1,2,4,8]` (± 0,1 s).
  - `react: autoscaling con pico sano`: sin falla, `rate:6 → 20`, `autoscale:{ target:0.7, min:1, max:6, cooldown:8, startup:3 }`. A los 40 s, `replicaCount ≥ 3` y `window(10).errPct < 2`.
  - `react: escalar empeora el incidente del pool`: con `slowdb`, comparar `replicas:1` contra `replicas:3`. Con 3 réplicas el p95 de la DB sube (más consultas que `dbMax`) y `checkout.errPct` no mejora más de 2 puntos.
  - `react: breaker falla rápido`: `breakPagos('hang')`. El p95 de Órdenes queda ordenado así: breaker < solo timeout (2 s) < sin timeout. Con breaker, `state` pasa por `open` y `half`.
  - `react: reintentos multiplican la carga`: `slowdb`, `retries:2` → la tasa de pedidos que llegan a Pagos es ≥ 2× la de checkout.
  - `react: reset corta backoff y enfriamiento` (Review Focus 2): con crash loop o autoscaler en curso, `reset()` + `fastForward(30)` → ningún evento `'react'` posterior al reset y `replicaCount === 1`.
- [ ] **Step 2:** `node tests/interact.js react:`. Esperado: FAIL.
- [ ] **Step 3:** Implementar las opciones en `ShopSim`, programando todo con el `Clock` (lo que `reset` limpia).
- [ ] **Step 4:** `node tests/interact.js` completo. Esperado: PASS.
- [ ] **Step 5:** Commit: `ShopSim: health checks, supervisor, autoscaling y circuit breaker`.

### Task 6: Widgets de dashboard

**Files:**
- Modify: `js/widgets.js` (agregar; sacar los widgets del template que no se usen), `css/theme.css`, `tests/interact.js`

**Interfaces:**
- Consumes: eventos `'tick'|'reset'|'log'|'trace'` y `window()`, `logs` y `traces` de `ShopSim`.
- Produces (en `window.Widgets`, conectados por `setupShop` en la Task 7):
  - `svcStats(el, sim)`: para `.sstats[data-service][data-fields][data-window]`; los fields salen de `n,rps,errPct,avg,p50,p95,p99,sat`.
  - `svcChart(canvas, sim, { service, fields })`: para `canvas.svc-chart`; series en el tiempo, por defecto `p95` y `errPct` con dos ejes.
  - `logStream(el, sim)`: para `.logs`. Filtro por nivel (`[data-level]`), búsqueda por `orderId` (`input.log-search`) y modo `data-format="text"|"json"`. Muestra las últimas 40 líneas.
  - `traceView(el, sim, traceId?)`: para `.trace`. Cascada de spans con colores por servicio y el span más largo resaltado. Sin `traceId` muestra la última traza.

- [ ] **Step 1: Pruebas que fallan:**
  - `widget: logs filtra por nivel y pedido`: con una slide de prueba armada en la página, filtrar `error` → todas las líneas visibles son error. Buscar un `orderId` → todas las líneas contienen ese id.
  - `widget: logs en json`: con `data-format="json"`, cada línea parsea con `JSON.parse` y tiene `traceId`.
  - `widget: cascada resalta pagos`: tras `slowdb`, el span resaltado de `.trace` es el de `pagos`.
  - `widget: legibles en celular` (Review Focus 4): con `?mobile=1`, `.logs` y `.trace` no generan scroll horizontal (`scrollWidth ≤ clientWidth + 1`) y sus controles reciben el toque (`elementFromPoint`).
- [ ] **Step 2:** `node tests/interact.js widget:`. Esperado: FAIL.
- [ ] **Step 3:** Implementar los cuatro widgets. Los gráficos se crean lazy al activar la escena (gotcha 8) y usan su propia clase de canvas (gotcha 3).
- [ ] **Step 4:** `node tests/interact.js widget:`. Esperado: PASS.
- [ ] **Step 5:** Commit: `Widgets: dashboard, logs y cascada de trazas`.

### Task 7: Slides 1–5, el problema y las métricas

**Files:**
- Modify: `index.html`, `js/scenes.js`, `css/theme.css`, `tests/interact.js`

**Interfaces:**
- Consumes: `ShopSim` y los widgets.
- Produces: helpers en `scenes.js` para las tasks siguientes:
  - `setupShop(slide, opts) → sim`: crea `ShopSim` sobre `svg.sim` y conecta los widgets que encuentre;
  - `breakButtons(slide, sim)`: conecta `[data-act=break]` (con `data-fault`) y `[data-act=heal]`;
  - `rateSlider`, `on`, `seg`, `showModeIn`, `life`, `manual`, `hstats`: los mismos del deck de caché.

  Cada escena guarda en `section._scene` un objeto con `sim` o `ff(sec)` + `state()`, para las pruebas.

Slides, según la tabla del spec:
1. `sinsenales`: "Todo anda… ¿o no?". Botón romper y slider de tráfico. La queja de un usuario aparece ~8 s (de simulación) después del primer error, como globo genérico sin marcas.
2. "¿Anda mal? ¿Qué pasó? ¿Dónde?": estática con fragmentos, tres columnas con el color de cada señal.
3. `metricas`: "Contar y medir". Mini dashboard por servicio y una viñeta por tipo (contador, gauge, histograma).
4. `percentiles`: "El promedio esconde la falla". Slider de % lentos (0–20) y avg/p50/p95/p99 visibles.
5. `doradas`: "Latencia, tráfico, errores, saturación". `showPool:true`, slider de tráfico y de tamaño del pool.

- [ ] **Step 1: Pruebas que fallan:**
  - `escena sinsenales: la queja llega después del error`: romper → el primer error y la queja ocurren en ese orden, separados por ≥ 5 s.
  - `escena percentiles: subir % lentos mueve p99 y no el promedio`: de 0 a 5% → p99 × 5 o más y avg < × 1,5.
  - `escena doradas: la saturación llega antes que los errores`: romper → `sat ≥ 0.95` antes de `errPct > 1`.
- [ ] **Step 2:** `node tests/interact.js escena`. Esperado: FAIL.
- [ ] **Step 3:** Implementar las slides (kicker + título + demo + panel + notas con pregunta) y sus escenas.
- [ ] **Step 4:** `node tests/interact.js`, `node smoke.js …` y `node mobile.js …` en verde. Mirar las capturas `d01–d05` y `m01–m05`.
- [ ] **Step 5:** Commit: `Slides 1–5: el problema y las métricas`.

### Task 8: Slides 6–9, logs, trazas y "las tres juntas"

**Files:**
- Modify: `index.html`, `js/scenes.js`, `css/theme.css`, `tests/interact.js`

Slides:
6. `logs`: "Qué pasó en este pedido". Stream con filtro de nivel, buscador de pedido y romper.
7. `centralizar`: "Estructurados y en un solo lugar". 3 réplicas de Pagos. El seg "por réplica / central" muestra tres streams chicos o uno solo; el seg "texto / estructurado" cambia `data-format`. Con "por réplica", buscar un pedido muestra resultados en una sola de las tres cajas.
8. `trazas`: "Seguir un pedido entre servicios". `clickToTrace:true`: el clic en un punto en viaje abre su cascada. Con romper, la cascada muestra el span de Pagos largo.
9. `tresjuntas`: "De la métrica a la traza, de la traza al log". Gráfico de p95 → clic en un momento → lista de trazas de ese segundo → clic en una → cascada → clic en el span de Pagos → logs de ese `traceId`.

- [ ] **Step 1: Pruebas que fallan:**
  - `escena centralizar: por réplica el pedido aparece en una sola caja`.
  - `escena trazas: el clic abre la traza de ese pedido` (el `orderId` de la cascada coincide con el del punto clickeado).
  - `escena tresjuntas: el recorrido llega a logs del mismo trace`: después del recorrido por clics, todos los logs visibles comparten el `traceId` elegido y al menos uno es el `timeout acquiring db connection`.
- [ ] **Step 2:** Correr y ver que fallen.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `interact`, `smoke` y `mobile` en verde. Revisar capturas.
- [ ] **Step 5:** Commit: `Slides 6–9: logs, trazas y de la métrica al log`.

### Task 9: Slides 10–12, alertas y SLO

**Files:**
- Modify: `index.html`, `js/scenes.js`, `css/theme.css`, `tests/interact.js`

**Interfaces:**
- Consumes: `ObsKit.{ AlertRule, classifyAlerts, ErrorBudget, rng }` y `manual`/`hstats`.

Slides (escenas manuales con `Clock`; la serie es generada y sembrada, con ruido y un incidente real fijo):
10. `umbral`: "¿Cuándo avisar?". Slider de umbral y seg de ventana (0 / 1 / 3 / 5 min de juego). Marca falsas alarmas (ámbar) e incidentes perdidos (rojo hueco), con contadores `caught/missed/falsePos`.
11. `sintoma`: "Avisar por síntoma, no por causa". Switches por alerta (CPU, memoria, réplica caída, error rate de checkout) y contador "alertas por noche" sobre una noche simulada (`ff`).
12. `slo`: "Cuánto fallar está permitido". Seg de objetivo (99 / 99,5 / 99,9). Barra de presupuesto que se consume, burn rate y alerta por velocidad de consumo. Romper Pagos la acelera.

- [ ] **Step 1: Pruebas que fallan:**
  - `escena umbral: hay un punto medio`: umbral muy bajo → `falsePos ≥ 3`; muy alto → `missed ≥ 1`; con el umbral y la ventana sugeridos (valor inicial de la slide) → `{ caught: 1, missed: 0, falsePos: 0 }`.
  - `escena sintoma: las de causa hacen ruido`: noche sin incidente → solo alertas de causa > 0 y la de síntoma = 0. Noche con incidente → la de síntoma ≥ 1.
  - `escena slo: romper acelera el consumo`: `burnRate` roto > 5 × `burnRate` sano. Con 99,9 se agota antes que con 99.
- [ ] **Step 2:** Correr y ver que fallen.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `interact`, `smoke` y `mobile` en verde. Revisar capturas.
- [ ] **Step 5:** Commit: `Slides 10–12: alertas y SLO`.

### Task 10: Slides 13–17, reaccionar solo

**Files:**
- Modify: `index.html`, `js/scenes.js`, `css/theme.css`, `tests/interact.js`

Slides (todas con `ShopSim` y las opciones de la Task 5; la reacción se marca con 🤖 azul):
13. `health`: "¿Está vivo? ¿Está listo?". Botones colgar Pagos y deploy lento, y seg liveness / readiness / ambos.
14. `supervisor`: "Si se cae, levantalo". Botones romper una vez y bug al arrancar, seg de política (`no`, `on-failure`, `always`) y la línea de tiempo de reinicios con el backoff visible.
15. `autoscaling`: "Sumar réplicas con la carga". Slider de tráfico, de umbral (target) y de enfriamiento, y un gráfico de réplicas vs. carga. Con enfriamiento 0 y umbral bajo, oscila.
16. `breaker`: "Cortar a tiempo". Seg sin / timeout / breaker, romper (colgar) Pagos y el estado del breaker visible (cerrado / abierto / medio abierto).
17. `limites`: "Cuando lo automático empeora las cosas". Incidente `slowdb` y seg reiniciar / escalar / reintentos. Cada modo muestra su consecuencia (alivia y vuelve, satura la DB, multiplica la carga).

- [ ] **Step 1: Pruebas que fallan** (pruebas de escena que reusan las condiciones de la Task 5 a través de los controles de la slide):
  - `escena health`: con liveness, colgar → reinicio (🤖) y recuperación.
  - `escena supervisor`: bug al arrancar con `on-failure` → la línea de tiempo muestra ≥ 4 reinicios con esperas crecientes.
  - `escena autoscaling`: subir el tráfico → `replicaCount` sube. Enfriamiento 0 y umbral bajo → al menos 3 cambios de dirección en 60 s.
  - `escena breaker`: el p95 de Órdenes ordenado: breaker < timeout < sin.
  - `escena limites`: escalar → el p95 de la DB sube respecto de reiniciar; reintentos → carga en Pagos ≥ 2× checkout.
- [ ] **Step 2:** Correr y ver que fallen.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `interact`, `smoke` y `mobile` en verde. Revisar capturas.
- [ ] **Step 5:** Commit: `Slides 13–17: reaccionar solo y sus límites`.

### Task 11: Cierre, pulido y documentación

**Files:**
- Modify: `index.html`, `css/theme.css`, `js/scenes.js` (portada animada), `CLAUDE.md`, `README.md`, `tests/interact.js`

- [ ] **Step 1:**
  - Slide 18 "Herramientas reales": fragmentos por familia (métricas, logs, trazas, alertas, reacción) con los productos del spec y un puente al laboratorio.
  - Slide 19 "Lo que nos llevamos": seis ideas en `.summary`.
  - Portada con fondo animado (`S.title`, como el template) y outro final.
- [ ] **Step 2:** Prueba `notas: todas las slides tienen pregunta` y la de outro, en verde. Agregar `slides: hay 21 secciones con títulos del spec`, que compara los títulos h1/h2 con la lista de la tabla del spec (permitiendo las fusiones que se hayan hecho, anotadas en el test).
- [ ] **Step 3:** `CLAUDE.md` con la arquitectura final (`ObsKit`, `ShopSim`, widgets y escenas manuales), con la forma del de caché. En el `README.md`, qué es, cómo abrirla, cómo probar y un placeholder para la sección del laboratorio (Task 12).
- [ ] **Step 4:** Recorrida completa: `node tests/interact.js`, `node smoke.js …` y `node mobile.js …` en verde. Mirar todas las capturas `dNN` y `mNN`, buscando superposiciones, texto que se sale y efectos que no se ven.
- [ ] **Step 5:** Commit: `Cierre, resumen y documentación`.

### Task 12: Laboratorio con Docker

**Files:**
- Create:
  - `docker-compose.yml` (`name: lab-monitoreo`);
  - `lab/servicio/{Dockerfile,package.json,server.js,otel.js}`;
  - `lab/db/init.sql`;
  - `lab/otel/collector.yaml`;
  - `lab/prometheus/{prometheus.yml,rules.yml}`;
  - `lab/alertmanager/alertmanager.yml`;
  - `lab/grafana/provisioning/{datasources,dashboards}/…`, más `lab/grafana/dashboards/tienda.json`;
  - `lab/carga/checkout.js` (k6).
- Modify: `README.md` (sección "Laboratorio con Docker").

**Decisiones del plan:**
- Una sola imagen `lab/servicio`, usada tres veces con `SERVICIO=ordenes|pagos|envios` y `SIGUIENTE=<url>`. Pagos usa `pg` con `POOL=4`.
- Endpoints para romper: `POST /romper?modo=lento|colgado|crash` y `POST /arreglar`. `crash` deja una marca en un volumen para que falle al arrancar hasta `arreglar`.
- `restart: on-failure` y un `healthcheck` (GET `/salud` con timeout de 1 s) en Pagos.
- Instrumentación con el SDK de Node de OpenTelemetry (auto-instrumentación http/express/pg). Logs JSON con `trace_id`, por OTLP al collector.
- Collector → Prometheus (scrape del exporter), Tempo (trazas), Loki (logs). Grafana con los tres datasources provisionados y el dashboard "Tienda" con las cuatro señales doradas por servicio.
- `rules.yml`: `CheckoutErrores` (síntoma: error rate de checkout > 5% durante 1 m) y `PagosCPUAlta` (causa). Alertmanager con un receptor que solo loguea (webhook a un contenedor echo, o el `null` receiver), visible en su UI.
- Autoscaling: queda afuera del laboratorio. El README lo explica y muestra `docker compose up --scale pagos=3` a mano, para ver que con `lento` empeora la DB (la slide 17 con piezas reales).
- Puertos: tienda 8080 (Órdenes), Grafana 3000, Prometheus 9090, Alertmanager 9093.

- [ ] **Step 1:** Verificar con ctx7 la configuración vigente del collector (receivers OTLP, exporters prometheus/otlp/loki), de los datasources de Grafana para Tempo y Loki, y del SDK de Node. Fijar los tags de imagen.
- [ ] **Step 2:** Escribir los servicios y `docker compose up -d --build`. Esperado: todo `healthy`/`running` y `curl -s localhost:8080/checkout` responde 200.
- [ ] **Step 3:** Escribir telemetría, Prometheus, Alertmanager y Grafana. Esperado:
  - el dashboard muestra tráfico con `k6 run lab/carga/checkout.js` (o `docker compose run carga`);
  - una traza en Tempo con spans ordenes/pagos/envios;
  - logs en Loki con `trace_id`.
- [ ] **Step 4:** Recorrido de romper:
  - `lento` → sube el p95 y se dispara `CheckoutErrores` (visible en Alertmanager);
  - `colgado` → el healthcheck lo marca `unhealthy` (Compose no reinicia por unhealthy: el README lo explica como diferencia con la liveness de Kubernetes);
  - `crash` → reinicios crecientes en `docker compose ps` / `docker events`.
  
  Anotar los comandos reales en el README.
- [ ] **Step 5:** README: requisitos, cómo levantarlo, recorrido por slide y la tabla "Romper cosas" (como en proxy reverso y caché). Si el stack completo pasa los ~4 GB de RAM, marcar Loki como opcional (profile `logs`).
- [ ] **Step 6:** `docker compose down -v`, otro `up -d --build` desde cero y el recorrido del README completo.
- [ ] **Step 7:** Commit: `Laboratorio con Docker: telemetría, alertas y reinicios`.

### Task 13: Verificación final y entrega para revisión local

- [ ] **Step 1:** `node tests/interact.js`, `node smoke.js …` y `node mobile.js …` en verde. Pegar la salida en el resumen.
- [ ] **Step 2:** Decodificar `img/qr.svg` → `https://gastonprieto.github.io/presentacion-monitoreo/`.
- [ ] **Step 3:** `open -a "Google Chrome" presentacion-monitoreo/index.html` y avisarle al autor que está lista para revisar. **No crear el repo remoto ni hacer push** hasta su OK. Con el OK, seguir `GUIDELINE.md` §11 (repo público, Pages desde `main` raíz, push por HTTPS).
