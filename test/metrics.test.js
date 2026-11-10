const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const metrics = require('../src/metrics.js');

function trackRequest(method, userId, baseUrl, routePath) {
  const req = {
    method,
    path: '/fallback',
    baseUrl,
    route: routePath ? { path: routePath } : undefined,
    user: userId === undefined ? undefined : { id: userId },
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  let calledNext = false;

  metrics.requestTracker(req, res, () => {
    calledNext = true;
  });
  assert.equal(calledNext, true);
  res.emit('finish');
}

function getPayload(batch) {
  return batch.resourceMetrics[0].scopeMetrics[0].metrics;
}

function findMetric(batch, name, attributeName, attributeValue) {
  return getPayload(batch).find((metric) => {
    if (metric.name !== name) return false;
    if (attributeName === undefined) return true;
    return metric[metric.sum ? 'sum' : 'gauge'].dataPoints[0].attributes.some(
      (attribute) =>
        attribute.key === attributeName &&
        Object.values(attribute.value)[0] === attributeValue,
    );
  });
}

function metricValue(metric) {
  const kind = metric.sum ? 'sum' : 'gauge';
  return metric[kind].dataPoints[0].asDouble;
}

test('batches minute metrics and retries failed Grafana sends', async (t) => {
  const realFetch = global.fetch;
  const realConsoleError = console.error;
  const sentBatches = [];
  const responses = [
    { ok: false, status: 503 },
    { ok: true, status: 200 },
    { ok: true, status: 200 },
    { ok: true, status: 200 },
    { ok: true, status: 200 },
    { ok: true, status: 200 },
  ];
  global.fetch = async (_url, options) => {
    sentBatches.push(JSON.parse(options.body));
    return responses.shift() || { ok: true, status: 200 };
  };
  console.error = () => {};
  t.after(() => {
    metrics.stopMetricsPeriodically();
    global.fetch = realFetch;
    console.error = realConsoleError;
  });

  trackRequest('GET', 'user-1', '/api/order', '/menu');
  trackRequest('GET', 'user-1', '/api/order', '/menu');
  trackRequest('POST', 'user-2', '/api/order', '/');
  trackRequest('PUT', undefined, '/api/user', '/:userId');
  trackRequest('DELETE', undefined, '/api/user', '/:userId');
  trackRequest('OPTIONS', undefined, '', undefined);

  metrics.authAttempt(true);
  metrics.authAttempt(false);
  metrics.authAttempt(false);
  metrics.pizzaPurchase(true, 120, 13.5, 2);
  metrics.pizzaPurchase(true, 80, 2.5);
  metrics.pizzaPurchase(false, 40, 0, 1);

  await metrics.flushMetrics();
  assert.equal(sentBatches.length, 1);
  const failedSendBatch = sentBatches[0];
  const firstMetrics = getPayload(failedSendBatch);

  assert.equal(metricValue(findMetric(failedSendBatch, 'http.requests.total')), 6);
  assert.equal(
    metricValue(findMetric(failedSendBatch, 'http.requests.by_method', 'method', 'GET')),
    2,
  );
  assert.equal(
    metricValue(findMetric(failedSendBatch, 'http.requests.by_method', 'method', 'POST')),
    1,
  );
  assert.equal(
    metricValue(findMetric(failedSendBatch, 'http.requests.by_method', 'method', 'PUT')),
    1,
  );
  assert.equal(
    metricValue(findMetric(failedSendBatch, 'http.requests.by_method', 'method', 'DELETE')),
    1,
  );
  assert.equal(metricValue(findMetric(failedSendBatch, 'users.active')), 2);
  assert.equal(
    metricValue(findMetric(failedSendBatch, 'auth.attempts', 'outcome', 'success')),
    1,
  );
  assert.equal(
    metricValue(findMetric(failedSendBatch, 'auth.attempts', 'outcome', 'failure')),
    2,
  );
  assert.equal(metricValue(findMetric(failedSendBatch, 'pizzas.sold')), 3);
  assert.equal(metricValue(findMetric(failedSendBatch, 'pizzas.creation.failures')), 1);
  assert.equal(metricValue(findMetric(failedSendBatch, 'pizzas.revenue')), 16);
  assert.ok(findMetric(failedSendBatch, 'system.cpu.utilization'));
  assert.ok(findMetric(failedSendBatch, 'system.memory.utilization'));
  const serviceLatency = findMetric(failedSendBatch, 'http.server.duration.average');
  assert.ok(serviceLatency);
  assert.deepStrictEqual(serviceLatency.gauge.dataPoints[0].attributes, []);
  assert.equal(metricValue(findMetric(failedSendBatch, 'pizza.creation.duration.average')), 80);
  assert.ok(firstMetrics.every((metric) => metric.unit));
  assert.ok(
    firstMetrics
      .filter((metric) => metric.sum)
      .every((metric) => metric.sum.aggregationTemporality === 'AGGREGATION_TEMPORALITY_CUMULATIVE'),
  );

  // The failed minute is retried before the next minute's metrics are sent.
  metrics.authAttempt(true);
  await metrics.flushMetrics();
  assert.equal(sentBatches.length, 3);
  assert.deepStrictEqual(sentBatches[1], failedSendBatch);
  assert.equal(metricValue(findMetric(sentBatches[2], 'auth.attempts', 'outcome', 'success')), 2);

  // A quiet minute still reports zero counters and active users, but no latency sample.
  await metrics.flushMetrics();
  const quietMinute = sentBatches[3];
  assert.equal(metricValue(findMetric(quietMinute, 'http.requests.total')), 6);
  assert.equal(metricValue(findMetric(quietMinute, 'users.active')), 0);
  assert.equal(metricValue(findMetric(quietMinute, 'auth.attempts', 'outcome', 'success')), 2);
  assert.equal(findMetric(quietMinute, 'pizza.creation.duration.average'), undefined);

  assert.throws(() => metrics.sendMetricsPeriodically(0), /positive number/);
  const timer = metrics.sendMetricsPeriodically(10);
  assert.strictEqual(metrics.sendMetricsPeriodically(20), timer);
  const sendCountBeforeTimer = sentBatches.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  metrics.stopMetricsPeriodically();
  assert.ok(sentBatches.length > sendCountBeforeTimer);
});
