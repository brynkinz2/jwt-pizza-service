const test = require('node:test');
const assert = require('node:assert/strict');
const { StatusCodeError } = require('../src/endpointHelper.js');

test('StatusCodeError keeps its message and status code', () => {
  const error = new StatusCodeError('bad request', 400);

  assert.equal(error.message, 'bad request');
  assert.equal(error.statusCode, 400);
});
