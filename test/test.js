const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

// Configure test environment variables before requiring server
process.env.PORT = '3000';
process.env.OBYN_HOST = 'https://api.obyn.example.com';
process.env.OBYN_API_TOKEN = 'test_secret_token_abc123';
process.env.WORKSPACE_ID = 'test-workspace-uuid';
process.env.PROJECT_ID = 'test-project-uuid';
process.env.SERVICE_ID = 'Test-3';
process.env.HEARTBEAT_INTERVAL_SECONDS = '60';

const { server, sendHeartbeat, state, getConfig, handleRequest } = require('../server');

// Helper to simulate HTTP requests to handleRequest directly without TCP network sockets
function simulateRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = new Readable({
      read() {
        if (body) {
          this.push(typeof body === 'string' ? body : JSON.stringify(body));
        }
        this.push(null);
      }
    });
    req.method = method;
    req.url = urlPath;
    req.headers = { host: 'localhost:3000', ...headers };

    let statusCode = 200;
    const resHeaders = {};
    const chunks = [];

    const res = new EventEmitter();
    res.writeHead = (status, hdrs) => {
      statusCode = status;
      if (hdrs) Object.assign(resHeaders, hdrs);
    };
    res.setHeader = (k, v) => { resHeaders[k.toLowerCase()] = v; };
    res.write = (chunk) => { chunks.push(Buffer.from(chunk)); };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      const responseText = Buffer.concat(chunks).toString('utf8');
      let responseJson = null;
      try { responseJson = JSON.parse(responseText); } catch (_) {}
      resolve({
        statusCode,
        headers: resHeaders,
        body: responseText,
        json: responseJson,
      });
    };

    handleRequest(req, res);
  });
}

