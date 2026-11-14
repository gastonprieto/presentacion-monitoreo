# Monitoreo y supervisión

Presentación interactiva en español (reveal.js + GSAP + Chart.js) para la serie de arquitectura: cómo enterarse de lo que le pasa a un sistema antes que el usuario (métricas, logs, trazas, alertas) y cómo hacer que reaccione solo (health checks, supervisor, autoscaling, circuit breaker) y qué límites tiene. Es autocontenida: funciona offline y no necesita build.

## Cómo abrirla

- Abrí `index.html` en el navegador (por ejemplo `open -a "Google Chrome" index.html`).
- Flechas para avanzar, `S` notas del orador, `F` pantalla completa, `O` vista general, `-` / `+` velocidad de las simulaciones.
- En el celular se ve como un documento vertical con las simulaciones activas; se puede forzar con `?mobile=1` o `?mobile=0`.
- Publicada: https://gastonprieto.github.io/presentacion-monitoreo/

## Cómo probar

Con Chrome headless, desde la carpeta `tools/` de `presentaciones-guideline` (después de `npm i`):

```sh
node ../../presentacion-monitoreo/tests/interact.js   # lógica, escenas y widgets
node smoke.js ../../presentacion-monitoreo            # recorrida de escritorio + capturas
node mobile.js ../../presentacion-monitoreo           # versión móvil + capturas
```

Las pruebas de interacción también corren desde esta carpeta y aceptan un filtro (parte del nombre de la prueba): `node tests/interact.js [filtro]`.

Más detalle de la arquitectura en `CLAUDE.md`.

## Laboratorio con Docker

Lo mismo que muestran las simulaciones, con piezas reales: la tienda **Órdenes → Pagos → Envíos**, con Postgres detrás de Pagos y un pool chico de conexiones, instrumentada con **OpenTelemetry**. Las métricas van a **Prometheus**, las trazas a **Tempo** y los logs a **Loki**; **Grafana** muestra las tres. **Alertmanager** recibe las alertas y el `restart` y el `healthcheck` de Docker hacen de supervisor.

Hace falta Docker con Compose. Todo junto usa alrededor de 1 GB de RAM (medido con `docker stats` con carga) y los puertos 8080, 3000, 9090 y 9093.

| Pieza | Dónde | Qué hace |
|---|---|---|
| Órdenes | `localhost:8080/checkout` | La puerta de la tienda. Llama a Pagos con un timeout de 2 s (`TIMEOUT_MS`) |
| Pagos | interno | Cobra en Postgres con un pool de 4 conexiones (`POOL`) y llama a Envíos. Tiene `healthcheck` y `restart: on-failure` |
| Envíos | interno | Contesta en 10 a 40 ms |
| Postgres | interno | Cada cobro suma a la misma fila (la caja del día): el `UPDATE` la bloquea hasta el `COMMIT` y la base cobra de a uno, con una capacidad fija. `max_connections=20` (a Pagos le quedan 17) |
| OpenTelemetry Collector | interno | Recibe trazas, métricas y logs por OTLP y los reparte |
| Grafana | `localhost:3000` | Dashboard **Tienda** (las cuatro señales doradas), Explore para logs y trazas. Sin login |
| Prometheus | `localhost:9090` | Métricas y reglas de alerta (`lab/prometheus/rules.yml`) |
| Alertmanager | `localhost:9093` | Las alertas que llegan. No avisa a nadie: es para verlas |
| Tempo, Loki | internos | Trazas y logs (se consultan desde Grafana) |

Los tres servicios son la misma imagen (`lab/servicio`) con `SERVICIO=ordenes|pagos|envios`. La instrumentación está en `lab/servicio/otel.js`: el SDK de OpenTelemetry para Node con auto-instrumentación de http, express, fetch y pg. Las métricas de HTTP, los spans y la propagación del `trace_id` entre servicios salen solos. A mano sólo están el uso de CPU, el pool de Pagos y los logs (JSON con `trace_id`).

