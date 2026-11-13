# Presentación: Monitoreo y supervisión — diseño

Fecha: 2026-11-13 · Carpeta: `~/projects/personal/presentacion-monitoreo`

## Intención

Una presentación interactiva sobre **cómo un sistema se vigila solo**: que te enteres de una falla antes que el usuario y que, cuando se puede, el sistema reaccione sin esperar a una persona. El recorrido es **medir → avisar → reaccionar solo**:

- **Medir**: métricas, logs y trazas. Cada señal contesta una pregunta distinta: si algo anda mal, qué pasó y dónde.
- **Avisar**: alertas, con umbral, ventana de tiempo y el costo de avisar de más o de menos.
- **Reaccionar solo**: health checks, un supervisor que reinicia, autoscaling y circuit breaker. También cuándo lo automático empeora las cosas.

El autor pidió "cosas automatizadas" y confirmó que incluye que el sistema reaccione solo, no solo que avise a una persona.

Lo que la clase tiene que llevarse es **criterio**, no una lista de herramientas: qué señal mirar para cada pregunta, cuándo una alerta sirve y cuándo hace ruido, y qué reacción automática conviene (y cuál esconde o agrava el problema).

## Lugar en la serie y audiencia

Es parte de la serie (load balancer → microservicios → proxy reverso → colas → eventos, más caché) **sin lugar fijo**. Tiene que ser **autocontenida**, como la de caché: si aparece un load balancer, un proxy o una cola, se explica en una línea. Usa el vocabulario de la serie (la **tienda**: Usuarios, Órdenes, Pagos, Envíos), el mismo estilo y los mismos colores. En las notas del orador puede haber puentes opcionales ("en load balancer vimos p95; acá lo usamos para alertar").

Duración (propuesta mía, revisable): **unas 2 horas**, como la de caché → ~20 slides.

## Enfoque elegido: un mismo incidente atraviesa todo el deck

Opciones consideradas:

- **A. Un incidente atraviesa el deck (elegida por el autor).** La tienda anda bien y Pagos empieza a degradarse. Cada slide muestra **esa misma falla** con otra herramienta: la métrica (sube el p95 y los errores), el log (timeouts), la traza (el tiempo se va en Pagos), la alerta que suena y la reacción automática. Cada slide sigue siendo autónoma: tiene su propia demo y su botón para romper. Gana el "es la misma falla vista de tres formas". El costo es mantener las demos coherentes con un solo escenario.
- **B. Slides independientes, una idea por demo**, como los decks anteriores. Es más simple, pero se pierde el hilo.
- **C. Dos decks (observabilidad / auto-remediación).** Separa justo lo que se quiere mostrar junto: que lo automático se dispara a partir de lo que se mide.

### El incidente (propuesta mía)

**Pagos se queda sin conexiones a su base de datos.** El pool tiene un tamaño fijo. Cuando sube el tráfico, o una consulta se pone lenta, los pedidos esperan una conexión. Primero sube la latencia (p95/p99) y después aparecen timeouts (errores 5xx). El promedio casi no se mueve al principio.

Este incidente sirve para todo el recorrido:

- en las **métricas** se ve que sube el p95 y la tasa de errores de Pagos, y que la saturación (conexiones en uso) llega al 100%;
- en los **logs** aparece `timeout acquiring db connection` con el `order_id`;
- en la **traza** de un pedido, Órdenes → Pagos → Envíos, el span de Pagos ocupa casi todo el tiempo;
- la **alerta** por síntoma (error rate o p95 de checkout) suena, y una por causa (CPU) no;
- en **reaccionar solo**: reiniciar Pagos alivia un rato pero no arregla nada. Escalar Pagos lo **empeora**: más réplicas son más conexiones contra la misma base. El circuit breaker en Órdenes hace que la tienda falle rápido en vez de colgarse. Esto le da material concreto a "cuándo lo automático empeora las cosas".

Para las slides de reiniciar y de autoscaling hacen falta además dos variantes del mismo servicio: un Pagos que **se cuelga** (no responde, pero el proceso sigue vivo) y un pico de tráfico **sano** (más usuarios, sin falla), donde escalar sí ayuda.

