// Instrumentación con OpenTelemetry. Se carga antes que el servidor (node --require ./otel.js).
// Los exporters salen de las variables de entorno del compose:
//   OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT (el collector) y OTEL_METRIC_EXPORT_INTERVAL.
// Trazas, métricas y logs van por OTLP al collector; él los reparte a Tempo, Prometheus y Loki.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

const noMedir = ['/salud', '/romper', '/arreglar'];

const sdk = new NodeSDK({
  // Auto-instrumentación: http (entrante y saliente), express, fetch (undici) y pg.
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    // Sin un span por cada middleware de express: la cascada queda con lo que importa.
    '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware', 'request_handler', 'router'] },
    '@opentelemetry/instrumentation-router': { enabled: false },
    '@opentelemetry/instrumentation-http': {
      // El healthcheck y los botones de romper no son tráfico de la tienda.
      ignoreIncomingRequestHook: (req) => noMedir.some((p) => req.url.startsWith(p)),
    },
  })],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
