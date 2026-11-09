const test = require('node:test');
const assert = require('node:assert/strict');
const { Database, Role } = require('../src/database/database.js');
const config = require('../src/config.js');
const { StatusCodeError } = require('../src/endpointHelper.js');

function makeDatabase(resolve = () => []) {
  const calls = [];
  let endCount = 0;
  let beginCount = 0;
  let commitCount = 0;
  let rollbackCount = 0;
  const connection = {
    async execute(sql, params) {
      calls.push({ method: 'execute', sql, params });
      return [await resolve(sql, params), []];
    },
    async query(sql, params) {
      calls.push({ method: 'query', sql, params });
      return [await resolve(sql, params), []];
    },
    async beginTransaction() {
      beginCount += 1;
    },
    async commit() {
      commitCount += 1;
    },
    async rollback() {
      rollbackCount += 1;
    },
    end() {
      endCount += 1;
    },
  };
  let connectionOptions;
  const database = new Database({
    initialize: false,
    createConnection: async (options) => {
      connectionOptions = options;
      return connection;
    },
  });

  return {
    database,
    calls,
    connection,
    get endCount() {
      return endCount;
    },
    get beginCount() {
      return beginCount;
    },
    get commitCount() {
      return commitCount;
    },
    get rollbackCount() {
      return rollbackCount;
    },
    get connectionOptions() {
      return connectionOptions;
    },
  };
}

test('menu, user, role, and authentication queries handle success and missing records', async () => {
  const menuRows = [{ id: 3, title: 'Cheese', price: 0.05 }];
  let authPresent = true;
  const { database, calls } = makeDatabase((sql, params) => {
    if (sql === 'SELECT * FROM menu') return menuRows;
    if (sql.startsWith('INSERT INTO menu')) return { insertId: 9 };
    if (sql.startsWith('INSERT INTO user ')) return { insertId: 12 };
    if (sql === 'SELECT * FROM user WHERE email=?') {
      if (params[0] !== 'diner@example.com') return [];
      return [{ id: 12, name: 'Diner', email: 'diner@example.com', password: 'hash' }];
    }
    if (sql === 'SELECT * FROM userRole WHERE userId=?') return [{ role: Role.Diner, objectId: 0 }];
    if (sql.startsWith('SELECT id FROM franchise')) return [{ id: 4 }];
    if (sql.startsWith('SELECT userId FROM auth')) return authPresent ? [{ userId: 12 }] : [];
    return [];
  });

  assert.deepStrictEqual(await database.getMenu(), menuRows);
  assert.deepStrictEqual(await database.addMenuItem({ title: 'New', price: 0.07 }), {
    title: 'New',
    price: 0.07,
    id: 9,
  });

  const diner = await database.addUser({
    name: 'Diner',
    email: 'diner@example.com',
    password: 'secret',
    roles: [{ role: Role.Diner }],
  });
  assert.equal(diner.id, 12);
  assert.equal(diner.password, undefined);

  const franchisee = await database.addUser({
    name: 'Franchisee',
    email: 'owner@example.com',
    password: 'secret',
    roles: [{ role: Role.Franchisee, object: 'Downtown' }],
  });
  assert.equal(franchisee.id, 12);
  assert.ok(calls.some(({ sql, params }) => sql.includes('INSERT INTO userRole') && params[2] === 4));

  const user = await database.getUser('diner@example.com');
  assert.equal(user.id, 12);
  assert.equal(user.password, undefined);
  assert.deepStrictEqual(user.roles, [{ objectId: undefined, role: Role.Diner }]);
  assert.equal(await database.isLoggedIn('header.payload.signature'), true);
  authPresent = false;
  assert.equal(await database.isLoggedIn('header.payload.signature'), false);

  await assert.rejects(database.getUser('missing@example.com'), (error) => {
    assert.ok(error instanceof StatusCodeError);
    assert.equal(error.statusCode, 404);
    return true;
  });
  await assert.rejects(database.getUser('diner@example.com', 'wrong-password'), { statusCode: 404 });

  await database.loginUser(12, 'header.payload.signature');
  await database.logoutUser('header.payload.signature');
  assert.ok(calls.some(({ sql, params }) => sql.includes('INSERT INTO auth') && params[0] === 'signature'));
  assert.ok(calls.some(({ sql, params }) => sql.includes('DELETE FROM auth') && params[0] === 'signature'));
});