## Objetivos

- Que se vea que **sin señales te enterás por el usuario**, y con señales, antes que él.
- Distinguir las tres señales por la pregunta que contestan y mostrar que se **complementan** sobre el mismo incidente (de la métrica a la traza y de la traza al log).
- Métricas: tipos (contador, gauge, histograma), las cuatro señales doradas (latencia, tráfico, errores, saturación) y por qué el promedio engaña.
- Logs: niveles, logs estructurados vs. texto libre, y por qué centralizarlos cuando hay varias réplicas.
- Trazas: trace id que viaja entre servicios, spans y la vista en cascada.
- Alertas: umbral + ventana ("más de 5% de errores durante 2 minutos"), falsos positivos vs. incidentes que se escapan, alertar por síntoma y no por causa, fatiga de alertas. SLO y presupuesto de error, al menos como idea.
- Reaccionar solo: liveness vs. readiness (reiniciar vs. sacar de rotación), supervisor con política de reinicio y backoff (crash loop), autoscaling sobre una métrica (demora, mínimo/máximo, enfriamiento, oscilación) y timeouts + circuit breaker.
- Que la automatización tiene **límites que se ven en demos**: reinicios que esconden un bug, autoscaling que empeora un cuello de botella compartido y reintentos que multiplican la carga.

## No-objetivos

- No es una clase de Prometheus, Grafana, ELK ni de ningún vendor (Datadog, New Relic). Se nombran en "Herramientas reales" y se usan en el laboratorio.
- No entra la parte humana del incidente: guardias, escalamiento, postmortems y runbooks quedan, a lo sumo, en una mención o en las notas.
- No se profundiza en el funcionamiento interno de Kubernetes (scheduler, HPA en detalle): se usan sus conceptos (probes, restart policy, autoscaling) con nombres genéricos y se aclara qué nombre tienen en k8s.
- No entra el monitoreo de infraestructura de bajo nivel (discos, red, kernel) más allá de la "saturación" como señal.
- No se desarrollan patrones de resiliencia aparte del circuit breaker y los timeouts (bulkheads, rate limiting y retries con jitter quedan como mención; en la slide 17 sí se ve, sin enseñarlo como patrón, que los reintentos multiplican la carga).

## Anti-objetivos (sería un fracaso aunque funcione)

- Que quede "más dashboards y más alertas = mejor". El ruido y la fatiga de alertas se tienen que **ver** en una demo.
- Que la automatización parezca magia o siempre buena. Al menos una demo tiene que mostrar que una reacción automática **empeora** el incidente.
- Que las tres señales parezcan tres temas sueltos. Tienen que verse sobre la misma falla.
- Que los efectos dependan de la suerte (p. ej. un umbral que a veces dispara y a veces no). Calibrar con semillas para que se vea siempre igual.
- Que se sienta como otra serie.

## Cómo se hace (decidido)

- Se copia `presentaciones-guideline/template` y se siguen `GUIDELINE.md` y su checklist (sección 12): reveal.js 5.1.0, GSAP 3.12.5 y Chart.js 4.4.1 en `vendor/`, scripts clásicos con globals, se abre con doble clic y funciona offline.
- Una idea por slide, kicker + título, demo a la izquierda y panel a la derecha, y notas del orador (guion + pregunta para la clase) en todas.
- Versión de celular (`html.mobile`).
- Pruebas: `node smoke.js` y `node mobile.js` desde `presentaciones-guideline/tools`, más un `tests/interact.js` propio (modelo del incidente, evaluador de alertas, supervisor, autoscaler, circuit breaker y escenas), como en caché.
- Colores de la serie: request en viaje celeste, ok verde, lenta amarillo, error rojo, servicios cian, DB verde agua. Las tres señales con color propio y fijo en todo el deck (decisión del builder; sugerido: métricas violeta, logs gris claro, trazas naranja). Alerta disparada en rojo con pulso y reacción automática con un ícono/color propio (sugerido: azul "robot").
- Portada con el link al repo `github.com/gastonprieto/presentacion-monitoreo` y slide final "Seguir explorando" (`section.outro`) con QR a la versión publicada, invitación al playground con el preset **load-balancer** (hay réplicas detrás de un balanceador para apagar una y ver qué pasa; el playground no tiene health checks, así que la invitación no los promete) y link al repo. El QR se genera con segno, como dice `GUIDELINE.md`.
- **Laboratorio con Docker** (`docker-compose.yml` + `lab/` + sección en el README), como en las otras.
- Publicación en GitHub Pages (`gastonprieto.github.io/presentacion-monitoreo`), rama `main`, raíz, push por HTTPS. **Antes de publicar, el autor la revisa local**: no se crea el repo remoto ni se hace push hasta su OK.

