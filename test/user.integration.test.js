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

test('a user can update their profile and use the new token', async () => {
  const originalEmail = `user-integration-${process.pid}-${Date.now()}@example.com`;
  const originalUser = { name: 'Original User', email: originalEmail, password: 'original-password' };
  const registrationResponse = await request('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(originalUser),
  });
  const registration = await registrationResponse.json();
  createdUserId = registration.user.id;

  const updatedUser = {
    name: 'Updated User',
    email: `updated-${originalEmail}`,
    password: 'updated-password',
  };
  const updateResponse = await request(`/api/user/${createdUserId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${registration.token}`,
    },
    body: JSON.stringify(updatedUser),
  });
  const update = await updateResponse.json();

  assert.equal(registrationResponse.status, 200);
  assert.equal(updateResponse.status, 200);
  assert.equal(update.user.id, createdUserId);
  assert.equal(update.user.name, updatedUser.name);
  assert.equal(update.user.email, updatedUser.email);
  assert.equal(typeof update.token, 'string');

  const profileResponse = await request('/api/user/me', {
    headers: { Authorization: `Bearer ${update.token}` },
  });
  const profile = await profileResponse.json();

  assert.equal(profileResponse.status, 200);
  assert.equal(profile.name, updatedUser.name);
  assert.equal(profile.email, updatedUser.email);
});