```bash
docker compose up -d --build        # la primera vez tarda unos minutos (imágenes y npm)
docker compose ps                   # pagos tiene que decir (healthy)
curl -s localhost:8080/checkout     # {"pedido":1001,"estado":"confirmado","pago":"aprobado","envio":"ENV-1001"}
docker compose down -v              # al terminar
```

**Carga.** En otra terminal, 10 checkouts por segundo durante 10 minutos con k6 (corre en un contenedor, no hace falta instalarlo):

```bash
docker compose --profile carga run --rm carga
docker compose --profile carga run --rm -e TASA=20 -e DURACION=2m carga    # otro ritmo u otra duración
```

Sin k6 alcanza con un `curl` en loop (más lento: un pedido por vez):

```bash
while true; do curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" localhost:8080/checkout; sleep 0.1; done
```

**Romper y arreglar.** Las fallas se piden a Órdenes y quedan guardadas en un volumen que ven todas las réplicas (sobreviven a un reinicio, como un deploy con un bug):

```bash
curl -s -X POST "localhost:8080/romper?modo=lento"      # o colgado, crash, cpu (por defecto rompe Pagos)
curl -s -X POST "localhost:8080/arreglar"
```

### Recorrido por slide

Con la carga corriendo y el dashboard **Tienda** abierto (`localhost:3000`, es la página de inicio; se actualiza cada 5 s).

**Todo anda… ¿o no?** Rompé Pagos y mirá sólo la terminal de la carga o el `curl`. Con `lento`, cada cobro tarda cada vez más en la caja (de 10 ms a 130 ms en un minuto: `LENTO_S` y `LENTO_RAMPA_S` en el compose). Durante unos 50 s todo sale bien, sólo más lento. Cuando la caja ya no da abasto (cobra ~7,7 por segundo y llegan 10), fallan cerca del 30% de los pedidos. Sin señales, eso es todo lo que sabrías.

```bash
curl -s -X POST "localhost:8080/romper?modo=lento"
curl -s -w " %{http_code} %{time_total}s\n" localhost:8080/checkout    # pasado el minuto: 200 a ~1,6 s, o "fallido" · 502 a 1 s
```

**Métricas, percentiles y señales doradas.** El dashboard tiene una fila por señal y una línea por servicio: tráfico (pedidos/s, un contador convertido en tasa), errores (% de 5xx, con la línea del 5% de la alerta), latencia (p95 y p50 de un histograma) y saturación (el pool de Pagos: cuando llega al 100% empiezan a esperar pedidos y después los errores). Abajo están la CPU y la espera en la base. Con `lento` se ve el orden de la slide: primero sube la latencia sin errores (en la prueba, el p95 de Órdenes pasó de 0,07 s a 0,65 s en 50 s), después el pool llega al 100%, empiezan a esperar pedidos y aparecen los errores (~30%). El p95 queda en ~2,4 s: los pedidos más lentos se cortan en los 2 s del timeout de Órdenes. Pagos marca un poco menos de errores que Órdenes porque algunos cobros terminan después de que Órdenes ya se cansó de esperar. Las mismas consultas se pueden escribir en Prometheus (`localhost:9090`):

```promql
histogram_quantile(0.95, sum by (job, le) (rate(http_server_request_duration_seconds_bucket[30s])))
sum by (job) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[30s]))
```

**Logs: qué pasó en este pedido, estructurados y en un solo lugar.** Por separado, cada contenedor tiene los suyos; centralizados, se buscan todos juntos. En Grafana → Explore → Loki, filtrando por un campo del JSON:

```bash
docker compose logs pagos --tail 5          # los de una sola pieza, en JSON con trace_id
```

```logql
{service_name=~"ordenes|pagos|envios"} | json | pedido="1234"
{service_name="pagos"} | json | nivel="error"
```

