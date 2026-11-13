/* Modelos de observabilidad sin dibujo: ventana de métricas, percentiles, regla de alerta,
   presupuesto de error (SLO), supervisor con backoff, autoscaler y circuit breaker.
   El tiempo lo pasa quien llama (segundos de simulación). Lo usan la simulación de la tienda y las slides.
   Expone window.ObsKit = { rng, percentile, MetricWindow, AlertRule, classifyAlerts, ErrorBudget,
   Supervisor, Autoscaler, CircuitBreaker }. */
(function () {
  'use strict';

  // mulberry32: el mismo generador sembrado que cache.js
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Percentil por nearest-rank: el menor valor con al menos p% de las muestras por debajo o igual.
  function percentile(values, p) {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const k = Math.ceil(p / 100 * s.length - 1e-9);
    return s[Math.min(s.length - 1, Math.max(0, k - 1))];
  }

  // Redondeo para esconder el ruido de coma flotante (0.01 × 1000 = 10.000000000000009)
  const clean = x => Math.round(x * 1e9) / 1e9;

  // Ventana deslizante de muestras { t, latency, ok }. Solo cuentan las de t > now - span.
  class MetricWindow {
    constructor({ span }) {
      this.span = span;
      this.samples = [];
    }
    add(t, { latency, ok }) {
      this.samples.push({ t, latency, ok });
    }
    stats(now) {
      const from = now - this.span;
      this.samples = this.samples.filter(s => s.t > from); // lo viejo no vuelve a servir
      const n = this.samples.length;
      if (!n) return { n: 0, rps: 0, errPct: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
      const lat = this.samples.map(s => s.latency);
      const bad = this.samples.filter(s => !s.ok).length;
      return {
        n,
        rps: n / this.span,
        errPct: 100 * bad / n,
        avg: lat.reduce((a, b) => a + b, 0) / n,
        p50: percentile(lat, 50),
        p95: percentile(lat, 95),
        p99: percentile(lat, 99),
      };
    }
  }

  // Regla "valor del lado malo del umbral durante forSec seguidos". above=false: malo es estar por debajo.
  class AlertRule {
    constructor({ threshold, forSec, above = true }) {
      this.threshold = threshold;
      this.forSec = forSec;
      this.above = above;
      this.badSince = null;
    }
    isBad(value) {
      return this.above ? value > this.threshold : value < this.threshold;
    }
    step(t, value) {
      if (!this.isBad(value)) { this.badSince = null; return 'ok'; }
      if (this.badSince === null) this.badSince = t;
      return t - this.badSince >= this.forSec ? 'firing' : 'pending';
    }
    // Recorre una serie [t, valor] con un estado propio y devuelve los intervalos [inicio, fin] en firing
    evaluate(series) {
      const rule = new AlertRule({ threshold: this.threshold, forSec: this.forSec, above: this.above });
      const firings = [];
      let start = null;
      for (const [t, v] of series) {
        const st = rule.step(t, v);
        if (st === 'firing' && start === null) start = t;
        else if (st !== 'firing' && start !== null) { firings.push([start, t]); start = null; }
      }
      if (start !== null) firings.push([start, series[series.length - 1][0]]);
      return { firings };
    }
  }

  // Un firing que se superpone con un incidente lo atrapa; incidente sin firing = perdido; firing sin incidente = falso positivo
  function classifyAlerts(firings, incidents) {
    const overlap = (a, b) => a[0] <= b[1] && b[0] <= a[1];
    return {
      caught: incidents.filter(i => firings.some(f => overlap(f, i))).length,
      missed: incidents.filter(i => !firings.some(f => overlap(f, i))).length,
      falsePos: firings.filter(f => !incidents.some(i => overlap(f, i))).length,
    };
  }

  // Presupuesto de error de un SLO sobre una ventana móvil de windowSec
  class ErrorBudget {
    constructor({ slo, windowSec }) {
      this.slo = slo;
      this.windowSec = windowSec;
      this.events = [];
    }
    add(t, ok) {
      this.events.push({ t, ok });
    }
    state(now) {
      const from = now - this.windowSec;
      this.events = this.events.filter(e => e.t > from);
      const total = this.events.length;
      const bad = this.events.filter(e => !e.ok).length;
      if (!total) return { total: 0, bad: 0, allowed: 0, remainingPct: 100, burnRate: 0 };
      const allowed = clean((1 - this.slo) * total);
      const remaining = allowed > 0 ? 100 * (allowed - bad) / allowed : (bad ? -100 : 100);
      return {
        total, bad, allowed,
        remainingPct: Math.max(-100, Math.min(100, clean(remaining))),
        burnRate: clean((bad / total) / (1 - this.slo)),
      };
    }
  }

  window.ObsKit = { rng, percentile, MetricWindow, AlertRule, classifyAlerts, ErrorBudget };
})();