## Recorrido y lista de slides (propuesta; revisable en la revisión local)

| # | Kicker · Título | Demo | Qué se toca |
|---|---|---|---|
| 0 | Portada · "Enterarse antes que el usuario" | fondo animado | — |
| **El problema** |||
| 1 | Sin señales · "Todo anda… ¿o no?" | la tienda (Usuarios → Órdenes → Pagos → Envíos) funcionando; al romper Pagos, los pedidos se demoran y fallan, y lo único que avisa es una queja de un usuario que aparece después de un rato | romper Pagos, tráfico |
| 2 | Tres preguntas · "¿Anda mal? ¿Qué pasó? ¿Dónde?" | estática: métricas, logs y trazas, cada una con la pregunta que contesta y un mini ejemplo | fragmentos |
| **Métricas** |||
| 3 | Métricas · "Contar y medir" | la misma tienda con un mini dashboard por servicio: pedidos/s, errores y latencia; contador vs. gauge vs. histograma | romper Pagos, tráfico |
| 4 | Percentiles · "El promedio esconde la falla" | 5% de pedidos lentos: el promedio casi no se mueve, el p95/p99 sí | % lentos, mostrar avg/p50/p95/p99 |
| 5 | Señales doradas · "Latencia, tráfico, errores, saturación" | Pagos con su pool de conexiones visible; la saturación llega al 100% antes que los errores | tráfico, tamaño del pool |
| **Logs** |||
| 6 | Logs · "Qué pasó en este pedido" | stream de logs en vivo con niveles; filtrar por nivel y buscar un `order_id` | nivel, buscar pedido, romper Pagos |
| 7 | Logs · "Estructurados y en un solo lugar" | 3 réplicas de Pagos con sus logs por separado vs. centralizados; texto libre vs. JSON con campos | por réplica / central, texto / estructurado |
| **Trazas** |||
| 8 | Trazas · "Seguir un pedido entre servicios" | un pedido con trace id que viaja; vista en cascada de spans | clic en un pedido, romper Pagos |
| 9 | Las tres juntas · "De la métrica a la traza, de la traza al log" | el mismo incidente: pico en el gráfico → clic → trazas de ese momento → span lento → logs de ese span | navegación por clic |
| **Alertas** |||
| 10 | Alertas · "¿Cuándo avisar?" | una serie con ruido y un incidente real; línea de umbral y ventana; marca falsas alarmas e incidentes perdidos | slider de umbral, ventana ("durante N min") |
| 11 | Alertas · "Avisar por síntoma, no por causa" | varias alertas por causa (CPU, memoria, una réplica caída) que suenan sin impacto y una por síntoma que suena solo cuando el usuario sufre; contador de "alertas por noche" | prender/apagar alertas, romper |
| 12 | SLO · "Cuánto fallar está permitido" | objetivo (p. ej. 99,5% de checkouts OK) y presupuesto de error que se consume; alerta por velocidad de consumo | romper Pagos, objetivo |
| **Reaccionar solo** |||
| 13 | Health checks · "¿Está vivo? ¿Está listo?" | liveness: Pagos colgado → se reinicia; readiness: réplica que arranca o está saturada → sale de rotación sin reiniciar | colgar Pagos, deploy lento, liveness/readiness |
| 14 | Supervisor · "Si se cae, levantalo" | proceso que se cae y se reinicia; con un bug que falla al arrancar, crash loop con backoff creciente | romper una vez / bug al arrancar, política de reinicio |
| 15 | Autoscaling · "Sumar réplicas con la carga" | pico sano: el autoscaler mira una métrica y suma réplicas con demora; mínimo/máximo, enfriamiento y oscilación si el umbral está mal | tráfico, umbral, enfriamiento |
| 16 | Circuit breaker · "Cortar a tiempo" | Órdenes llama a Pagos lento: sin timeout se cuelga todo; con timeout falla rápido; con breaker deja de llamar y prueba de nuevo (abierto/medio abierto/cerrado) | sin / timeout / breaker, romper Pagos |
| 17 | Límites · "Cuando lo automático empeora las cosas" | el incidente del pool: reiniciar alivia y vuelve a fallar; escalar Pagos satura más la DB; los reintentos multiplican la carga | reiniciar / escalar / reintentos |
| **Cierre** |||
| 18 | Ejemplos · "Herramientas reales" | métricas (Prometheus, Grafana), logs (Loki, ELK), trazas (OpenTelemetry, Jaeger/Tempo), alertas (Alertmanager, PagerDuty), reacción (probes y HPA de Kubernetes, restart de Docker, systemd/supervisord), laboratorio | fragmentos |
| 19 | Resumen · "Lo que nos llevamos" | seis ideas | fragmentos |
| 20 | Seguir explorando | QR + playground (preset load-balancer) + repo | — |