**Trazas: seguir un pedido entre servicios.** En Explore → Tempo → Search se listan las trazas (filtrables por servicio o duración); cada una muestra la cascada `GET /checkout` (Órdenes) → `POST /pagar` (Pagos, con `pg-pool.connect` y las consultas) → `POST /enviar` (Envíos). Con `lento`, el tiempo se va en `pg-pool.connect` (esperar una conexión libre del pool) y en el `UPDATE` (esperar el turno en la caja). Por ejemplo, en un pedido de 1,7 s: 920 ms y 580 ms. Las trazas tardan unos 10 s en aparecer.

**De la métrica a la traza y al log.** En un log de Loki, el campo `trace_id` tiene un link a su traza en Tempo; en una traza, cada span tiene un botón de logs que abre los de ese pedido.

**Alertas: cuándo avisar y por síntoma, no por causa.** Hay dos reglas en `lab/prometheus/rules.yml`, las dos con `for: 1m` (la ventana): `CheckoutErrores` (**síntoma**: más del 5% de los checkouts fallan) y `PagosCPUAlta` (**causa**: Pagos usa más del 50% de un núcleo). Con `lento`, unos 2 minutos después de romper (en la prueba, 129 s: ~60 s de rampa hasta que aparecen los errores, más el `for: 1m`) `CheckoutErrores` pasa de *pending* a *firing* en Prometheus (`localhost:9090/alerts`) y aparece en Alertmanager (`localhost:9093`). Con `cpu`, Pagos quema 60 ms de CPU por pedido pero contesta bien: suena `PagosCPUAlta` y `CheckoutErrores` no, porque el usuario no sufre.

```bash
curl -s -X POST "localhost:8080/arreglar"; curl -s -X POST "localhost:8080/romper?modo=cpu"
```

**SLO.** No hay una alerta de SLO armada, pero el indicador es una consulta: la fracción de checkouts buenos en la última hora.

```promql
sum(rate(http_server_request_duration_seconds_count{job="ordenes", http_route="/checkout", http_response_status_code!~"5.."}[1h]))
  / sum(rate(http_server_request_duration_seconds_count{job="ordenes", http_route="/checkout"}[1h]))
```

**Health checks: ¿está vivo?** El `healthcheck` de Pagos pide `/salud` cada 5 s con 1 s de timeout; tres fallas seguidas y queda `unhealthy` (unos 15 s). Con `colgado`, el proceso sigue vivo pero no contesta nada:

```bash
curl -s -X POST "localhost:8080/romper?modo=colgado"
docker compose ps pagos                 # Up ... (unhealthy)
docker inspect -f '{{.RestartCount}}' lab-monitoreo-pagos-1    # 0: nadie lo reinició
curl -s -X POST "localhost:8080/arreglar"; docker compose restart pagos     # lo reinicia una persona
```

Ésta es la diferencia con Kubernetes: Compose **marca** `unhealthy` pero **no reinicia** por eso (sólo reinicia si el proceso termina). La liveness de Kubernetes sí lo reiniciaría. La readiness (sacar una réplica de la rotación sin reiniciarla) tampoco está: en Compose no hay un balanceador que mire el healthcheck.

**Supervisor: si se cae, levantalo.** Con `crash`, Pagos se cae y vuelve a caerse cada vez que arranca (un bug al arrancar). `restart: on-failure` lo levanta una y otra vez, cada vez esperando más (backoff: en la prueba, 1,0 · 1,2 · 1,6 · 2,5 · 4,1 · 7,4 s entre arranques):

```bash
curl -s -X POST "localhost:8080/romper?modo=crash"
docker compose ps pagos                 # Restarting (1) ...
docker inspect -f '{{.RestartCount}}' lab-monitoreo-pagos-1    # crece
docker events --filter container=lab-monitoreo-pagos-1 --filter event=die --filter event=start    # Ctrl+C para salir
curl -s -X POST "localhost:8080/arreglar"    # en el próximo intento arranca bien
```

**Autoscaling.** No está en el laboratorio: Compose no escala solo. Se puede escalar a mano (ver «Límites»).