test('user and order queries paginate, attach roles and items, and write order items', async () => {
  let returnEmptyUsers = false;
  const { database, calls } = makeDatabase((sql) => {
    if (sql.startsWith('SELECT id, name, email FROM user')) {
      return returnEmptyUsers ? [] : [
        { id: 1, name: 'Al One', email: 'one@example.com' },
        { id: 2, name: 'Al Two', email: 'two@example.com' },
        { id: 3, name: 'Al Three', email: 'three@example.com' },
      ];
    }
    if (sql === 'SELECT role, objectId FROM userRole WHERE userId=?') {
      return [{ role: Role.Admin, objectId: 1 }];
    }
    if (sql.startsWith('SELECT id, franchiseId, storeId, date FROM dinerOrder')) {
      return [{ id: 21, franchiseId: 5, storeId: 6, date: '2026-01-01' }];
    }
    if (sql.startsWith('SELECT id, menuId, description, price FROM orderItem')) {
      return [{ id: 31, menuId: 7, description: 'Cheese', price: 0.05 }];
    }
    if (sql.startsWith('INSERT INTO dinerOrder')) return { insertId: 42 };
    if (sql === 'SELECT id FROM menu WHERE id=?') return [{ id: 7 }];
    return [];
  });

  const [users, more] = await database.getUsers('1', '2', 'Al*');
  assert.equal(users.length, 2);
  assert.equal(more, true);
  assert.deepStrictEqual(users[0].roles, [{ role: Role.Admin, objectId: 1 }]);
  assert.ok(calls.some(({ sql, params }) => sql.includes('LIMIT ? OFFSET ?') && params[0] === 'Al%'));

  returnEmptyUsers = true;
  const [emptyUsers, noMore] = await database.getUsers('bad-page', 0, '');
  assert.deepStrictEqual(emptyUsers, []);
  assert.equal(noMore, false);
  assert.ok(calls.some(({ sql, params }) => sql.includes('LIMIT ? OFFSET ?') && params[0] === '%'));

  assert.equal(database.getOffset(3, 10), 20);
  const orders = await database.getOrders({ id: 8 }, 2);
  assert.equal(orders.dinerId, 8);
  assert.equal(orders.orders[0].items[0].menuId, 7);
  assert.match(calls.find(({ sql }) => sql.startsWith('SELECT id, franchiseId')).sql, /LIMIT 10,10/);

  const createdOrder = await database.addDinerOrder(
    { id: 8 },
    { franchiseId: 5, storeId: 6, items: [{ menuId: 7, description: 'Cheese', price: 0.05 }] },
  );
  assert.equal(createdOrder.id, 42);
  assert.ok(calls.some(({ sql, params }) => sql.includes('INSERT INTO orderItem') && params[0] === 42));
});

