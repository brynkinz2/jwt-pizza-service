const test = require('node:test');
const assert = require('node:assert/strict');
const { tableCreateStatements } = require('../src/database/dbModel.js');

test('database model defines every required table', () => {
  const expectedTables = ['auth', 'user', 'menu', 'franchise', 'store', 'userRole', 'dinerOrder', 'orderItem'];

  assert.equal(tableCreateStatements.length, expectedTables.length);
  for (const table of expectedTables) {
    assert.ok(tableCreateStatements.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)), `missing ${table} table`);
  }
});
