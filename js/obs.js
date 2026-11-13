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

  // Reinicio automático con backoff exponencial: espera base × factor^k, hasta cap.
  // Si el proceso estuvo sano resetAfter segundos antes de caer, el contador vuelve a cero.
  class Supervisor {
    constructor({ policy, base = 1, factor = 2, cap = 16, resetAfter = 10 }) {
      this.policy = policy;
      this.base = base;
      this.factor = factor;
      this.cap = cap;
      this.resetAfter = resetAfter;
      this.k = 0;
      this.restarts = 0;
      this.healthySince = null;
      this._state = 'running';
    }
    get state() { return this._state; }
    // Devuelve los segundos hasta el próximo arranque, o null si no reinicia
    onExit(t, failed) {
      if (this.healthySince !== null && t - this.healthySince >= this.resetAfter) this.k = 0;
      this.healthySince = null;
      if (this.policy === 'no' || (this.policy === 'on-failure' && !failed)) {
        this._state = 'stopped';
        return null;
      }
      const delay = Math.min(this.cap, this.base * Math.pow(this.factor, this.k));
      this.k++;
      this.restarts++;
      this._state = 'backoff';
      return delay;
    }
    // El proceso arrancó y responde: desde acá se cuenta el tiempo sano
    onHealthy(t) {
      if (this.healthySince === null) this.healthySince = t;
      this._state = 'running';
    }
  }

  // Escala réplicas según la métrica por réplica: desired = ceil(replicas × metric / target), entre min y max.
  // Entre dos cambios pasa al menos cooldown. startup lo usa ShopSim para la demora de la réplica nueva.
  class Autoscaler {
    constructor({ min = 1, max = 6, target, cooldown = 8, startup = 3 }) {
      this.min = min;
      this.max = max;
      this.target = target;
      this.cooldown = cooldown;
      this.startup = startup;
      this.lastChange = -Infinity;
    }
    step(t, metricPerReplica, replicas) {
      const raw = Math.ceil(replicas * metricPerReplica / this.target - 1e-9);
      const desired = Math.max(this.min, Math.min(this.max, raw));
      if (desired === replicas || t - this.lastChange < this.cooldown) return replicas;
      this.lastChange = t;
      return desired;
    }
  }

  // Corta las llamadas a un destino que falla: closed → open (tras `failures` seguidas) → half (tras openFor,
  // deja pasar una prueba) → closed si la prueba sale bien, open si falla.
  class CircuitBreaker {
    constructor({ failures = 5, openFor = 5 } = {}) {
      this.failures = failures;
      this.openFor = openFor;
      this._state = 'closed';
      this.fails = 0;
      this.openedAt = 0;
      this.probing = false;
    }
    get state() { return this._state; }
    allow(t) {
      if (this._state === 'open' && t - this.openedAt >= this.openFor) {
        this._state = 'half';
        this.probing = false;
      }
      if (this._state === 'closed') return true;
      if (this._state === 'half' && !this.probing) { this.probing = true; return true; }
      return false;
    }
    record(t, ok) {
      if (ok) {
        this.fails = 0;
        if (this._state === 'half') this._state = 'closed';
        return;
      }
      if (this._state === 'half') { this._state = 'open'; this.openedAt = t; return; }
      if (this._state === 'closed' && ++this.fails >= this.failures) { this._state = 'open'; this.openedAt = t; }
    }
  }

  window.ObsKit = { rng, percentile, MetricWindow, AlertRule, classifyAlerts, ErrorBudget,
    Supervisor, Autoscaler, CircuitBreaker };
})();
