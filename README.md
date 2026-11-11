# PulseCheck — API Reliability & Incident Simulator

PulseCheck is a full-stack API monitoring dashboard for managing endpoints, running on-demand health checks, reviewing stored reliability metrics, and investigating failures with an evidence-based AI agent.

## Project screenshots

![PulseCheck dashboard showing metrics, latency history, and monitored simulation endpoints](docs/screenshots/dashboard.png)

![PulseCheck incident summary, local simulation lab, and recent test runs](docs/screenshots/simulation-lab.png)

## Live Demo

[Open PulseCheck](https://pulsecheck-5su5.onrender.com/)

The demo is hosted on Render and may take longer to respond after periods of inactivity. The API health check is available at [https://pulsecheck-5su5.onrender.com/api/health](https://pulsecheck-5su5.onrender.com/api/health).

## Key features

- **Endpoint monitoring:** Add, edit, and delete monitored endpoints; run on-demand HTTP health checks and review their history.
- **Stored dashboard metrics:** View request count, success rate, average latency, and failures calculated from persisted check results.
- **Safe target validation:** Custom HTTP(S) monitor destinations must resolve to public addresses; DNS is checked and pinned for each request, and redirects are not followed.
- **Local simulations:** Four seeded scenarios exercise healthy, slow, timeout, and HTTP 500 behavior against local simulation routes.
- **AI investigations:** Ask questions about monitoring data using OpenAI or Gemini through the OpenAI-compatible chat-completions interface. The bounded agent can call read-only monitoring tools and returns its evidence and tool-call summary.
- **Approval workflow:** Operational tools are disabled by default. When enabled by server policy, proposed operations require explicit approval before execution.
- **Investigation history:** Review and delete your own saved investigations. History and approval access are scoped to the authenticated user.
- **Authentication and authorization:** Clerk authenticates API requests; the backend derives identity from verified server-side authentication and applies ownership checks to investigation and approval records.

## Tech stack

| Area | Technologies |
| --- | --- |
| Frontend | React, Vite, Recharts, Clerk React |
| Backend | Node.js, Express, Clerk Express |
| Data | SQLite for local development and tests; PostgreSQL when `DATABASE_URL` is configured |
| AI providers | OpenAI SDK with OpenAI or Gemini OpenAI-compatible endpoints |
| Tests | Vitest, Supertest, and an in-memory PostgreSQL emulator |
| Deployment configuration | Render Blueprint (`render.yaml`) |

## Architecture

The React dashboard calls the Express API through `/api`. In development, Vite proxies these requests to the local backend. In production, Express serves the built frontend. The backend validates and performs endpoint checks, stores results, and calculates metrics from stored data.

For AI investigations, the API authenticates and rate-limits the request, constructs the agent with provider-neutral tool definitions, and calls the configured model. The agent validates tool names and arguments, executes allowed read-only tools, and sends sanitized tool results back to the model. Operational actions are not executed by the model loop: they are persisted as pending approvals and can only be executed through an authenticated approval request after server-side validation.

Simulation endpoints use `simulation://` identifiers. The backend translates them into requests to its own local simulation routes; clients cannot use these routes as arbitrary proxy destinations. Monitoring data is shared across authenticated users, while investigation records and approvals are user-scoped.

## Project structure

```text
.
├── backend/
│   ├── scripts/                 # Gemini integration diagnostic
│   ├── src/
│   │   ├── agent.js             # Bounded investigation and tool-call loop
│   │   ├── agent-tools.js       # Tool schemas, policy gates, and handlers
│   │   ├── app.js               # Express API routes and request handling
│   │   ├── auth.js              # Clerk authentication integration
│   │   ├── database.js          # SQLite and PostgreSQL adapters
│   │   ├── gemini-provider.js   # Gemini OpenAI-compatible adapter
│   │   ├── monitor.js           # HTTP health-check execution
│   │   ├── openai-provider.js   # OpenAI adapter
│   │   ├── security.js          # Input and public-target validation
│   │   └── services.js          # Shared monitoring and simulation services
│   └── tests/                   # Backend API, agent, and provider tests
├── docs/
│   └── screenshots/
├── frontend/
│   └── src/                     # React application and authenticated API client
├── .env.example                 # Environment variable names; no credentials
├── package.json                 # Root workspace scripts
└── render.yaml                  # Render service configuration
```

## Local setup

### Requirements

- Node.js 22.5 or newer (the backend uses the built-in `node:sqlite` module)
- npm 10 or newer

Install dependencies from the repository root:

```bash
npm install
```

Configure Clerk credentials before starting the API:

```text
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=
VITE_CLERK_PUBLISHABLE_KEY=
```

The Clerk publishable key used by Vite must match the key configured for the backend. Set these values in your shell or a local, untracked environment file. Vite reads its environment files; the Node API does **not** load `.env` files automatically, so backend values must also be present in the API process environment. Never commit secrets.

Start the frontend and API together:

```bash
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://127.0.0.1:5173`) and sign in with Clerk. The API normally listens on `http://127.0.0.1:3001`.

To build the frontend and start the API:

```bash
npm run build
npm start
```

With `NODE_ENV=production`, the API serves the built frontend and listens on all interfaces. `PORT` controls the listening port. When `DATABASE_URL` is set, the backend uses PostgreSQL; otherwise, it uses SQLite at `DATABASE_PATH` (default: `pulsecheck.sqlite`). Production mode requires `DATABASE_URL` to avoid using ephemeral local storage.

## Environment variables

Copy `.env.example` as a reference and provide values through the appropriate local process environment or deployment secret settings. The example file contains names and defaults only; do not put real credentials in version control.

| Variable | Purpose |
| --- | --- |
| `CLERK_SECRET_KEY` | Server-side Clerk authentication. Required to start the API. |
| `CLERK_PUBLISHABLE_KEY` | Clerk application configuration used by the backend. Required to start the API. |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key embedded into the frontend build. |
| `LLM_PROVIDER` | Selects `openai` (default) or `gemini`. |
| `OPENAI_API_KEY` | Credential for the OpenAI provider. Set only when using OpenAI. |
| `OPENAI_MODEL` | Optional OpenAI model; defaults to `gpt-4o-mini`. |
| `GEMINI_API_KEY` | Credential for the Gemini OpenAI-compatible endpoint. Set only when using Gemini. |
| `GEMINI_MODEL` | Optional Gemini model; defaults to `gemini-3.8-flash`. |
| `DATABASE_URL` | PostgreSQL connection URL. Required in production; unset locally to use SQLite. |
| `DATABASE_PATH` | Optional SQLite file path; defaults to `pulsecheck.sqlite`. |
| `NODE_ENV` | Enables production serving and production database requirements when set to `production`. |
| `PORT` | Optional HTTP listening port; defaults to `3001`. |
| `AGENT_MAX_ITERATIONS` | Maximum model iterations per investigation; defaults to `5`, valid range `1`–`10`. |
| `AGENT_MAX_TOOL_CALLS_PER_RESPONSE` | Maximum tool calls accepted per model response; defaults to `5`, valid range `1`–`20`. |
| `AGENT_MAX_TOOL_EXECUTIONS` | Maximum tool executions per investigation; defaults to `10`, valid range `1`–`50`. |
| `AGENT_ALLOW_OPERATIONAL_TOOLS` | Enables advertising approved operational tools when set to `true`; defaults to `false` and does not bypass approval. |

The investigation rate limit is currently five requests per authenticated user per 15-minute window. It is stored in the application database and fails closed if the rate-limit store is unavailable. API JSON bodies are limited to 16 KB, and investigation questions are limited to 2,000 characters.

## Agent tools and safety

The backend defines eight tools. Six are read-only: `get_service_health`, `list_monitors`, `get_check_history`, `get_monitoring_summary`, `get_recent_failures`, and `list_simulations`. The two operational tools, `run_endpoint_check` and `run_simulation`, remain disabled by default.

The agent does not access the database directly or apply production fixes. Tool arguments are validated against their schemas; the tool layer does not accept arbitrary SQL or arbitrary URLs. Endpoint checks can only run against configured monitors. Sensitive-looking fields and monitor URLs are filtered from tool results sent to the model, and common credential patterns in questions are redacted; this is not a guarantee against every possible secret format. The configured model provider receives the remaining question and monitoring evidence.

If operational tools are enabled, a requested operation is stored as a pending approval with a 15-minute expiry. The server reloads and validates the stored operation when the authenticated owner approves it. Pending operations are not replayed automatically after restart.

## API endpoints

All listed routes require Clerk authentication except `GET /api/health`, which is public for health checks. Investigation and approval routes enforce user ownership.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Public API liveness |
| `GET` | `/api/simulations` | List built-in simulation scenarios |
| `GET` | `/api/simulations/:key` | Execute a built-in local simulation |
| `GET` | `/api/endpoints` | List monitors and stored per-monitor aggregates |
| `POST` | `/api/endpoints` | Create a monitor |
| `PUT` | `/api/endpoints/:id` | Edit a monitor |
| `DELETE` | `/api/endpoints/:id` | Delete a monitor and its stored check history |
| `POST` | `/api/endpoints/:id/check` | Run and persist one health check |
| `GET` | `/api/checks` | List stored checks; supports `endpointId`, `from`, `to`, and `limit` filters |
| `GET` | `/api/dashboard` | Return stored request count, success rate, average latency, and failure count |
| `POST` | `/api/agent/investigate` | Run an AI investigation |
| `GET` | `/api/agent/investigations` | List the authenticated user's paginated history |
| `GET` | `/api/agent/investigations/:id` | Retrieve an owned investigation |
| `DELETE` | `/api/agent/investigations/:id` | Delete an owned investigation and associated approvals |
| `GET` | `/api/agent/investigations/:id/approvals` | List approval records for an owned investigation |
| `POST` | `/api/agent/approvals/:approvalId/approve` | Approve and execute a permitted stored operation |
| `POST` | `/api/agent/approvals/:approvalId/reject` | Reject a pending operation |

Endpoint creation accepts a public HTTP(S) target:

```json
{ "name": "Checkout API", "url": "https://example.com/health" }
```

or a built-in simulation:

```json
{ "name": "Local healthy scenario", "url": "simulation://normal", "simulation": "normal" }
```

Supported simulation keys are `normal`, `slow`, `timeout`, and `error`. Date filters use `YYYY-MM-DD`; `from` and `to` are inclusive UTC calendar days.

An investigation request uses:

```http
POST /api/agent/investigate
Content-Type: application/json

{ "question": "Why did the latest API checks fail?" }
```

Successful responses include the answer and tool-call names/statuses, not raw tool arguments or raw tool results. Missing provider configuration returns a safe `503`; provider failures and malformed model responses return a generic `502`.

## Data model

- `endpoints` stores monitored targets.
- `checks` stores individual results and cascades when an endpoint is deleted.
- `investigations` stores findings and an optional owner ID derived from verified Clerk identity. Legacy ownerless investigations remain hidden.
- `agent_approvals` stores validated pending operations, lifecycle status, and safe result metadata. Investigation deletion cascades to associated approvals.
- `agent_rate_limits` stores one fixed-window counter per authenticated user.
- `app_metadata` stores the PostgreSQL simulation-seed marker.

SQLite enables foreign-key enforcement and WAL journaling. PostgreSQL uses matching tables and cascading foreign keys. Without `DATABASE_URL`, the local database file is created in the backend process working directory and is ignored by Git.

## Testing and build

Run the backend test suite from the repository root:

```bash
npm test
```

The tests use isolated temporary SQLite databases, an in-memory PostgreSQL emulator, and local simulation endpoints. They do not require live LLM requests.

Build the frontend:

```bash
npm run build
```

The backend workspace also includes an opt-in Gemini integration diagnostic. It makes real provider requests when run with Gemini configured; it is separate from the mocked test suite:

```bash
npm run diagnose:gemini --workspace backend
```

Add `-- --tool-call-round-trip` to test an initial tool request and its follow-up separately. Diagnostic output is limited to test names, HTTP results, and allowlisted error metadata. Do not pass credentials on the command line; configure them through the environment or the root local `.env` file used by the diagnostic.

## Deployment

The root `render.yaml` defines a Render Node web service that builds the frontend and serves it through Express. Configure the Clerk variables and PostgreSQL `DATABASE_URL` in the deployment environment. Configure only the API key for the selected LLM provider when enabling investigations. Render and database plans may have quotas, cold starts, or ephemeral storage; production persistence requires PostgreSQL rather than a local SQLite file.

## Known limitations and future improvements

- Health checks run on demand; there is no scheduler or alert delivery.
- A fixed two-second timeout and safe GET request are used for health checks.
- Check history has no retention policy and is not paginated beyond the `limit` filter.
- Authenticated users share endpoint and check data; investigation records and approvals are private to their owner.
- The public health endpoint intentionally does not require authentication; other client-facing API routes require Clerk authentication.

Possible future work includes scheduled checks, alert delivery, configurable retention, and additional monitoring visualizations.

## Repository

Source code: [Suneetha125/API-Monitor](https://github.com/Suneetha125/API-Monitor).
