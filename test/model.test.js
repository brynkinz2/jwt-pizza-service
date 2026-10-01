const test = require('node:test');
const assert = require('node:assert/strict');
const { Role } = require('../src/model/model.js');

test('Role defines the supported user roles', () => {
  assert.deepStrictEqual(Role, {
    Diner: 'diner',
    Franchisee: 'franchisee',
    Admin: 'admin',
  });
});
