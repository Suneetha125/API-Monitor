# PulseCheck — API Reliability & Incident Simulator

PulseCheck is a local developer dashboard for managing API monitors, executing on-demand HTTP health checks, and exploring controlled incident scenarios. Request results are stored in SQLite; dashboard metrics are calculated from those stored checks, not generated sample values.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite` module)
- npm 10 or newer

`node:sqlite` is still marked experimental in some supported Node releases, so Node may print an experimental-feature warning at startup.

## Setup and run

From the project root:

```bash
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://127.0.0.1:5173`). The API listens on `http://127.0.0.1:3001`; Vite proxies `/api` requests to it.

For a production frontend build and API server:

```bash
npm run build
npm start
```

In production (`NODE_ENV=production`), the API server also serves the built frontend from `frontend/dist` and listens on all interfaces. Set `PORT` to change the API port and `DATABASE_PATH` to change the SQLite file location. Without production mode, the API binds to `127.0.0.1`; during development Vite serves the frontend and proxies `/api` to the API.

### Render deployment

The root `render.yaml` defines a single Node web service that builds the frontend, serves it from Express, and uses `/api/health` as its health check. Its SQLite database is stored on a persistent disk mounted at `/var/data`. Render persistent disks require a paid service plan; review Render's current pricing and approve any charges before creating the Blueprint. The service requires no API keys or other application secrets.

## Architecture

- `frontend/` — React single-page dashboard, Vite development server, and Recharts latency history.
- `backend/src/app.js` — Express API routes, validation integration, and metric queries.
- `backend/src/security.js` — endpoint input validation and public-address/DNS checks.
- `backend/src/monitor.js` — timed HTTP requests and result normalization.
- `backend/src/database.js` — built-in Node SQLite schema, indexes, and initial simulation endpoint records.
- `backend/tests/` — Vitest and Supertest API integration tests.

The backend is bound to the IPv4 loopback interface by default. Simulation targets are represented by `simulation://` identifiers in the endpoint registry and are translated by the backend to its own loopback HTTP simulation routes. The mock routes are never arbitrary proxy destinations.

## Simulations

The database is initially seeded with four **simulation** endpoints (no health-check metrics are seeded):

| Scenario | Local response |
| --- | --- |
| Healthy response | HTTP 200 JSON |
| Slow response | HTTP 200 after approximately 700 ms |
| Timeout | Delayed response; the health-check request times out after 2 seconds |
| HTTP 500 | Deliberate HTTP 500 response |

They are clearly labeled in the dashboard and use only the local API server. Custom HTTP(S) URLs are allowed only when their host resolves exclusively to public IP addresses. Private, loopback, link-local, and other non-public addresses are rejected, DNS is checked again before each check and pinned for the request, and redirects are not followed. URL credentials and query strings are rejected so query-based secrets are not returned by the endpoint API.

## API routes

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/health` | API liveness |
| `GET` | `/api/simulations` | List built-in scenarios |
| `GET` | `/api/endpoints` | List monitors with stored per-endpoint aggregates |
| `POST` | `/api/endpoints` | Create a monitor |
| `PUT` | `/api/endpoints/:id` | Edit a monitor |
| `DELETE` | `/api/endpoints/:id` | Delete a monitor and its check history |
| `POST` | `/api/endpoints/:id/check` | Execute and persist one health check |
| `GET` | `/api/checks` | List individual runs; optional `endpointId`, `from`, `to`, `limit` filters |
| `GET` | `/api/dashboard` | Stored request count, success rate, mean latency, and failure count; optional `endpointId`, `from`, `to` filters |

Endpoint JSON uses `{ "name": "API name", "url": "https://example.com/health" }` for a public target, or `{ "name": "Local simulation", "url": "simulation://normal", "simulation": "normal" }` for a simulation. Supported simulation keys are `normal`, `slow`, `timeout`, and `error`. Dates use `YYYY-MM-DD`; `from` and `to` are inclusive calendar days in UTC.

## Database schema

- `endpoints`: `id`, `name`, `url`, nullable `simulation`, `created_at`.
- `checks`: `id`, `endpoint_id` (foreign key with cascade delete), nullable `status_code`, `duration_ms`, `success`, nullable `error`, `checked_at`.
- Indexes support endpoint/date history queries. SQLite foreign-key enforcement and WAL journaling are enabled.

The default database file is `pulsecheck.sqlite` in the backend process working directory. It is ignored by Git.

## Tests

```bash
npm test
```

The integration tests use an isolated temporary on-disk SQLite database per test and local simulation endpoints, without internet access. They cover API health, endpoint creation/retrieval and validation, success and HTTP 500 checks, timeout responsiveness, check persistence/history, exact success-rate and average-latency calculations, endpoint CRUD, and date filtering. There is no incident state or incident-resolution feature; failed checks are displayed as recent incidents, so consecutive-failure lifecycle tests do not apply.

## Known limitations

- Checks run on demand; there is no scheduler, alert delivery, authentication, or multi-user access control.
- One fixed 2-second timeout is used for every health check; request method and headers are fixed to a safe GET.
- The public-target guard blocks non-public DNS answers and pins the checked address, but outbound monitoring still requires internet/DNS access.
- Check history is retained until its endpoint is deleted; there is no retention policy or pagination beyond the `limit` parameter.
- The application is intended for local development, not direct deployment as an unauthenticated public service.