test('user updates and deletes commit on success and roll back on failure', async () => {
  let missingUser = false;
  let failRoleDelete = false;
  const harness = makeDatabase((sql) => {
    if (sql.startsWith('DELETE FROM user WHERE')) return { affectedRows: missingUser ? 0 : 1 };
    if (failRoleDelete && sql.startsWith('DELETE FROM userRole')) throw new Error('delete failed');
    return [];
  });
  const { database, calls } = harness;
  database.getUser = async (email) => ({ id: 5, email, password: undefined });

  const updated = await database.updateUser(5, 'Updated', 'updated@example.com', 'new-password');
  assert.equal(updated.email, 'updated@example.com');
  const updateCall = calls.find(({ sql }) => sql.startsWith('UPDATE user SET'));
  assert.match(updateCall.sql, /password='/);
  assert.match(updateCall.sql, /email='updated@example.com'/);
  assert.match(updateCall.sql, /name='Updated'/);

  await database.updateUser(5);
  assert.equal(calls.filter(({ sql }) => sql.startsWith('UPDATE user SET')).length, 1);

  await database.deleteUser(5);
  assert.equal(harness.commitCount, 1);
  missingUser = true;
  await assert.rejects(database.deleteUser(999), { statusCode: 404 });
  assert.equal(harness.rollbackCount, 1);

  missingUser = false;
  failRoleDelete = true;
  await assert.rejects(database.deleteUser(5), /delete failed/);
  assert.equal(harness.rollbackCount, 2);
});

test('franchise and store operations attach related records and handle failures', async () => {
  let failFranchiseDelete = false;
  let returnManyFranchises = false;
  let franchiseRoleRows = [];
  const harness = makeDatabase((sql, params) => {
    if (sql === 'SELECT id, name FROM user WHERE email=?') {
      return params[0] === 'admin@example.com' ? [{ id: 3, name: 'Admin' }] : [];
    }
    if (sql.startsWith('INSERT INTO franchise')) return { insertId: 15 };
    if (sql.startsWith('INSERT INTO store')) return { insertId: 16 };
    if (sql.startsWith('SELECT id, name FROM franchise WHERE name')) {
      return returnManyFranchises
        ? [{ id: 15, name: 'Main' }, { id: 17, name: 'Second' }]
        : [{ id: 15, name: 'Main' }];
    }
    if (sql.startsWith("SELECT objectId FROM userRole WHERE role='franchisee'")) return franchiseRoleRows;
    if (sql.startsWith('SELECT id, name FROM franchise WHERE id in')) return [{ id: 15, name: 'Main' }];
    if (sql.startsWith('SELECT id, name FROM store')) return [{ id: 16, name: 'Downtown' }];
    if (sql.includes('SELECT u.id, u.name, u.email FROM userRole')) return [{ id: 3, name: 'Admin' }];
    if (sql.includes('SELECT s.id, s.name, COALESCE')) return [{ id: 16, name: 'Downtown', totalRevenue: 5 }];
    if (failFranchiseDelete && sql.startsWith('DELETE FROM store')) throw new Error('write failed');
    return [];
  });
  const { database, calls } = harness;

  const franchise = await database.createFranchise({ name: 'Main', admins: [{ email: 'admin@example.com' }] });
  assert.equal(franchise.id, 15);
  assert.equal(franchise.admins[0].id, 3);
  await assert.rejects(
    database.createFranchise({ name: 'No admin', admins: [{ email: 'missing@example.com' }] }),
    { statusCode: 404 },
  );

  const store = await database.createStore(15, { name: 'Downtown' });
  assert.deepStrictEqual(store, { id: 16, franchiseId: 15, name: 'Downtown' });
  await database.deleteStore(15, 16);

  const storesForUser = await database.getFranchises({ isRole: () => false }, 0, 10, '*');
  assert.equal(storesForUser[0][0].stores[0].id, 16);
  const adminFranchises = await database.getFranchises({ isRole: () => true }, 0, 10, '*');
  assert.equal(adminFranchises[0][0].admins[0].id, 3);
  assert.equal(adminFranchises[0][0].stores[0].totalRevenue, 5);

  returnManyFranchises = true;
  const [firstFranchisePage, hasMoreFranchises] = await database.getFranchises(
    { isRole: () => false },
    0,
    1,
    '*',
  );
  assert.equal(firstFranchisePage.length, 1);
  assert.equal(hasMoreFranchises, true);

  assert.deepStrictEqual(await database.getUserFranchises(99), []);
  franchiseRoleRows = [{ objectId: 15 }];
  const userFranchises = await database.getUserFranchises(3);
  assert.equal(userFranchises[0].id, 15);
  assert.equal(userFranchises[0].stores[0].totalRevenue, 5);

  const noAdmin = await database.createFranchise({ name: 'Will fail', admins: [] });
  assert.equal(noAdmin.id, 15);

  await database.deleteFranchise(15);
  failFranchiseDelete = true;
  await assert.rejects(database.deleteFranchise(15), { statusCode: 500 });
  assert.ok(calls.some(({ sql }) => sql.startsWith('DELETE FROM franchise')));
  assert.equal(harness.rollbackCount, 1);
});

test('connection, token, ID, and initialization helpers use configured MySQL settings', async () => {
  const harness = makeDatabase((sql, params) => {
    if (sql.includes('INFORMATION_SCHEMA.SCHEMATA')) return [{ SCHEMA_NAME: 'pizza' }];
    if (sql === 'SELECT id FROM menu WHERE id=?') return params[0] === 7 ? [{ id: 7 }] : [];
    return [];
  });
  const { database, calls } = harness;

  assert.equal(database.getTokenSignature('one.two.three'), 'three');
  assert.equal(database.getTokenSignature('not-a-jwt'), '');
  assert.equal(await database.getID(harness.connection, 'id', 7, 'menu'), 7);
  await assert.rejects(database.getID(harness.connection, 'id', 8, 'menu'), /No ID found/);
  assert.equal((await database.query(harness.connection, 'SELECT id FROM menu WHERE id=?', [7]))[0].id, 7);
  assert.equal(await database.checkDatabaseExists(harness.connection), true);

  const connection = await database.getConnection();
  assert.strictEqual(connection, harness.connection);
  assert.equal(harness.connectionOptions.host, config.db.connection.host);
  assert.equal(harness.connectionOptions.database, undefined);
  assert.ok(calls.some(({ method, sql }) => method === 'query' && sql === `USE ${config.db.connection.database}`));

  const noUseHarness = makeDatabase();
  await noUseHarness.database._getConnection(false);
  assert.equal(noUseHarness.calls.some(({ sql }) => sql.startsWith('USE ')), false);

  let createdDefaultAdmin = false;
  const freshDatabase = new Database({ initialize: false, createConnection: async () => harness.connection });
  freshDatabase.checkDatabaseExists = async () => false;
  freshDatabase.addUser = async (user) => {
    createdDefaultAdmin = user.roles[0].role === Role.Admin;
  };
  await freshDatabase.initializeDatabase();
  assert.equal(createdDefaultAdmin, true);

  const existingDatabase = new Database({ initialize: false, createConnection: async () => harness.connection });
  existingDatabase.checkDatabaseExists = async () => true;
  await existingDatabase.initializeDatabase();

  const brokenDatabase = new Database({
    initialize: false,
    createConnection: async () => {
      throw new Error('offline');
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await brokenDatabase.initializeDatabase();
  } finally {
    console.error = originalConsoleError;
  }
});
