const os = require("os");
const config = require("./config.js").metrics;

const METHODS = ["GET", "PUT", "POST", "DELETE"];
let metricsTimer;
let sending = false;
const retryBatches = [];
const metricStartTimeUnixNano = String(Date.now() * 1_000_000);

function cpuTimes() {
  return os.cpus().reduce((totals, cpu) => {
    for (const [name, value] of Object.entries(cpu.times)) {
      totals[name] = (totals[name] || 0) + value;
    }
    return totals;
  }, {});
}

let previousCpuTimes = cpuTimes();

function newMinute() {
  return {
    activeUsers: new Set(),
    endpointLatency: { count: 0, totalMs: 0 },
    pizzaLatency: { count: 0, totalMs: 0 },
  };
}

let minute = newMinute();
const totals = {
  requestTotal: 0,
  requestsByMethod: Object.fromEntries(METHODS.map((method) => [method, 0])),
  authSuccess: 0,
  authFailure: 0,
  pizzasSold: 0,
  pizzaFailures: 0,
  revenue: 0,
};

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
          ...(type === "sum" ? { startTimeUnixNano: metricStartTimeUnixNano } : {}),
        },
      ],
    },
  };
  if (type === "sum") {
    metric.sum.aggregationTemporality = "AGGREGATION_TEMPORALITY_CUMULATIVE";
    metric.sum.isMonotonic = true;
  }
  return metric;
}

function sampleCpuPercentage() {
  const current = cpuTimes();
  const previousTotal = Object.values(previousCpuTimes).reduce(
    (sum, value) => sum + value,
    0,
  );
  const currentTotal = Object.values(current).reduce(
    (sum, value) => sum + value,
    0,
  );
  const totalDelta = currentTotal - previousTotal;
  const idleDelta = current.idle - previousCpuTimes.idle;
  previousCpuTimes = current;
  return totalDelta > 0
    ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
    : 0;
}

function minuteMetrics() {
  const current = minute;
  minute = newMinute();

  const metrics = [
    makeMetric("http.requests.total", "sum", totals.requestTotal, "1"),
    makeMetric("users.active", "gauge", current.activeUsers.size, "1"),
    makeMetric("auth.attempts", "sum", totals.authSuccess, "1", [
      { key: "outcome", value: { stringValue: "success" } },
    ]),
    makeMetric("auth.attempts", "sum", totals.authFailure, "1", [
      { key: "outcome", value: { stringValue: "failure" } },
    ]),
    makeMetric("pizzas.sold", "sum", totals.pizzasSold, "1"),
    makeMetric("pizzas.creation.failures", "sum", totals.pizzaFailures, "1"),
    makeMetric("pizzas.revenue", "sum", totals.revenue, "USD"),
    makeMetric("system.cpu.utilization", "gauge", sampleCpuPercentage(), "%"),
    makeMetric(
      "system.memory.utilization",
      "gauge",
      ((os.totalmem() - os.freemem()) / os.totalmem()) * 100,
      "%",
    ),
  ];

  for (const method of METHODS) {
    metrics.push(
      makeMetric(
        "http.requests.by_method",
        "sum",
        totals.requestsByMethod[method],
        "1",
        [{ key: "method", value: { stringValue: method } }],
      ),
    );
  }

  if (current.endpointLatency.count > 0) {
    metrics.push(
      makeMetric(
        "http.server.duration.average",
        "gauge",
        current.endpointLatency.totalMs / current.endpointLatency.count,
        "ms",
      ),
    );
  }

  if (current.pizzaLatency.count > 0) {
    metrics.push(
      makeMetric(
        "pizza.creation.duration.average",
        "gauge",
        current.pizzaLatency.totalMs / current.pizzaLatency.count,
        "ms",
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
          attributes: [
            { key: "service.name", value: { stringValue: config.source } },
          ],
        },
        scopeMetrics: [{ metrics }],
      },
    ],
  };
  const response = await fetch(config.endpointUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.accountId}:${config.apiKey}`).toString("base64")}`,
      "Content-Type": "application/json",
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
        console.error("Error sending metrics", error.message);
        break;
      }
    }
  } finally {
    sending = false;
  }
}

function sendMetricsPeriodically(period = 60_000) {
  if (!Number.isFinite(period) || period <= 0) {
    throw new TypeError(
      "Metrics period must be a positive number of milliseconds",
    );
  }
  if (metricsTimer) return metricsTimer;

  metricsTimer = setInterval(() => {
    void flushMetrics();
  }, period);
  metricsTimer.unref?.();
  return metricsTimer;
}

async function flushMetrics() {
  retryBatches.push(minuteMetrics());
  await drainBatches();
}

function stopMetricsPeriodically() {
  if (!metricsTimer) return;
  clearInterval(metricsTimer);
  metricsTimer = undefined;
}

function requestTracker(req, res, next) {
  const startedAt = Date.now();
  res.once("finish", () => {
    const method = req.method.toUpperCase();
    totals.requestTotal += 1;
    if (METHODS.includes(method)) {
      totals.requestsByMethod[method] += 1;
    }
    if (req.user?.id !== undefined) minute.activeUsers.add(String(req.user.id));

    minute.endpointLatency.count += 1;
    minute.endpointLatency.totalMs += Date.now() - startedAt;
  });
  next();
}

function authAttempt(success) {
  if (success) {
    totals.authSuccess += 1;
  } else {
    totals.authFailure += 1;
  }
}

function pizzaPurchase(success, latency, price, quantity = 1) {
  minute.pizzaLatency.count += 1;
  minute.pizzaLatency.totalMs += latency;
  if (success) {
    totals.pizzasSold += quantity;
    totals.revenue += price;
  } else {
    totals.pizzaFailures += 1;
  }
}

module.exports = {
  requestTracker,
  authAttempt,
  pizzaPurchase,
  sendMetricsPeriodically,
  flushMetrics,
  stopMetricsPeriodically,
};