async function runTests() {
  console.log('🧪 Starting Test-3 Unit & Schema Validation Suite...\n');

  try {
    // ----------------------------------------------------
    // Test 1: GET /health
    // ----------------------------------------------------
    console.log('--- Test 1: GET /health ---');
    const healthRes = await simulateRequest('GET', '/health');
    assert.strictEqual(healthRes.statusCode, 200);
    assert.strictEqual(healthRes.json.status, 'ok');
    assert.strictEqual(healthRes.json.service, 'Test-3');
    console.log('✓ Healthcheck endpoint responds with 200 OK and expected structure');

    // ----------------------------------------------------
    // Test 2: GET / (Homepage) & /style.css
    // ----------------------------------------------------
    console.log('\n--- Test 2: Static UI Endpoints ---');
    const indexRes = await simulateRequest('GET', '/');
    assert.strictEqual(indexRes.statusCode, 200);
    assert.ok(indexRes.body.includes('Test-3 is up') || indexRes.body.includes('Test-3'));

    const cssRes = await simulateRequest('GET', '/style.css');
    assert.strictEqual(cssRes.statusCode, 200);
    assert.ok(cssRes.body.includes('--color-up'));
    console.log('✓ Homepage and static styles served cleanly');

    // ----------------------------------------------------
    // Test 3: Obyn Heartbeat Dispatch (Status: UP)
    // ----------------------------------------------------
    console.log('\n--- Test 3: Strict Schema Verification for Status: UP ---');
    let capturedFetch = null;
    const originalFetch = global.fetch;

    global.fetch = async (url, options) => {
      capturedFetch = { url, options };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ acknowledged: true, eventId: options.headers['x-obyn-event-id'] }),
      };
    };

    state.currentStatus = 'up';
    const resultUp = await sendHeartbeat('test_up');
    assert.strictEqual(resultUp.success, true);
    assert.ok(capturedFetch, 'global.fetch must have been called');

    // URL verification
    assert.strictEqual(
      capturedFetch.url,
      'https://api.obyn.example.com/v1/workspaces/test-workspace-uuid/projects/test-project-uuid/evidence/heartbeats'
    );

    // Headers verification
    const reqHeaders = capturedFetch.options.headers;
    assert.strictEqual(reqHeaders['authorization'], 'Bearer test_secret_token_abc123');
    assert.strictEqual(reqHeaders['content-type'], 'application/vnd.obyn.heartbeat+json');
    assert.ok(reqHeaders['x-obyn-event-id'], 'x-obyn-event-id must exist');
    assert.ok(reqHeaders['x-obyn-observed-at'], 'x-obyn-observed-at must exist');

    // Body strict schema verification
    const reqBody = JSON.parse(capturedFetch.options.body);
    assert.strictEqual(reqBody.schemaVersion, 'customer-heartbeat-v1');
    assert.strictEqual(reqBody.heartbeatId, reqHeaders['x-obyn-event-id']);
    assert.strictEqual(reqBody.serviceId, 'Test-3');
    assert.strictEqual(reqBody.observedAt, reqHeaders['x-obyn-observed-at']);
    assert.strictEqual(reqBody.status, 'up');
    assert.strictEqual(reqBody.statusCode, 200);
    assert.strictEqual(typeof reqBody.latencyMilliseconds, 'number');

    // Ensure NO extra fields exist in the body
    const allowedFields = ['schemaVersion', 'heartbeatId', 'serviceId', 'observedAt', 'status', 'statusCode', 'latencyMilliseconds'];
    for (const key of Object.keys(reqBody)) {
      assert.ok(allowedFields.includes(key), `Disallowed field in payload: ${key}`);
    }
    console.log('✓ UP Heartbeat payload strictly matches Obyn Part 2 evidence schema');

    // ----------------------------------------------------
    // Test 4: Manual Incident Switch to DOWN
    // ----------------------------------------------------
    console.log('\n--- Test 4: Manual Incident Switch to DOWN ---');
    const downRes = await simulateRequest('POST', '/api/status', {}, { status: 'down' });
    assert.strictEqual(downRes.statusCode, 200);
    assert.strictEqual(downRes.json.currentStatus, 'down');

    capturedFetch = null;
    await sendHeartbeat('test_down_dispatch');
    assert.ok(capturedFetch);
    const downBody = JSON.parse(capturedFetch.options.body);
    assert.strictEqual(downBody.status, 'down');
    assert.strictEqual(downBody.statusCode, 503);
    assert.strictEqual(downBody.schemaVersion, 'customer-heartbeat-v1');
    console.log('✓ Manual switch successfully forces DOWN status with 503 status code');

    // ----------------------------------------------------
    // Test 5: Manual Switch to DEGRADED
    // ----------------------------------------------------
    console.log('\n--- Test 5: Manual Switch to DEGRADED ---');
    const degradedRes = await simulateRequest('POST', '/api/status', {}, { status: 'degraded' });
    assert.strictEqual(degradedRes.statusCode, 200);
    assert.strictEqual(degradedRes.json.currentStatus, 'degraded');

    capturedFetch = null;
    await sendHeartbeat('test_degraded_dispatch');
    assert.ok(capturedFetch);
    const degradedBody = JSON.parse(capturedFetch.options.body);
    assert.strictEqual(degradedBody.status, 'degraded');
    assert.strictEqual(degradedBody.schemaVersion, 'customer-heartbeat-v1');
    console.log('✓ Manual switch successfully forces DEGRADED status');

    // ----------------------------------------------------
    // Test 6: URL Switch via GET /status/set?status=up
    // ----------------------------------------------------
    console.log('\n--- Test 6: GET /status/set?status=up ---');
    const getSwitchRes = await simulateRequest('GET', '/status/set?status=up', { accept: 'application/json' });
    assert.strictEqual(getSwitchRes.statusCode, 200);
    assert.strictEqual(getSwitchRes.json.currentStatus, 'up');
    assert.strictEqual(state.currentStatus, 'up');
    console.log('✓ Quick URL switch /status/set operates correctly');

    // ----------------------------------------------------
    // Test 7: GET /api/status & /api/logs
    // ----------------------------------------------------
    console.log('\n--- Test 7: GET /api/status and /api/logs ---');
    const statusApiRes = await simulateRequest('GET', '/api/status');
    assert.strictEqual(statusApiRes.statusCode, 200);
    assert.strictEqual(statusApiRes.json.service, 'Test-3');
    assert.strictEqual(statusApiRes.json.isConfigured, true);
    assert.ok(statusApiRes.json.recentLogs.length > 0);

    const logsApiRes = await simulateRequest('GET', '/api/logs');
    assert.strictEqual(logsApiRes.statusCode, 200);
    assert.ok(Array.isArray(logsApiRes.json));
    console.log('✓ API status and logs endpoints return expected telemetry');

    // Restore fetch
    global.fetch = originalFetch;

    console.log('\n=========================================');
    console.log('🎉 ALL AUTOMATED TESTS PASSED (7/7)!');
    console.log('=========================================\n');
  } catch (err) {
    console.error('\n❌ Test failure:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit(process.exitCode || 0);
  }
}

runTests();
