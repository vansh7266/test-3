# Test-3

Minimal throwaway Node.js web service to production-test the **Obyn Part 2** monitoring pipeline and incident response system.

---

## Features

1. **Homepage Status Dashboard**: Serves a clean, live-polling dashboard ("Test-3 is up") with real-time status and logs.
2. **Periodic Heartbeat Dispatch**: Sends strict Obyn evidence heartbeats on schedule (~60s interval) to `https://<part2-host>/v1/workspaces/{workspaceId}/projects/{projectId}/evidence/heartbeats`.
3. **Strict Evidence Schema Compliance**:
   - **Headers**:
     - `authorization`: `Bearer <OBYN_API_TOKEN>`
     - `content-type`: `application/vnd.obyn.heartbeat+json`
     - `x-obyn-event-id`: `<UUID>`
     - `x-obyn-observed-at`: `<ISO 8601 Timestamp>`
   - **Payload**:
     - `schemaVersion`: `"customer-heartbeat-v1"`
     - `heartbeatId`: `<UUID>`
     - `serviceId`: `<SERVICE_ID>`
     - `observedAt`: `<ISO 8601 Timestamp>`
     - `status`: `"up" | "degraded" | "down"`
     - `statusCode`: `<number>`
     - `latencyMilliseconds`: `<number>`
4. **Manual Incident Switch**:
   - Interactive buttons in the web UI.
   - REST API `POST /api/status` with `{"status": "down" | "degraded" | "up"}`.
   - Quick browser link `GET /status/set?status=down`.
   - On-demand dispatch button `POST /api/heartbeat/trigger` or `GET /heartbeat/send`.
5. **Zero-Config Deployment**: Dockerfile and configuration ready for **Railway**, **Vercel**, or any Node.js host.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your Obyn Part 2 parameters:

```bash
cp .env.example .env
```

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `OBYN_HOST` / `PART2_HOST` | **Yes** | Host URL of Obyn Part 2 instance | `https://api.obyn.ai` |
| `OBYN_API_TOKEN` | **Yes** | Bearer API token for Obyn ingestion | `obyn_live_...` |
| `WORKSPACE_ID` | **Yes** | Obyn workspace UUID / ID | `ws-12345` |
| `PROJECT_ID` | **Yes** | Obyn project UUID / ID | `proj-67890` |
| `SERVICE_ID` | No | Service identifier (default: `Test-3`) | `Test-3` |
| `HEARTBEAT_INTERVAL_SECONDS` | No | Dispatch interval in seconds (default: `60`) | `60` |
| `PORT` | No | Server port (default: `3000`) | `3000` |
| `FORCE_STATUS` | No | Initial forced status (`up`, `degraded`, `down`) | `up` |

---

## Getting Started

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Obyn parameters

# 3. Start the service
npm start
```

Visit `http://localhost:3000` to view the status dashboard and interactive incident switch.

---

## Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Status dashboard & interactive switch UI |
| `GET` | `/health` | Lightweight service healthcheck (`{"status": "ok"}`) |
| `GET` | `/api/status` | Current configuration, status override, and heartbeat metrics |
| `POST` | `/api/status` | Force heartbeat status: `{"status": "up" \| "degraded" \| "down"}` |
| `GET` | `/status/set?status=<val>` | Quick URL switch to force status |
| `POST` | `/api/heartbeat/trigger` | Trigger an immediate heartbeat dispatch |
| `GET` | `/heartbeat/send` | Quick browser URL to trigger immediate heartbeat |
| `GET` | `/api/logs` | Ring buffer of recent heartbeats and Obyn responses |

---

## Triggering an Incident for Pipeline Testing

To test Obyn's detection and automated recovery:

### Via Web UI:
Click the **Force DOWN** or **Force DEGRADED** button on the homepage.

### Via cURL / API:
```bash
# Force status to DOWN
curl -X POST http://localhost:3000/api/status \
  -H "Content-Type: application/json" \
  -d '{"status": "down"}'

# Trigger immediate heartbeat
curl -X POST http://localhost:3000/api/heartbeat/trigger
```

---

## Deployment

### Deploy to Railway
1. Create a new service on Railway connected to this GitHub repo (`vansh7266/Test-3`).
2. Add the environment variables (`OBYN_HOST`, `OBYN_API_TOKEN`, `WORKSPACE_ID`, `PROJECT_ID`, `SERVICE_ID`).
3. Railway automatically detects `Dockerfile` or `package.json` and runs the background heartbeat scheduler.

### Deploy to Vercel
1. Import the repository into Vercel.
2. Add the required Environment Variables in Vercel Project Settings.
3. Deploy!
