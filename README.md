# Monitoreo y supervisión

Presentación interactiva (reveal.js + simulaciones en SVG) sobre cómo enterarse de qué le pasa a un sistema antes que el usuario: métricas, logs, trazas, alertas y reacción automática.

**Verla online:** https://gastonprieto.github.io/presentacion-monitoreo/

Es parte de la serie de arquitectura (load balancer, microservicios, proxy reverso, colas, eventos, caché), pero se puede dar sola y en cualquier orden.

Teclas: `→` avanzar · `S` notas del orador · `F` pantalla completa · `O` vista general · `-` / `+` velocidad de las simulaciones. En el celular se ve como documento vertical.

## Probar

Desde `presentaciones-guideline/tools` (después de `npm i`):

```bash
node smoke.js ../../presentacion-monitoreo    # escritorio
node mobile.js ../../presentacion-monitoreo   # celular
```

Y desde esta carpeta: `node tests/interact.js [filtro]`.

Basada en [presentaciones-guideline](../presentaciones-guideline).
