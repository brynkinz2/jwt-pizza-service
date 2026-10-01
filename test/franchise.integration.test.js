const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/service.js');
const { DB, Role } = require('../src/database/database.js');

let server;
let baseUrl;
let adminUser;
let franchiseId;

test.before(async () => {
  await DB.initialized;
  const email = `franchise-integration-${process.pid}-${Date.now()}@example.com`;
  adminUser = await DB.addUser({
    name: 'Franchise Integration Admin',
    email,
    password: 'admin-password',
    roles: [{ role: Role.Admin }],
  });

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

  const connection = await DB._getConnection();
  try {
    if (franchiseId) {
      await connection.execute('DELETE FROM store WHERE franchiseId=?', [franchiseId]);
      await connection.execute('DELETE FROM userRole WHERE objectId=?', [franchiseId]);
      await connection.execute('DELETE FROM franchise WHERE id=?', [franchiseId]);
    }
    if (adminUser) {
      await connection.execute('DELETE FROM auth WHERE userId=?', [adminUser.id]);
      await connection.execute('DELETE FROM userRole WHERE userId=?', [adminUser.id]);
      await connection.execute('DELETE FROM user WHERE id=?', [adminUser.id]);
    }
  } finally {
    await connection.end();
  }
});

async function request(path, options) {
  return fetch(`${baseUrl}${path}`, options);
}

test('an admin can create a franchise, store, and franchise listing', async () => {
  const loginResponse = await request('/api/auth', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminUser.email, password: 'admin-password' }),
  });
  const login = await loginResponse.json();
  const authorization = { Authorization: `Bearer ${login.token}` };

  const franchiseResponse = await request('/api/franchise', {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Integration Franchise ${Date.now()}`,
      admins: [{ email: adminUser.email }],
    }),
  });
  const franchise = await franchiseResponse.json();
  franchiseId = franchise.id;

  assert.equal(loginResponse.status, 200);
  assert.equal(franchiseResponse.status, 200);
  assert.equal(franchise.admins[0].email, adminUser.email);

  const storeResponse = await request(`/api/franchise/${franchiseId}/store`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Integration Store' }),
  });
  const store = await storeResponse.json();

  assert.equal(storeResponse.status, 200);
  assert.equal(store.franchiseId, franchiseId);
  assert.equal(store.name, 'Integration Store');

  const listingResponse = await request(`/api/franchise/${adminUser.id}`, { headers: authorization });
  const listing = await listingResponse.json();

  assert.equal(listingResponse.status, 200);
  assert.ok(listing.some((item) => item.id === franchiseId));
});
