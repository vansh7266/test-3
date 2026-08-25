const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lightweight built-in .env loader (zero external dependencies required)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    } catch (err) {
      console.warn('[Env] Notice: Could not read .env file:', err.message);
    }
  }
}
loadEnv();

// Configuration loaded from Environment Variables
const getConfig = () => ({
  obynHost: process.env.OBYN_HOST || process.env.PART2_HOST || '',
  apiToken: process.env.OBYN_API_TOKEN || '',
  workspaceId: process.env.WORKSPACE_ID || process.env.OBYN_WORKSPACE_ID || '',
  projectId: process.env.PROJECT_ID || process.env.OBYN_PROJECT_ID || '',
  serviceId: process.env.SERVICE_ID || 'Test-3',
  intervalSeconds: parseInt(process.env.HEARTBEAT_INTERVAL_SECONDS || '60', 10),
  port: parseInt(process.env.PORT || '3000', 10),
});

// Runtime state for manual status switches and heartbeat tracking
const state = {
  currentStatus: (process.env.FORCE_STATUS || 'up').toLowerCase(), // 'up' | 'degraded' | 'down'
  lastHeartbeatSentAt: null,
  nextHeartbeatExpectedAt: null,
  heartbeatCount: 0,
  recentLogs: [], // ring buffer of last 30 heartbeats
  isSending: false,
};

function formatHostUrl(rawHost) {
  if (!rawHost) return '';
  let host = rawHost.trim();
  if (!host.startsWith('http://') && !host.startsWith('https://')) {
    host = `https://${host}`;
  }
  return host.replace(/\/+$/, '');
}

function getHeartbeatUrl() {
  const config = getConfig();
  const baseHost = formatHostUrl(config.obynHost);
  if (!baseHost || !config.workspaceId || !config.projectId) {
    return null;
  }
  return `${baseHost}/v1/workspaces/${encodeURIComponent(config.workspaceId)}/projects/${encodeURIComponent(config.projectId)}/evidence/heartbeats`;
}

/**
 * Send a single heartbeat to Obyn Part 2 API
 */
async function sendHeartbeat(triggerType = 'scheduled') {
  const config = getConfig();
  const url = getHeartbeatUrl();
  const eventId = crypto.randomUUID();
  const observedAt = new Date().toISOString();

  // Determine status code and latency based on current status
  let statusCode = 200;
  let simulatedLatency = Math.floor(Math.random() * 25) + 10; // 10-35ms

  if (state.currentStatus === 'degraded') {
    statusCode = 200;
    simulatedLatency = Math.floor(Math.random() * 300) + 500; // 500-800ms
  } else if (state.currentStatus === 'down') {
    statusCode = 503;
    simulatedLatency = Math.floor(Math.random() * 500) + 1000; // 1000-1500ms
  }

  // Exact strict schema fields for Obyn Part 2 evidence
  const payload = {
    schemaVersion: 'customer-heartbeat-v1',
    heartbeatId: eventId,
    serviceId: config.serviceId,
    observedAt: observedAt,
    status: state.currentStatus,
    statusCode: statusCode,
    latencyMilliseconds: simulatedLatency,
  };

  const headers = {
    'authorization': `Bearer ${config.apiToken}`,
    'content-type': 'application/vnd.obyn.heartbeat+json',
    'x-obyn-event-id': eventId,
    'x-obyn-observed-at': observedAt,
  };

  const logEntry = {
    id: eventId,
    timestamp: observedAt,
    triggerType,
    status: state.currentStatus,
    statusCode,
    latencyMilliseconds: simulatedLatency,
    targetUrl: url || 'NOT_CONFIGURED',
    httpStatus: null,
    responseBody: null,
    error: null,
  };

  if (!url || !config.apiToken) {
    const errorMsg = 'Missing required Obyn configuration (OBYN_HOST, OBYN_API_TOKEN, WORKSPACE_ID, or PROJECT_ID). Heartbeat skipped.';
    console.warn(`[Heartbeat] [${observedAt}] ⚠️  ${errorMsg}`);
    logEntry.error = errorMsg;
    recordLog(logEntry);
    return { success: false, reason: 'unconfigured', logEntry };
  }

  state.isSending = true;
  console.log(`[Heartbeat] [${observedAt}] 📡 Sending heartbeat (${state.currentStatus}) to ${url}...`);

  try {
    const startTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
    });
    const roundTripTime = Date.now() - startTime;

    logEntry.httpStatus = response.status;
    let textResponse = '';
    try {
      textResponse = await response.text();
      logEntry.responseBody = textResponse.slice(0, 500);
    } catch (_) {}

    if (response.ok) {
      console.log(`[Heartbeat] [${observedAt}] ✅ Obyn accepted heartbeat (HTTP ${response.status}) in ${roundTripTime}ms`);
    } else {
      console.error(`[Heartbeat] [${observedAt}] ❌ Obyn rejected heartbeat: HTTP ${response.status} - ${textResponse}`);
      logEntry.error = `HTTP ${response.status}: ${textResponse || response.statusText}`;
    }
  } catch (err) {
    console.error(`[Heartbeat] [${observedAt}] 🚨 Network error dispatching heartbeat:`, err.message);
    logEntry.error = err.message;
  } finally {
    state.isSending = false;
    state.lastHeartbeatSentAt = observedAt;
    state.heartbeatCount += 1;
    recordLog(logEntry);
  }

  return { success: !logEntry.error, logEntry };
}

