import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, Check, ChevronDown, CircleHelp, Clock3, Globe2,
  LoaderCircle, MoreHorizontal, Plus, RefreshCw, Search, ShieldCheck,
  SlidersHorizontal, Trash2, X, Zap
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

const prettyDate = (value) => value ? new Date(value).toLocaleString([], {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
}) : 'Never';
const rateText = (value) => value == null ? '—' : `${value.toFixed(1)}%`;
const simulationLabels = {
  normal: 'Healthy response', slow: 'Slow response', timeout: 'Timeout', error: 'HTTP 500'
};

export default function App() {
  const [endpoints, setEndpoints] = useState([]);
  const [checks, setChecks] = useState([]);
  const [summary, setSummary] = useState(null);
  const [filterId, setFilterId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState({});
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const params = new URLSearchParams();
      if (filterId) params.set('endpointId', filterId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const suffix = params.size ? `?${params.toString()}` : '';
      const [endpointData, checkData, summaryData] = await Promise.all([
        api('/api/endpoints'),
        api(`/api/checks${suffix}`),
        api(`/api/dashboard${suffix}`)
      ]);
      setEndpoints(endpointData);
      setChecks(checkData);
      setSummary(summaryData);
    } catch (err) {
      setError(err.message);
    }
  }, [filterId, from, to]);

  useEffect(() => { load(); }, [load]);

  const visibleEndpoints = useMemo(() => {
    const term = query.trim().toLowerCase();
    return endpoints.filter((endpoint) => !term || endpoint.name.toLowerCase().includes(term) || endpoint.url.toLowerCase().includes(term));
  }, [endpoints, query]);
  const chartData = [...checks].reverse().map((check) => ({
    time: new Date(check.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    latency: check.duration_ms,
    success: Boolean(check.success)
  }));
  const incidents = checks.filter((check) => !check.success).slice(0, 4);

  async function runCheck(id) {
    setBusy((current) => ({ ...current, [id]: true }));
    try {
      await api(`/api/endpoints/${id}/check`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy((current) => ({ ...current, [id]: false }));
    }
  }

  async function removeEndpoint(endpoint) {
    if (!window.confirm(`Delete "${endpoint.name}" and its stored check history?`)) return;
    try {
      await api(`/api/endpoints/${endpoint.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveEndpoint(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const simulation = data.get('simulation');
    const body = simulation === 'custom'
      ? { name: data.get('name'), url: data.get('url') }
      : { name: data.get('name'), url: `simulation://${simulation}`, simulation };
    try {
      await api(editing?.id ? `/api/endpoints/${editing.id}` : '/api/endpoints', {
        method: editing?.id ? 'PUT' : 'POST', body: JSON.stringify(body)
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark"><Activity size={20} /></span><span>pulse<span className="brand-light">check</span><small>API RELIABILITY</small></span></a>
        <div className="workspace-label">WORKSPACE</div>
        <button className="workspace-picker"><span className="workspace-avatar">P</span><span><strong>Platform team</strong><small>Developer workspace</small></span><ChevronDown size={15} /></button>
        <div className="nav-label">MONITORING</div>
        <button className="nav-item active"><Activity size={17} /> Overview <span className="nav-pill">{endpoints.length}</span></button>
        <button className="nav-item" onClick={() => document.getElementById('incidents')?.scrollIntoView({ behavior: 'smooth' })}><AlertTriangle size={17} /> Incidents <span className="nav-pill muted">{incidents.length}</span></button>
        <button className="nav-item" onClick={() => document.getElementById('runs')?.scrollIntoView({ behavior: 'smooth' })}><Clock3 size={17} /> Test runs</button>
        <div className="sidebar-spacer" />
        <div className="simulation-note"><div><Zap size={15} /> SAFE SIMULATIONS</div><p>Built-in targets run locally. Custom targets are restricted to public IP addresses.</p><button onClick={() => setEditing({})}>Explore simulations <span>↗</span></button></div>
        <div className="profile"><span className="profile-avatar">PC</span><span><strong>PulseCheck</strong><small>Local instance</small></span><MoreHorizontal size={18} /></div>
      </aside>

      <main className="main">
        <header className="topbar"><div className="breadcrumb">Monitoring <span>/</span> <strong>Overview</strong></div><div className="top-actions"><span className={`live-status ${endpoints.some((endpoint) => endpoint.last_success === 0) ? 'has-errors' : ''}`}><i /> {endpoints.some((endpoint) => endpoint.last_success === 0) ? 'Failures recorded' : 'No recent failures'}</span><button className="icon-button" title="Help"><CircleHelp size={18} /></button><button className="user-avatar">PC</button></div></header>
        <div className="content">
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> LIVE MONITORING</div><h1>API overview</h1><p>Keep an eye on your endpoints and catch issues before your users do.</p></div><button className="primary-button" onClick={() => setEditing({})}><Plus size={17} /> Add endpoint</button></section>
          {error && <div className="error-banner" role="alert"><AlertTriangle size={17} />{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}

          <section className="metrics-grid">
            <MetricCard icon={<Activity size={17} />} label="Total requests" value={summary?.request_count ?? '—'} note="In selected period" tone="blue" />
            <MetricCard icon={<ShieldCheck size={17} />} label="Success rate" value={rateText(summary?.success_rate)} note="Successful checks" tone="green" />
            <MetricCard icon={<Zap size={17} />} label="Avg. latency" value={summary?.average_latency_ms == null ? '—' : `${summary.average_latency_ms} ms`} note="Across all checks" tone="purple" />
            <MetricCard icon={<AlertTriangle size={17} />} label="Error count" value={summary?.error_count ?? '—'} note="Failed checks" tone="orange" />
          </section>

          <section className="panel chart-panel">
            <div className="panel-heading"><div><h2>Latency history</h2><p>Response time for each recorded check</p></div><div className="chart-legend"><span><i /> Latency <small>ms</small></span><button className="subtle-button" onClick={load}><RefreshCw size={14} /> Refresh</button></div></div>
            {chartData.length ? <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}><defs><linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6687ff" stopOpacity={0.24} /><stop offset="95%" stopColor="#6687ff" stopOpacity={0.01} /></linearGradient></defs><CartesianGrid stroke="#242c3b" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="time" tick={{ fill: '#7e899e', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} /><YAxis tick={{ fill: '#7e899e', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(value) => `${value}ms`} /><Tooltip contentStyle={{ background: '#171e2c', border: '1px solid #303a4d', borderRadius: 9, color: '#e8edf7' }} formatter={(value) => [`${value} ms`, 'Latency']} /><Area type="monotone" dataKey="latency" stroke="#8098ff" strokeWidth={2} fill="url(#latencyFill)" activeDot={{ r: 4, fill: '#91a4ff' }} /></AreaChart></ResponsiveContainer></div> : <EmptyState icon={<Activity size={20} />} title="No latency data yet" text="Run an endpoint check to start building your history." />}
          </section>

          <section className="panel endpoints-panel">
            <div className="panel-heading"><div><h2>Monitored endpoints <span className="count-badge">{endpoints.length}</span></h2><p>Manage targets and run on-demand health checks</p></div><button className="outline-button" onClick={() => setEditing({})}><Plus size={15} /> Add endpoint</button></div>
            <div className="table-toolbar"><label className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search endpoints..." /></label><button className="filter-button" onClick={() => document.getElementById('endpoint-filter')?.focus()}><SlidersHorizontal size={15} /> Filters</button><select id="endpoint-filter" aria-label="Filter by endpoint" value={filterId} onChange={(event) => setFilterId(event.target.value)}><option value="">All endpoints</option>{endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>)}</select><label className="date-filter">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label className="date-filter">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div>
            <div className="table-scroll"><table><thead><tr><th>ENDPOINT</th><th>STATUS</th><th>SUCCESS RATE</th><th>AVG. LATENCY</th><th>LAST CHECKED</th><th /></tr></thead><tbody>
              {visibleEndpoints.map((endpoint) => <tr key={endpoint.id}><td><div className="endpoint-name"><span className={`endpoint-icon ${endpoint.simulation ? 'sim' : ''}`}><Globe2 size={16} /></span><span><strong>{endpoint.name}{endpoint.simulation && <span className="sim-tag">SIMULATION</span>}</strong><small>{endpoint.simulation ? `simulation://${endpoint.simulation}` : new URL(endpoint.url).origin + new URL(endpoint.url).pathname}</small></span></div></td><td><span className={`status-badge ${endpoint.last_success == null ? 'unknown' : endpoint.last_success ? 'healthy' : 'degraded'}`}><i />{endpoint.last_success == null ? 'No runs' : endpoint.last_success ? 'Healthy' : 'Degraded'}</span></td><td>{rateText(endpoint.success_rate)}</td><td>{endpoint.average_latency_ms == null ? '—' : `${endpoint.average_latency_ms} ms`}</td><td className="last-checked">{prettyDate(endpoint.last_checked_at)}</td><td><div className="row-actions"><button className="run-button" disabled={busy[endpoint.id]} onClick={() => runCheck(endpoint.id)}>{busy[endpoint.id] ? <LoaderCircle className="spin" size={14} /> : <Zap size={14} />} Check</button><button className="icon-button small" title="Edit endpoint" onClick={() => setEditing(endpoint)}><MoreHorizontal size={17} /></button><button className="icon-button small danger-hover" title="Delete endpoint" onClick={() => removeEndpoint(endpoint)}><Trash2 size={15} /></button></div></td></tr>)}
              {!visibleEndpoints.length && <tr><td colSpan="6"><EmptyState title={query ? 'No matching endpoints' : 'No endpoints yet'} text="Add an endpoint to start monitoring." /></td></tr>}
            </tbody></table></div>
          </section>

          <section className="lower-grid">
            <div className="panel incidents-panel" id="incidents"><div className="panel-heading"><div><h2>Recent incidents</h2><p>Latest unsuccessful checks</p></div><span className="incident-count">{summary?.error_count ?? 0} total</span></div>{incidents.length ? <div className="incident-list">{incidents.map((check) => <div className="incident-row" key={check.id}><span className="incident-icon"><AlertTriangle size={15} /></span><span className="incident-copy"><strong>{check.endpoint_name}</strong><small>{check.error || `HTTP ${check.status_code}`} · {prettyDate(check.checked_at)}</small></span><span className="incident-latency">{check.duration_ms} ms</span></div>)}</div> : <EmptyState icon={<Check size={20} />} title="No incidents in this period" text="Failed checks will appear here." />}</div>
            <div className="panel info-panel"><div className="panel-heading"><div><h2>Simulation lab</h2><p>Safe, local-only test scenarios</p></div><span className="simulation-icon"><Zap size={16} /></span></div><div className="simulation-list">{Object.entries(simulationLabels).map(([key, label]) => <div key={key}><span className={`scenario-dot ${key}`} /><span><strong>{label}</strong><small>{key === 'normal' ? '200 OK · quick response' : key === 'slow' ? '200 OK · ~700 ms delay' : key === 'timeout' ? 'Request exceeds 2 s limit' : '500 Internal Server Error'}</small></span><span className="local-tag">LOCAL</span></div>)}</div></div>
          </section>

          <section className="panel runs-panel" id="runs"><div className="panel-heading"><div><h2>Recent test runs</h2><p>Detailed results from stored health checks</p></div><span className="run-total">{checks.length} results</span></div><div className="table-scroll"><table><thead><tr><th>RESULT</th><th>ENDPOINT</th><th>STATUS CODE</th><th>DURATION</th><th>TIME</th><th /></tr></thead><tbody>{checks.slice(0, 12).map((check) => <FragmentRun key={check.id} check={check} expanded={expanded} setExpanded={setExpanded} />)}
              {!checks.length && <tr><td colSpan="6"><EmptyState title="No test runs found" text="Run a health check or adjust your filters." /></td></tr>}
            </tbody></table></div></section>
          <footer>PulseCheck <span>·</span> Metrics are calculated from persisted health-check results.</footer>
        </div>
      </main>
      {editing && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}><form className="modal" onSubmit={saveEndpoint}><div className="modal-heading"><div><span className="modal-icon"><Globe2 size={19} /></span><h2>{editing.id ? 'Edit endpoint' : 'Add endpoint'}</h2><p>Configure a monitored target.</p></div><button type="button" className="icon-button" onClick={() => setEditing(null)} aria-label="Close"><X size={18} /></button></div><label className="form-label">Endpoint name<input name="name" required maxLength="80" defaultValue={editing.name || ''} placeholder="e.g. Checkout API" /></label><label className="form-label">Target type<select name="simulation" defaultValue={editing.simulation || (editing.url ? 'custom' : 'normal')} onChange={(event) => { document.getElementById('custom-url-field').hidden = event.target.value !== 'custom'; }}><option value="normal">Simulation · Healthy response</option><option value="slow">Simulation · Slow response</option><option value="timeout">Simulation · Timeout</option><option value="error">Simulation · HTTP 500</option><option value="custom">Public HTTP(S) endpoint</option></select></label><label className="form-label" id="custom-url-field" hidden={!editing.url && Boolean(editing.simulation || !editing.id)} >Endpoint URL<input name="url" type="url" placeholder="https://api.example.com/health" defaultValue={editing.simulation ? '' : editing.url || ''} /></label><div className="form-hint"><ShieldCheck size={15} /> Simulations run on this machine. Custom endpoints must resolve to public IP addresses; local and private networks are blocked.</div><div className="modal-actions"><button type="button" className="outline-button" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="primary-button"><Check size={15} /> {editing.id ? 'Save changes' : 'Add endpoint'}</button></div></form></div>}
    </div>
  );
}

function FragmentRun({ check, expanded, setExpanded }) {
  return <>
    <tr className="run-row" onClick={() => setExpanded(expanded === check.id ? null : check.id)}><td><span className={`result-indicator ${check.success ? 'success' : 'failed'}`}>{check.success ? <Check size={13} /> : <X size={13} />}{check.success ? 'Success' : 'Failed'}</span></td><td className="run-endpoint">{check.endpoint_name}</td><td><span className={`http-code ${check.success ? 'ok' : 'bad'}`}>{check.status_code ?? '—'}</span></td><td>{check.duration_ms} ms</td><td className="last-checked">{prettyDate(check.checked_at)}</td><td><button className="icon-button small" aria-label="View test run details"><ChevronDown size={15} className={expanded === check.id ? 'rotate' : ''} /></button></td></tr>
    {expanded === check.id && <tr className="detail-row"><td colSpan="6"><div><strong>Run #{check.id}</strong><span>Recorded at {new Date(check.checked_at).toISOString()}</span><span>Endpoint ID: {check.endpoint_id}</span>{check.error && <span className="detail-error">Error: {check.error}</span>}</div></td></tr>}
  </>;
}

function MetricCard({ icon, label, value, note, tone }) {
  return <div className="metric-card"><div className="metric-top"><span className={`metric-icon ${tone}`}>{icon}</span><span className="metric-caption">{label}</span><span className="metric-menu"><MoreHorizontal size={17} /></span></div><div className="metric-value">{value}</div><div className="metric-note"><span className={`metric-indicator ${tone}`} />{note}</div></div>;
}

function EmptyState({ icon, title, text }) {
  return <div className="empty-state">{icon && <span>{icon}</span>}<strong>{title}</strong><small>{text}</small></div>;
}