## Laboratorio con Docker (propuesta mía)

Lo mismo que las simulaciones, con piezas reales y livianas:

- La tienda mínima: **Órdenes → Pagos → Envíos** (servicios chicos, reutilizando la estructura de `lab/` de proxy reverso o caché), con **Postgres** para Pagos y un pool chico configurable. Endpoints o variables para romper Pagos: lento, colgado, crash al arrancar.
- Instrumentación con **OpenTelemetry** (métricas, logs con `trace_id` y trazas).
- **Prometheus** + **Grafana** (dashboard provisionado con las cuatro señales doradas), **Loki** para logs y **Jaeger** o **Tempo** para trazas.
- **Alertmanager** con una regla por síntoma y otra por causa.
- Reacción: `restart: on-failure` y `healthcheck` de Docker Compose para el supervisor y la liveness. El autoscaling no se puede mostrar en Compose de forma creíble; queda fuera del laboratorio o como script que escala con `docker compose up --scale` mirando una métrica (decisión del builder).
- Un generador de carga (p. ej. `k6` o un script) y un README con el recorrido por slide y la tabla "Romper cosas".

El stack tiene que levantar en una notebook común. Si queda pesado, se priorizan métricas + trazas + alertas y Loki pasa a ser opcional.

## Lo que queda a criterio del que construye

- El motor: extender el `sim.js` del template (que ya tiene clientes → servidores → DB) con una cadena de servicios Órdenes → Pagos → Envíos, pool de conexiones y emisión de señales (métricas por ventana, eventos de log, spans), o escenas manuales con `Clock` donde no alcance (alertas, SLO, supervisor).
- Calibrar números (pool, tasas, umbrales, ventanas, demoras del autoscaler) para que cada efecto se vea siempre.
- Textos finales de slides y notas, en el tono de la serie.
- Fusionar o partir slides si alguna queda pobre o el panel desborda (p. ej. 11 y 12, 13 y 14).
- Si agregar una slide "Playground" como en load balancer.
- Dibujo de la queja del usuario en la slide 1 (algo genérico, sin marcas reales).

Orden de trabajo (mi decisión): primero el deck y después el laboratorio, y los dos listos antes de la revisión local. Si el autor quiere revisar el deck antes, solo cambia el orden.

## Criterio de terminado

- Las slides de la tabla con sus demos funcionando en escritorio y celular.
- `smoke.js`, `mobile.js` y `tests/interact.js` en verde, y capturas revisadas.
- El QR decodifica a la URL publicada y la portada y la slide final se ven bien en escritorio y celular.
- El laboratorio levanta con `docker compose up -d --build` y el recorrido del README funciona.
- Revisada localmente por el autor y, con su OK, publicada en GitHub Pages.
