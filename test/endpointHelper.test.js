const test = require('node:test');
const assert = require('node:assert/strict');
const { asyncHandler, StatusCodeError } = require('../src/endpointHelper.js');

test('StatusCodeError keeps its message and status code', () => {
  const error = new StatusCodeError('bad request', 400);

  assert.equal(error.message, 'bad request');
  assert.equal(error.statusCode, 400);
});

test('asyncHandler forwards rejected promises to next', async () => {
  const error = new Error('request failed');
  let receivedError;
  const next = (nextError) => {
    receivedError = nextError;
  };
  const handler = asyncHandler(async () => {
    throw error;
  });

  await handler({}, {}, next);

  assert.strictEqual(receivedError, error);
});
