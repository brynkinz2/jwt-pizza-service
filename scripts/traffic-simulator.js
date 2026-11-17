const baseUrl = (process.env.PIZZA_SERVICE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const mode = process.argv[2] || 'mixed';
const intervalSeconds = Number(process.env.TRAFFIC_INTERVAL_SECONDS || 5);
const durationSeconds = Number(process.env.TRAFFIC_DURATION_SECONDS || 60);
const email = process.env.JWT_PIZZA_EMAIL;
const password = process.env.JWT_PIZZA_PASSWORD;

const scenarios = {
  success: [{ method: 'GET', path: '/' }],
  database: [{ method: 'GET', path: '/api/order/menu' }],
  notFound: [{ method: 'GET', path: '/api/__traffic_simulator_missing__' }],
  unauthorized: [{ method: 'GET', path: '/api/user/me' }],
  badJson: [{ method: 'POST', path: '/api/auth', body: '{' }],
  authenticated: [{ method: 'GET', path: '/api/order' }],
  mixed: [
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/api/order/menu' },
    { method: 'GET', path: '/api/__traffic_simulator_missing__' },
    { method: 'GET', path: '/api/user/me' },
    { method: 'POST', path: '/api/auth', body: '{' },
    { method: 'GET', path: '/api/order', authenticated: true },
  ],
};

if (!scenarios[mode]) {
  console.error(`Unknown mode "${mode}". Choose: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 600) {
  console.error('TRAFFIC_INTERVAL_SECONDS must be between 1 and 600.');
  process.exit(2);
}
if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 1800) {
  console.error('TRAFFIC_DURATION_SECONDS must be between 1 and 1800.');
  process.exit(2);
}
if (mode === 'authenticated' && (!email || !password)) {
  console.error('Set JWT_PIZZA_EMAIL and JWT_PIZZA_PASSWORD to use the authenticated traffic scenario.');
  process.exit(2);
}

async function send(scenario, token) {
  const headers = {};
  if (scenario.body !== undefined) headers['Content-Type'] = 'application/json';
  if (scenario.authenticated && token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`${baseUrl}${scenario.path}`, {
      method: scenario.method,
      headers,
      body: scenario.body,
    });
    // Read the response so connections can be reused; avoid printing response data.
    await response.arrayBuffer();
    console.log(`${new Date().toISOString()} ${scenario.method} ${scenario.path} ${response.status}`);
  } catch (error) {
    console.error(`${scenario.method} ${scenario.path} failed: ${error.message}`);
  }
}

async function login() {
  if (!email || !password) return null;
  try {
    const response = await fetch(`${baseUrl}/api/auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const result = await response.json();
    if (!response.ok || !result.token) {
      console.error(`Login failed with status ${response.status}; authenticated traffic is skipped.`);
      return null;
    }
    console.log('Authenticated simulator session established.');
    return result.token;
  } catch (error) {
    console.error(`Login request failed: ${error.message}`);
    return null;
  }
}

async function main() {
  const sequence = scenarios[mode].filter((scenario) => !scenario.authenticated || (email && password));
  if (sequence.length < scenarios[mode].length) {
    console.log('No simulator credentials set; skipping the authenticated scenario.');
  }
  const authenticated = sequence.some((scenario) => scenario.authenticated);
  const token = authenticated ? await login() : null;
  if (authenticated && !token) process.exit(1);

  console.log(`Sending ${mode} traffic to ${baseUrl} for up to ${durationSeconds}s, one request every ${intervalSeconds}s. Press Ctrl+C to stop.`);
  const stopAt = Date.now() + durationSeconds * 1000;
  let index = 0;
  while (Date.now() < stopAt) {
    const scenario = sequence[index % sequence.length];
    await send(scenario, token);
    index += 1;
    const remaining = stopAt - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(intervalSeconds * 1000, remaining)));
  }
  console.log(`Traffic simulation complete (${index} requests).`);
}

main();