function recordLog(entry) {
  state.recentLogs.unshift(entry);
  if (state.recentLogs.length > 30) {
    state.recentLogs.pop();
  }
}

// ----------------- Request Handler & Routing -----------------

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        const parsed = {};
        const params = new URLSearchParams(body);
        for (const [k, v] of params.entries()) {
          parsed[k] = v;
        }
        resolve(parsed);
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Serve static files
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }
  if (method === 'GET' && pathname === '/style.css') {
    return sendFile(res, path.join(__dirname, 'public', 'style.css'), 'text/css; charset=utf-8');
  }

  // Healthcheck endpoint
  if (method === 'GET' && pathname === '/health') {
    const config = getConfig();
    return sendJson(res, 200, {
      status: 'ok',
      service: config.serviceId,
      heartbeatStatus: state.currentStatus,
      timestamp: new Date().toISOString(),
    });
  }

  // API Status
  if (method === 'GET' && pathname === '/api/status') {
    const config = getConfig();
    const isConfigured = Boolean(config.obynHost && config.apiToken && config.workspaceId && config.projectId);
    return sendJson(res, 200, {
      service: config.serviceId,
      currentStatus: state.currentStatus,
      isConfigured,
      heartbeatUrl: getHeartbeatUrl(),
      config: {
        serviceId: config.serviceId,
        obynHost: config.obynHost || '(not set)',
        workspaceId: config.workspaceId || '(not set)',
        projectId: config.projectId || '(not set)',
        intervalSeconds: config.intervalSeconds,
        apiTokenConfigured: Boolean(config.apiToken),
      },
      heartbeat: {
        count: state.heartbeatCount,
        lastSentAt: state.lastHeartbeatSentAt,
        nextExpectedAt: state.nextHeartbeatExpectedAt,
        isSending: state.isSending,
      },
      recentLogs: state.recentLogs.slice(0, 10),
    });
  }

  // Manual status change via POST
  if (method === 'POST' && pathname === '/api/status') {
    const body = await readBody(req);
    const newStatus = (body.status || '').toLowerCase();
    if (!['up', 'degraded', 'down'].includes(newStatus)) {
      return sendJson(res, 400, {
        error: 'Invalid status. Must be "up", "degraded", or "down".',
      });
    }

    const previousStatus = state.currentStatus;
    state.currentStatus = newStatus;
    console.log(`[Manual Switch] 🎛️  Status manually changed from "${previousStatus}" to "${newStatus}"`);

    return sendJson(res, 200, {
      success: true,
      previousStatus,
      currentStatus: state.currentStatus,
      message: `Status updated to ${newStatus}. Next heartbeat will report "${newStatus}".`,
    });
  }

  // Manual status change via GET /status/set?status=down
  if (method === 'GET' && pathname === '/status/set') {
    const newStatus = (parsedUrl.searchParams.get('status') || '').toLowerCase();
    if (!['up', 'degraded', 'down'].includes(newStatus)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Invalid status. Use ?status=up, ?status=degraded, or ?status=down');
    }

    const previousStatus = state.currentStatus;
    state.currentStatus = newStatus;
    console.log(`[Manual Switch] 🎛️  Status changed via GET /status/set to "${newStatus}"`);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return sendJson(res, 200, { success: true, previousStatus, currentStatus: newStatus });
    }
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // Trigger heartbeat immediately via POST
  if (method === 'POST' && pathname === '/api/heartbeat/trigger') {
    const result = await sendHeartbeat('manual');
    return sendJson(res, 200, result);
  }

  // Trigger heartbeat immediately via GET /heartbeat/send
  if (method === 'GET' && pathname === '/heartbeat/send') {
    await sendHeartbeat('manual');
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  // Logs endpoint
  if (method === 'GET' && pathname === '/api/logs') {
    return sendJson(res, 200, state.recentLogs);
  }

  // 404 for other paths
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
}

// Start Background Heartbeat Scheduler
let heartbeatTimer = null;

function startScheduler() {
  const config = getConfig();
  const intervalMs = Math.max(5000, config.intervalSeconds * 1000);

  const scheduleNext = () => {
    state.nextHeartbeatExpectedAt = new Date(Date.now() + intervalMs).toISOString();
  };

  sendHeartbeat('startup');
  scheduleNext();

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    await sendHeartbeat('scheduled');
    scheduleNext();
  }, intervalMs);

  console.log(`[Scheduler] ⏱️  Heartbeat scheduled every ${config.intervalSeconds}s`);
}

const serverConfig = getConfig();
const server = http.createServer(handleRequest);

server.listen(serverConfig.port, () => {
  console.log(`====================================================`);
  console.log(`🚀 Test-3 Service listening on port ${serverConfig.port}`);
  console.log(`   Homepage:       http://localhost:${serverConfig.port}`);
  console.log(`   Service ID:     ${serverConfig.serviceId}`);
  console.log(`   Initial Status: ${state.currentStatus.toUpperCase()}`);
  console.log(`====================================================`);
  startScheduler();
});

module.exports = { server, sendHeartbeat, state, getConfig, handleRequest };