**Circuit breaker.** Órdenes tiene timeout (2 s, `TIMEOUT_MS`) pero no breaker: con `colgado` cada pedido espera los 2 s completos y falla con 504. Un breaker dejaría de llamar a Pagos y fallaría al instante.

**Límites: cuando lo automático empeora las cosas.** Con `lento`, sumar réplicas de Pagos empeora las cosas. La caja cobra de a uno, así que más réplicas no cobran más rápido: sólo meten más conexiones a esperar en la base (de 4 a 12) y la fila se hace más larga. Más pedidos superan los 2 s y Órdenes los da por fallidos, aunque Pagos los termine de cobrar igual (trabajo tirado).

| Con `lento` (10 pedidos/s) | 1 réplica | 3 réplicas |
|---|---|---|
| Errores de checkout (Órdenes) | ~30% | ~55% |
| Checkouts que salen bien | ~7 por segundo | ~4,5 por segundo |
| Espera por la caja (`UPDATE`), p50 | ~0,37 s | ~0,9 s |
| Espera por la caja (`UPDATE`), p95 | ~0,9 s | más de 4 s |
| Conexiones de Pagos en la base | 4 | 12 |

```bash
curl -s -X POST "localhost:8080/romper?modo=lento"     # esperar un par de minutos con la carga
docker compose up -d --scale pagos=3                   # en el dashboard: los errores suben y el panel «Base» también
docker compose exec db psql -U postgres -d tienda -c "select wait_event_type, wait_event, count(*) from pg_stat_activity where usename='tienda' group by 1,2"    # casi todas esperando un Lock
docker compose up -d --scale pagos=1
```

**Herramientas reales.** Todo lo de arriba: Prometheus, Grafana, Loki, Tempo, OpenTelemetry, Alertmanager y el restart y el healthcheck de Docker.

### Romper cosas

| Qué romper | Comando | Qué se ve | Volver |
|---|---|---|---|
| Pagos lento | `curl -X POST "localhost:8080/romper?modo=lento"` | La caja tarda cada vez más (rampa de 1 min): primero sube la latencia, después el pool llega al 100% y fallan ~30% de los checkouts; a los ~2 min suena `CheckoutErrores` | `curl -X POST localhost:8080/arreglar` |
| Pagos colgado | `curl -X POST "localhost:8080/romper?modo=colgado"` | No contesta ni `/salud`: a los ~15 s `(unhealthy)`, pero Compose no lo reinicia | `arreglar` y `docker compose restart pagos` |
| Bug al arrancar | `curl -X POST "localhost:8080/romper?modo=crash"` | Crash loop: `Restarting`, `RestartCount` que crece y esperas cada vez más largas | `curl -X POST localhost:8080/arreglar` (arranca solo en el próximo intento) |
| CPU alta sin impacto | `curl -X POST "localhost:8080/romper?modo=cpu"` | Suena `PagosCPUAlta` (causa) y no `CheckoutErrores` (síntoma) | `curl -X POST localhost:8080/arreglar` |
| Escalar con la base lenta | `lento` + `docker compose up -d --scale pagos=3` | Peor: los errores pasan de ~30% a ~55% y la espera en la base más que se duplica | `docker compose up -d --scale pagos=1` |
| La base | `docker compose stop db` | Pagos falla todos los cobros; el healthcheck sigue verde porque `/salud` no mira la base (¿está vivo? no es ¿está listo?) | `docker compose start db` |
| Envíos | `docker compose stop envios` | Pagos cobra pero falla al llamar a Envíos: en la traza, el error está en el último salto | `docker compose start envios` |
| El collector | `docker compose stop collector` | La tienda sigue andando pero el dashboard se queda sin datos: el monitoreo también puede caerse | `docker compose start collector` |

Se puede romper Envíos en lugar de Pagos con `?servicio=envios` en `/romper` y `/arreglar` (`lento`, `colgado` o `crash`). Con `lento`, Envíos tarda 1,5 s: los checkouts salen bien pero lentos, y en la traza el span largo es el de Envíos, no el de la base.
