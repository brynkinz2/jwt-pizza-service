const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();
const sensitiveKey = /(authorization|password|passwd|token|secret|api.?key|credential|email|name|phone|address|report.?url|stack)/i;
const source = process.env.GRAFANA_SOURCE || 'jwt-pizza-service';
const endpoint = process.env.GRAFANA_LOKI_URL || 'https://logs-prod-021.grafana.net/loki/api/v1/push';

function sanitize(value, key = '') {
  if (/^authorizationHeader$/i.test(key) && typeof value === 'boolean') return value;
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (Buffer.isBuffer(value)) return sanitize(value.toString('utf8'), key);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  }

  const text = String(value);
  if (/^[\[{]/.test(text.trim())) {
    try {
      return sanitize(JSON.parse(text));
    } catch {
      // Non-JSON text is handled by the text sanitizers below.
    }
  }

  return text
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(password|passwd|token|secret|api.?key|authorization)\s*[:=]\s*([^,;\s]+)/gi, '$1=[REDACTED]');
}

function safePath(originalUrl = '') {
  const [pathname, query] = originalUrl.split('?');
  if (!query) return pathname;
  const redactedQuery = query.split('&').map((part) => `${part.split('=')[0]}=[REDACTED]`).join('&');
  return `${pathname}?${redactedQuery}`;
}

function requestContext(req, res, next) {
  context.run({ userId: null }, next);
}

function setUser(user) {
  const request = context.getStore();
  if (request) request.userId = user?.id ?? null;
}

function currentUserId() {
  return context.getStore()?.userId ?? null;
}

function statusToLevel(statusCode) {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

function httpLogger(req, res, next) {
  const originalSend = res.send;
  res.send = function loggedSend(body) {
    const event = {
      method: req.method,
      path: safePath(req.originalUrl),
      statusCode: res.statusCode,
      authorizationHeader: Boolean(req.headers.authorization),
      userId: currentUserId(),
      requestBody: sanitize(req.body ?? null),
      responseBody: sanitize(body),
    };
    log(statusToLevel(res.statusCode), 'http', event);
    res.send = originalSend;
    return originalSend.call(this, body);
  };
  next();
}

function logDatabaseQuery(sql) {
  // Parameters are intentionally omitted; inline SQL literals are masked too.
  const safeSql = String(sql).replace(/'([^']|'')*'/g, '?').replace(/\b\d+\b/g, '?');
  log('info', 'database', { userId: currentUserId(), query: safeSql });
}

function logFactoryRequest(requestBody, responseBody, statusCode) {
  log(statusToLevel(statusCode), 'factory', {
    userId: currentUserId(),
    requestBody: sanitize(requestBody),
    responseBody: sanitize(responseBody),
    statusCode,
  });
}

function logException(error, req) {
  log('error', 'exception', {
    method: req?.method,
    path: safePath(req?.originalUrl),
    userId: currentUserId(),
    name: error?.name || 'Error',
    message: sanitize(error?.message || 'Unhandled exception'),
  });
}

function log(level, type, event) {
  const accountId = process.env.GRAFANA_ACCOUNT_ID;
  const apiKey = process.env.GRAFANA_API_KEY;
  if (!accountId || !apiKey) return;

  const timestamp = (Date.now() * 1_000_000).toString();
  const payload = {
    streams: [{
      stream: { component: source, level, type },
      values: [[timestamp, JSON.stringify(sanitize(event))]],
    }],
  };

  // Logging must not interfere with serving requests, and Grafana errors must not
  // print credentials or request contents to application logs.
  Promise.resolve().then(() => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accountId}:${apiKey}`,
    },
    body: JSON.stringify(payload),
  })).then((response) => {
    if (!response.ok) console.error(`Grafana log delivery failed (${response.status})`);
  }).catch(() => console.error('Grafana log delivery failed'));
}

module.exports = {
  requestContext,
  setUser,
  httpLogger,
  logDatabaseQuery,
  logFactoryRequest,
  logException,
};
