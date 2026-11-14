# Monitoreo y supervisión

Presentación interactiva en español (reveal.js + GSAP + Chart.js) para la serie de arquitectura: cómo enterarse de lo que le pasa a un sistema antes que el usuario (métricas, logs, trazas, alertas) y cómo hacer que reaccione solo (health checks, supervisor, autoscaling, circuit breaker) y qué límites tiene. Es autocontenida: funciona offline y no necesita build.

## Cómo abrirla

- Abrí `index.html` en el navegador (por ejemplo `open -a "Google Chrome" index.html`).
- Flechas para avanzar, `S` notas del orador, `F` pantalla completa, `O` vista general.
- En el celular se ve como un documento vertical con las simulaciones activas; se puede forzar con `?mobile=1` o `?mobile=0`.
- Publicada: https://gastonprieto.github.io/presentacion-monitoreo/

## Cómo probar

Con Chrome headless, desde la carpeta `tools/` de `presentaciones-guideline` (después de `npm i`):

```sh
node ../../presentacion-monitoreo/tests/interact.js   # lógica, escenas y widgets
node smoke.js ../../presentacion-monitoreo            # recorrida de escritorio + capturas
node mobile.js ../../presentacion-monitoreo           # versión móvil + capturas
```

Más detalle de la arquitectura en `CLAUDE.md`.

## Laboratorio con Docker

_Próximamente: la tienda Órdenes → Pagos → Envíos con piezas reales (Prometheus, Grafana, etc.), el recorrido por slide y la tabla «Romper cosas»._
