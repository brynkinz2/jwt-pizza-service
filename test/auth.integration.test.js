const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/service.js');
const { DB } = require('../src/database/database.js');

let server;
let baseUrl;
let createdUserId;

test.before(async () => {
  await DB.initialized;
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  if (createdUserId) {
    const connection = await DB._getConnection();
    try {
      await connection.execute('DELETE FROM auth WHERE userId=?', [createdUserId]);
      await connection.execute('DELETE FROM userRole WHERE userId=?', [createdUserId]);
      await connection.execute('DELETE FROM user WHERE id=?', [createdUserId]);
    } finally {
      await connection.end();
    }
  }
});

async function request(path, options) {
  return fetch(`${baseUrl}${path}`, options);
}

test('protected routes reject requests without a token', async () => {
  const response = await request('/api/user/me');
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepStrictEqual(body, { message: 'unauthorized' });
});

test('a user can register, log in, and access their profile', async () => {
  const email = `integration-${process.pid}-${Date.now()}@example.com`;
  const userDetails = { name: 'Integration User', email, password: 'test-password' };
  const requestOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userDetails),
  };

  const registrationResponse = await request('/api/auth', requestOptions);
  const registration = await registrationResponse.json();
  createdUserId = registration.user.id;

  assert.equal(registrationResponse.status, 200);
  assert.equal(registration.user.email, email);
  assert.equal(typeof registration.token, 'string');

  const loginResponse = await request('/api/auth', {
    ...requestOptions,
    method: 'PUT',
  });
  const login = await loginResponse.json();

  assert.equal(loginResponse.status, 200);
  assert.equal(login.user.id, createdUserId);
  assert.equal(typeof login.token, 'string');

  const profileResponse = await request('/api/user/me', {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  const profile = await profileResponse.json();

  assert.equal(profileResponse.status, 200);
  assert.equal(profile.id, createdUserId);
  assert.equal(profile.email, email);
});
