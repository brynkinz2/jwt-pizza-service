const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/service.js');
const config = require('../src/config.js');
const { DB, Role } = require('../src/database/database.js');

let server;
let baseUrl;
let adminUser;
let dinerUser;
let franchiseId;
let storeId;
let menuId;
let orderId;

test.before(async () => {
  await DB.initialized;

  adminUser = await DB.addUser({
    name: 'Order Integration Admin',
    email: `order-admin-${process.pid}-${Date.now()}@example.com`,
    password: 'admin-password',
    roles: [{ role: Role.Admin }],
  });
  dinerUser = await DB.addUser({
    name: 'Order Integration Diner',
    email: `order-diner-${process.pid}-${Date.now()}@example.com`,
    password: 'diner-password',
    roles: [{ role: Role.Diner }],
  });

  const franchise = await DB.createFranchise({
    name: `Order Integration Franchise ${Date.now()}`,
    admins: [{ email: adminUser.email }],
  });
  franchiseId = franchise.id;

  const store = await DB.createStore(franchiseId, { name: 'Order Integration Store' });
  storeId = store.id;

  const menuItem = await DB.addMenuItem({
    title: 'Integration Pizza',
    description: 'Pizza for integration testing',
    image: 'integration.png',
    price: 0.05,
  });
  menuId = menuItem.id;

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
    if (orderId) {
      await connection.execute('DELETE FROM orderItem WHERE orderId=?', [orderId]);
      await connection.execute('DELETE FROM dinerOrder WHERE id=?', [orderId]);
    }
    if (menuId) {
      await connection.execute('DELETE FROM menu WHERE id=?', [menuId]);
    }
    if (storeId) {
      await connection.execute('DELETE FROM store WHERE id=?', [storeId]);
    }
    if (franchiseId) {
      await connection.execute('DELETE FROM userRole WHERE objectId=?', [franchiseId]);
      await connection.execute('DELETE FROM franchise WHERE id=?', [franchiseId]);
    }
    for (const user of [adminUser, dinerUser]) {
      if (user) {
        await connection.execute('DELETE FROM auth WHERE userId=?', [user.id]);
        await connection.execute('DELETE FROM userRole WHERE userId=?', [user.id]);
        await connection.execute('DELETE FROM user WHERE id=?', [user.id]);
      }
    }
  } finally {
    await connection.end();
  }
});

async function request(path, options) {
  return fetch(`${baseUrl}${path}`, options);
}

test('a diner can place an order and receive the factory response', async () => {
  const loginResponse = await request('/api/auth', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: dinerUser.email, password: 'diner-password' }),
  });
  const login = await loginResponse.json();

  const orderRequest = {
    franchiseId,
    storeId,
    items: [{ menuId, description: 'Pizza for integration testing', price: 0.05 }],
  };
  const realFetch = global.fetch;
  let factoryRequest;
  global.fetch = async (url, options) => {
    if (url === `${config.factory.url}/api/order`) {
      factoryRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ reportUrl: 'https://factory.example/report', jwt: 'factory-test-token' }),
      };
    }
    return realFetch(url, options);
  };

  let orderResponse;
  let order;
  try {
    orderResponse = await request('/api/order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.token}`,
      },
      body: JSON.stringify(orderRequest),
    });
    order = await orderResponse.json();
  } finally {
    global.fetch = realFetch;
  }
  orderId = order.order.id;

  assert.equal(loginResponse.status, 200);
  assert.equal(orderResponse.status, 200);
  assert.equal(order.order.franchiseId, franchiseId);
  assert.equal(order.order.storeId, storeId);
  assert.equal(order.order.items[0].menuId, menuId);
  assert.equal(order.followLinkToEndChaos, 'https://factory.example/report');
  assert.equal(order.jwt, 'factory-test-token');
  assert.equal(factoryRequest.diner.id, dinerUser.id);
  assert.equal(factoryRequest.order.id, orderId);
});
