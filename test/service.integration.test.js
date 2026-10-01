const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/service.js');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function get(path) {
  return fetch(`${baseUrl}${path}`);
}

test('GET / returns the welcome response', async () => {
  const response = await get('/');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.message, 'welcome to JWT Pizza');
  assert.equal(typeof body.version, 'string');
});

test('GET /api/docs returns endpoint documentation', async () => {
  const response = await get('/api/docs');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(typeof body.version, 'string');
  assert.ok(Array.isArray(body.endpoints));
  assert.ok(body.endpoints.length > 0);
});

test('unknown routes return a not-found response', async () => {
  const response = await get('/not-a-real-route');
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.deepStrictEqual(body, { message: 'unknown endpoint' });
});
