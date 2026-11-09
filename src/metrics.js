const os = require('os');
const config = require('./config.js').metrics;

const METHODS = ['GET', 'PUT', 'POST', 'DELETE'];
let metricsTimer;
let sending = false;
const retryBatches = [];

function cpuTimes() {
  return os.cpus().reduce(
    (totals, cpu) => {
      for (const [name, value] of Object.entries(cpu.times)) {
        totals[name] = (totals[name] || 0) + value;
      }
      return totals;
    },
    {},
  );
}

let previousCpuTimes = cpuTimes();

function newMinute() {
  return {
    requestTotal: 0,
    requestsByMethod: Object.fromEntries(METHODS.map((method) => [method, 0])),
    activeUsers: new Set(),
    authSuccess: 0,
    authFailure: 0,
    pizzasSold: 0,
    pizzaFailures: 0,
    revenue: 0,
    endpointLatency: new Map(),
    pizzaLatency: { count: 0, totalMs: 0 },
  };
}

let minute = newMinute();

function addLatency(bucket, key, latency) {
  const aggregate = bucket.get(key) || { count: 0, totalMs: 0 };
  aggregate.count += 1;
  aggregate.totalMs += latency;
  bucket.set(key, aggregate);
}

function makeMetric(name, type, value, unit, attributes = []) {
  const metric = {
    name,
    unit,
    [type]: {
      dataPoints: [
        {
          asDouble: value,
          timeUnixNano: String(Date.now() * 1_000_000),
          attributes,
        },
      ],
    },
  };
  if (type === 'sum') {
    metric.sum.aggregationTemporality = 'AGGREGATION_TEMPORALITY_DELTA';
    metric.sum.isMonotonic = true;
  }
  return metric;
}

function sampleCpuPercentage() {
  const current = cpuTimes();
  const previousTotal = Object.values(previousCpuTimes).reduce((sum, value) => sum + value, 0);
  const currentTotal = Object.values(current).reduce((sum, value) => sum + value, 0);
  const totalDelta = currentTotal - previousTotal;
  const idleDelta = current.idle - previousCpuTimes.idle;
  previousCpuTimes = current;
  return totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
}

function minuteMetrics() {
  const current = minute;
  minute = newMinute();

  const metrics = [
    makeMetric('http.requests.total', 'sum', current.requestTotal, '1'),
    makeMetric('users.active', 'gauge', current.activeUsers.size, '1'),
    makeMetric('auth.attempts', 'sum', current.authSuccess, '1', [
      { key: 'outcome', value: { stringValue: 'success' } },
    ]),
    makeMetric('auth.attempts', 'sum', current.authFailure, '1', [
      { key: 'outcome', value: { stringValue: 'failure' } },
    ]),
    makeMetric('pizzas.sold', 'sum', current.pizzasSold, '1'),
    makeMetric('pizzas.creation.failures', 'sum', current.pizzaFailures, '1'),
    makeMetric('pizzas.revenue', 'sum', current.revenue, 'USD'),
    makeMetric('system.cpu.utilization', 'gauge', sampleCpuPercentage(), '%'),
    makeMetric(
      'system.memory.utilization',
      'gauge',
      ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
      '%',
    ),
  ];

  for (const method of METHODS) {
    metrics.push(
      makeMetric('http.requests.by_method', 'sum', current.requestsByMethod[method], '1', [
        { key: 'method', value: { stringValue: method } },
      ]),
    );
  }

  for (const [endpoint, latency] of current.endpointLatency) {
    metrics.push(
      makeMetric('http.server.duration.average', 'gauge', latency.totalMs / latency.count, 'ms', [
        { key: 'endpoint', value: { stringValue: endpoint } },
      ]),
    );
  }

  if (current.pizzaLatency.count > 0) {
    metrics.push(
      makeMetric(
        'pizza.creation.duration.average',
        'gauge',
        current.pizzaLatency.totalMs / current.pizzaLatency.count,
        'ms',
      ),
    );
  }

  return metrics;
}

async function sendBatch(metrics) {
  const payload = {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: config.source } }],
        },
        scopeMetrics: [{ metrics }],
      },
    ],
  };
  const response = await fetch(config.endpointUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accountId}:${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Grafana returned ${response.status}`);
}

async function drainBatches() {
  if (sending) return;
  sending = true;
  try {
    while (retryBatches.length > 0) {
      try {
        await sendBatch(retryBatches[0]);
        retryBatches.shift();
      } catch (error) {
        console.error('Error sending metrics', error.message);
        break;
      }
    }
  } finally {
    sending = false;
  }
}

function sendMetricsPeriodically(period = 60_000) {
  if (!Number.isFinite(period) || period <= 0) {
    throw new TypeError('Metrics period must be a positive number of milliseconds');
  }
  if (metricsTimer) return metricsTimer;

  metricsTimer = setInterval(() => {
    retryBatches.push(minuteMetrics());
    void drainBatches();
  }, period);
  metricsTimer.unref?.();
  return metricsTimer;
}

function requestTracker(req, res, next) {
  const startedAt = Date.now();
  res.once('finish', () => {
    const method = req.method.toUpperCase();
    minute.requestTotal += 1;
    if (METHODS.includes(method)) minute.requestsByMethod[method] += 1;
    if (req.user?.id !== undefined) minute.activeUsers.add(String(req.user.id));

    const route = req.route?.path;
    const endpoint = `${method} ${req.baseUrl || ''}${route || req.path}`;
    addLatency(minute.endpointLatency, endpoint, Date.now() - startedAt);
  });
  next();
}

function authAttempt(success) {
  if (success) minute.authSuccess += 1;
  else minute.authFailure += 1;
}

function pizzaPurchase(success, latency, price, quantity = 1) {
  minute.pizzaLatency.count += 1;
  minute.pizzaLatency.totalMs += latency;
  if (success) {
    minute.pizzasSold += quantity;
    minute.revenue += price;
  } else {
    minute.pizzaFailures += 1;
  }
}

module.exports = { requestTracker, authAttempt, pizzaPurchase, sendMetricsPeriodically };
