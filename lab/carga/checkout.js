// Generador de carga (k6): pedidos de checkout a ritmo constante contra Órdenes.
//   docker compose --profile carga run --rm carga
//   docker compose --profile carga run --rm -e TASA=20 -e DURACION=2m carga
import http from 'k6/http';

const TASA = Number(__ENV.TASA || 10);           // pedidos por segundo
const DURACION = __ENV.DURACION || '10m';
const URL = __ENV.URL || 'http://ordenes:3000/checkout';

export const options = {
  scenarios: {
    checkout: {
      executor: 'constant-arrival-rate',
      rate: TASA, timeUnit: '1s', duration: DURACION,
      preAllocatedVUs: 20, maxVUs: 200,          // si Órdenes se demora, hacen falta más usuarios
    },
  },
};

export default function () {
  http.get(URL, { timeout: '10s', tags: { name: 'checkout' } });
}
