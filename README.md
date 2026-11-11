# PulseCheck — API Reliability & Incident Simulator

PulseCheck is a full-stack API monitoring application for managing endpoints, running on-demand health checks, tracking reliability metrics, simulating API failures, and investigating monitoring issues with an evidence-based AI agent.

**Live Demo:** [https://pulsecheck-staging.onrender.com](https://pulsecheck-staging.onrender.com)

## Screenshots

![PulseCheck Dashboard](docs/screenshots/dashboard.png)

![PulseCheck Simulation Lab](docs/screenshots/simulation-lab.png)

## Features

### 1. API Endpoint Monitoring
- Add, edit, and delete monitored API endpoints.
- Run on-demand HTTP health checks.
- Record HTTP status codes, response times, success status, and errors.
- View historical health-check results.
- Track the latest endpoint status.

### 2. Monitoring Dashboard
- Total number of recorded checks.
- API success rate.
- Average response latency.
- Failed request count.
- Per-endpoint monitoring statistics.
- Historical check information.

Metrics are calculated from persisted health-check results.

### 3. Incident Simulation
Includes four built-in scenarios to test different API behaviors:

| Scenario | Behavior |
|---|---|
| Normal | Returns a successful HTTP response |
| Slow | Delays the response |
| Timeout | Exceeds the health-check timeout |
| Error | Returns an intentional HTTP 500 response |

These simulations help test monitoring and failure-handling behavior without depending on external APIs.

### 4. AI-Powered Investigation Agent

PulseCheck integrates OpenAI and Google Gemini through an OpenAI-compatible chat-completions interface.

Users can ask questions about monitoring results, endpoint failures, and service health.

The agent can:
- Retrieve monitoring information using predefined tools.
- Review endpoint status and check history.
- Analyze recent failures.
- Retrieve monitoring summaries.
- List available simulation scenarios.
- Provide investigation findings based on retrieved evidence.

Investigation responses include tool-call summaries so users can understand which monitoring information was consulted.

### 5. Controlled Agent Operations

The agent uses a controlled tool-execution architecture.

**Read-only tools:**
- `get_service_health`
- `list_monitors`
- `get_check_history`
- `get_monitoring_summary`
- `get_recent_failures`
- `list_simulations`

**Operational tools:**
- `run_endpoint_check`
- `run_simulation`

Operational tools are disabled by default. When enabled by server configuration, proposed operations require explicit user approval before execution.

Pending approvals:
- Are associated with an authenticated investigation owner.
- Have a 15-minute expiry.
- Are validated again by the backend before execution.
- Cannot be executed repeatedly after their state changes.

The AI agent does not directly execute arbitrary database queries or unrestricted URLs.

### 6. Investigation History
- Save investigation questions and responses.
- View previous investigations.
- Retrieve individual investigation details.
- Delete individual investigation records.
- Keep investigation and approval records scoped to their authenticated owner.

### 7. Security
- Clerk-based authentication.
- Server-side identity verification.
- Owner-scoped investigation and approval access.
- Input validation and request-size limits.
- Tool argument schema validation.
- Sensitive-field and credential redaction before sharing tool results with the AI model.
- Operational tools protected by server-side approval policies.
- Public-target validation for monitored HTTP(S) endpoints.
- DNS resolution and address validation to prevent requests to non-public targets.
- Pinned destination addresses and redirects disabled for endpoint checks.

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React, JavaScript, Vite |
| UI and Charts | Recharts, Lucide React |
| Authentication | Clerk |
| Backend | Node.js, Express.js |
| Database | SQLite, PostgreSQL |
| Database Testing | pg-mem |
| AI Integration | OpenAI API, Google Gemini API |
| AI SDK | OpenAI SDK |
| API Testing | Vitest, Supertest |
| Deployment | Render |
| Version Control | Git, GitHub |

## Architecture

```text
                  User
                   |
                   v
             React Frontend
                   |
             Clerk Auth
                   |
                   v
             Express API
                   |
          +--------+---------+
          |                  |
          v                  v
    Monitoring Layer     AI Agent
          |                  |
          v                  v
    Health Checks       Tool Definitions
          |                  |
          v                  v
     SQLite /           Read-only Tools
     PostgreSQL         Approval Workflow
          |                  |
          v                  v
    Check History       OpenAI / Gemini
    Dashboard Metrics        |
                             v
                      Investigation
                         Results
```

The frontend communicates with the backend through REST APIs.

The backend manages authentication, endpoint validation, health checks, database operations, monitoring metrics, and AI investigations.

The investigation agent uses predefined tools to retrieve monitoring information. Operational actions are handled separately through an authenticated approval workflow.

## Project Structure

```text
API-Monitor/
│
├── backend/
│   ├── scripts/
│   │   └── gemini-diagnostic.js
│   │
│   ├── src/
│   │   ├── agent.js
│   │   ├── agent-tools.js
│   │   ├── agent-rate-limit.js
│   │   ├── app.js
│   │   ├── auth.js
│   │   ├── database.js
│   │   ├── gemini-provider.js
│   │   ├── openai-provider.js
│   │   ├── monitor.js
│   │   ├── security.js
│   │   └── services.js
│   │
│   └── tests/
│
├── frontend/
│   └── src/
│
├── docs/
│   └── screenshots/
│       ├── dashboard.png
│       └── simulation-lab.png
│
├── .env.example
├── package.json
├── render.yaml
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 22.5 or newer
- npm
- Clerk application credentials
- OpenAI or Gemini API key for AI investigations

### 1. Clone the repository

```bash
git clone https://github.com/Suneetha125/API-Monitor.git
cd API-Monitor
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Configure the required environment variables using `.env.example` as a reference.

```env
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=
VITE_CLERK_PUBLISHABLE_KEY=

LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

GEMINI_API_KEY=
GEMINI_MODEL=

AGENT_MAX_ITERATIONS=5
AGENT_MAX_TOOL_CALLS_PER_RESPONSE=5
AGENT_MAX_TOOL_EXECUTIONS=10
AGENT_ALLOW_OPERATIONAL_TOOLS=false
```

For PostgreSQL, configure:

```env
DATABASE_URL=
```

When `DATABASE_URL` is not configured, the application uses SQLite for local development.

Never commit actual API keys, authentication credentials, or database connection strings.

### 4. Run the application

Start the frontend and backend together:

```bash
npm run dev
```

The frontend development server normally runs at:

```text
http://127.0.0.1:5173
```

The backend API normally runs at:

```text
http://127.0.0.1:3001
```

### 5. Build and run in production mode

Build the frontend:

```bash
npm run build
```

Start the backend:

```bash
npm start
```

## API Endpoints

All application API routes require Clerk authentication except the public health endpoint.

### Health and Simulations

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Public service health status |
| GET | `/api/simulations` | List available simulation scenarios |
| GET | `/api/simulations/:key` | Execute a built-in simulation |

### Endpoint Monitoring

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/endpoints` | List monitored endpoints |
| POST | `/api/endpoints` | Create a monitored endpoint |
| PUT | `/api/endpoints/:id` | Update an endpoint |
| DELETE | `/api/endpoints/:id` | Delete an endpoint |
| POST | `/api/endpoints/:id/check` | Run an endpoint health check |
| GET | `/api/checks` | Retrieve health-check history |
| GET | `/api/dashboard` | Retrieve monitoring metrics |

### AI Investigation

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/agent/investigate` | Start an AI investigation |
| GET | `/api/agent/investigations` | Retrieve investigation history |
| GET | `/api/agent/investigations/:id` | Retrieve an investigation |
| DELETE | `/api/agent/investigations/:id` | Delete an investigation |
| GET | `/api/agent/investigations/:id/approvals` | Retrieve approval records |
| POST | `/api/agent/approvals/:approvalId/approve` | Approve a pending operation |
| POST | `/api/agent/approvals/:approvalId/reject` | Reject a pending operation |

## Database Design

The application supports SQLite and PostgreSQL.

Main data entities include:

- **endpoints:** Stores monitored endpoint information.
- **checks:** Stores individual health-check results.
- **investigations:** Stores AI investigation questions, responses, and tool summaries.
- **agent_approvals:** Stores pending operational approvals and execution status.
- **agent_rate_limits:** Stores investigation rate-limit counters.
- **app_metadata:** Stores application metadata.

Foreign-key relationships and cascading deletion maintain related records.

Monitoring endpoint and check data are shared across authenticated users, while investigation records and approval records are scoped to their owners.

## Testing

Run the backend test suite:

```bash
npm test
```

Build the frontend:

```bash
npm run build
```

The backend tests cover API behavior, authentication, database operations, monitoring logic, agent workflows, approval handling, and provider integration using mocked requests.

The Gemini diagnostic is an opt-in integration test that makes real API requests:

```bash
npm run diagnose:gemini --workspace backend
```

For the tool-call round-trip diagnostic:

```bash
npm run diagnose:gemini --workspace backend -- --tool-call-round-trip
```

Real Gemini requests are subject to the configured API project's quotas and rate limits.

## Deployment

The project includes a Render Blueprint configuration in `render.yaml`.

The deployment configuration:
- Builds the frontend.
- Starts the Node.js backend.
- Serves the frontend through Express in production.
- Uses `/api/health` as the service health-check endpoint.
- Supports PostgreSQL through `DATABASE_URL`.

Production deployments should use persistent PostgreSQL storage rather than relying on an ephemeral local SQLite file.

Configure authentication credentials, database connection details, and the selected AI provider's API key through deployment environment variables.

## Current Limitations

- Health checks are initiated on demand; automatic scheduled monitoring is not implemented.
- Automatic email, SMS, or external alert delivery is not implemented.
- Health checks use a fixed two-second timeout.
- Check history does not currently have an automatic retention policy.
- Monitoring data is shared across authenticated users.
- AI investigation availability depends on the configured provider, API credentials, and provider quotas.
- Operational agent tools remain disabled by default and require server configuration and explicit approval.

## Future Improvements

- Scheduled health checks.
- Configurable monitoring intervals and timeouts.
- Email and notification-based alerts.
- Monitoring data retention controls.
- Additional dashboard analytics.
- Further improvements to AI investigation reliability.

## Repository

**GitHub:** [Suneetha125/API-Monitor](https://github.com/Suneetha125/API-Monitor)

**Live Demo:** [PulseCheck](https://pulsecheck-staging.onrender.com)

---

Built to explore full-stack development, API reliability monitoring, secure backend design, and controlled AI agent workflows.
