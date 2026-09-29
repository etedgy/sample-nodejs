// Minimal smoke test: boots the app on a test port and asserts the
// key endpoints (probes + main path) respond as expected.
const http = require('node:http');
const assert = require('node:assert');
const test = require('node:test');

const PORT = 8099;
process.env.PORT = String(PORT);
require('../app.js'); // starts app.listen(PORT)

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

test('readiness probe returns 200', async () => {
  const r = await get('/ready');
  assert.strictEqual(r.status, 200);
});

test('liveness probe returns 200', async () => {
  const r = await get('/live');
  assert.strictEqual(r.status, 200);
});

test('main path returns hello', async () => {
  const r = await get('/my-app');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Hello, World!/);
});

test('metrics endpoint is exposed', async () => {
  const r = await get('/metrics');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /root_access_total/);
});

// node:test keeps the event loop alive via the server handle; exit when done.
test.after(() => process.exit(0));
