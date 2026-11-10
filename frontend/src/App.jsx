import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SignIn, UserButton, useAuth } from '@clerk/react';
import {
  Activity, AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Globe2,
  LoaderCircle, MessageSquareText, MoreHorizontal, Plus, RefreshCw, Search, ShieldCheck,
  SlidersHorizontal, Trash2, X, Zap
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { createApiClient } from './auth-client.js';

const prettyDate = (value) => value ? new Date(value).toLocaleString([], {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
}) : 'Never';
const rateText = (value) => value == null ? '—' : `${value.toFixed(1)}%`;
const simulationLabels = {
  normal: 'Healthy response', slow: 'Slow response', timeout: 'Timeout', error: 'HTTP 500'
};
const INVESTIGATION_PAGE_SIZE = 10;

function investigationStatus(status, hasPendingApproval = false) {
  if (hasPendingApproval) return { label: 'Pending approval', tone: 'pending' };
  if (status === 'completed') return { label: 'Completed', tone: 'executed' };
  if (status === 'failed') return { label: 'Failed', tone: 'failed' };
  return { label: 'Incomplete', tone: 'incomplete' };
}

function ToolCallList({ toolCalls = [] }) {
  if (!toolCalls.length) {
    return <p className="no-tool-calls">No monitoring tools were used for this investigation.</p>;
  }
  return <ul className="tool-call-list">
    {toolCalls.map((tool, index) => <li className="tool-call-row" key={`${tool.name}-${index}`}>
      <code>{tool.name}</code>
      <span className={`tool-call-result ${tool.success ? 'success' : 'failed'}`}>
        {tool.success ? 'Succeeded' : 'Failed'}
      </span>
    </li>)}
  </ul>;
}

export default function App() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const authenticatedUserId = isSignedIn ? userId : null;
  const activeUserId = useRef(authenticatedUserId);
  activeUserId.current = authenticatedUserId;
  const requestController = useRef(new AbortController());
  const [sessionReadyForUserId, setSessionReadyForUserId] = useState(null);
  const api = useMemo(() => createApiClient(getToken, () => (
    activeUserId.current === authenticatedUserId
      ? requestController.current.signal
      : AbortSignal.abort()
  )), [getToken, authenticatedUserId]);
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
  const [investigationQuestion, setInvestigationQuestion] = useState('');
  const [investigation, setInvestigation] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [investigationBusy, setInvestigationBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState({});
  const [investigationError, setInvestigationError] = useState('');
  const [approvalHistoryError, setApprovalHistoryError] = useState('');
  const [investigationHistory, setInvestigationHistory] = useState([]);
  const [investigationPage, setInvestigationPage] = useState(1);
  const [investigationPagination, setInvestigationPagination] = useState({
    page: 1, limit: INVESTIGATION_PAGE_SIZE, total: 0, totalPages: 1
  });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [selectedInvestigationId, setSelectedInvestigationId] = useState(null);
  const [selectedInvestigation, setSelectedInvestigation] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    requestController.current.abort();
    requestController.current = new AbortController();
    setEndpoints([]);
    setChecks([]);
    setSummary(null);
    setBusy({});
    setError('');
    setEditing(null);
    setExpanded(null);
    setInvestigationQuestion('');
    setInvestigation(null);
    setApprovals([]);
    setInvestigationBusy(false);
    setApprovalBusy({});
    setInvestigationError('');
    setApprovalHistoryError('');
    setInvestigationHistory([]);
    setInvestigationPage(1);
    setInvestigationPagination({
      page: 1, limit: INVESTIGATION_PAGE_SIZE, total: 0, totalPages: 1
    });
    setHistoryLoading(false);
    setHistoryError('');
    setSelectedInvestigationId(null);
    setSelectedInvestigation(null);
    setDetailLoading(false);
    setDetailError('');
    setSessionReadyForUserId(authenticatedUserId);
    return () => requestController.current.abort();
  }, [authenticatedUserId]);

  const load = useCallback(async () => {
    const requestUserId = authenticatedUserId;
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
      if (activeUserId.current !== requestUserId) return;
      setEndpoints(endpointData);
      setChecks(checkData);
      setSummary(summaryData);
    } catch (err) {
      if (activeUserId.current === requestUserId) setError(err.message);
    }
  }, [activeUserId, api, authenticatedUserId, filterId, from, to]);

  useEffect(() => {
    if (isLoaded && isSignedIn) load();
  }, [isLoaded, isSignedIn, load]);

  const loadInvestigationHistory = useCallback(async (page = investigationPage) => {
    const requestUserId = authenticatedUserId;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const history = await api(
        `/api/agent/investigations?page=${page}&limit=${INVESTIGATION_PAGE_SIZE}`
      );
      if (!Array.isArray(history.investigations) || !history.pagination) {
        throw new Error('Investigation history could not be loaded.');
      }
      if (activeUserId.current !== requestUserId) return;
      setInvestigationHistory(history.investigations);
      setInvestigationPagination(history.pagination);

      const approvalResults = await Promise.allSettled(history.investigations.map(
        ({ id }) => api(`/api/agent/investigations/${id}/approvals`)
      ));
      if (activeUserId.current !== requestUserId) return;
      const loadedApprovals = approvalResults
        .filter((result) => result.status === 'fulfilled')
        .flatMap((result) => result.value.approvals);
      const pageInvestigationIds = new Set(history.investigations.map(({ id }) => id));
      setApprovals((current) => [
        ...loadedApprovals,
        ...current.filter((item) => !pageInvestigationIds.has(item.investigationId))
      ]);
      setApprovalHistoryError(
        approvalResults.some((result) => result.status === 'rejected')
          ? 'Some approval states could not be loaded.'
          : ''
      );
    } catch (err) {
      if (activeUserId.current === requestUserId) {
        setHistoryError(err.message || 'Investigation history could not be loaded.');
      }
    } finally {
      if (activeUserId.current === requestUserId) setHistoryLoading(false);
    }
  }, [activeUserId, api, authenticatedUserId, investigationPage]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return undefined;
    loadInvestigationHistory(investigationPage);
  }, [isLoaded, isSignedIn, investigationPage, loadInvestigationHistory]);

  async function loadInvestigationDetail(id) {
    const requestUserId = authenticatedUserId;
    setSelectedInvestigationId(id);
    setSelectedInvestigation(null);
    setDetailLoading(true);
    setDetailError('');
    setApprovalHistoryError('');
    setInvestigation(null);

    const [detailResult, approvalResult] = await Promise.allSettled([
      api(`/api/agent/investigations/${id}`),
      api(`/api/agent/investigations/${id}/approvals`)
    ]);
    if (activeUserId.current !== requestUserId) return;

    if (detailResult.status === 'fulfilled' && detailResult.value.investigation) {
      setSelectedInvestigation(detailResult.value.investigation);
    } else {
      setDetailError(
        detailResult.status === 'rejected'
          ? detailResult.reason.message
          : 'Investigation details could not be loaded.'
      );
    }
    if (approvalResult.status === 'fulfilled') {
      setApprovals((current) => [
        ...approvalResult.value.approvals,
        ...current.filter((item) => item.investigationId !== id)
      ]);
    } else {
      setApprovalHistoryError(approvalResult.reason.message || 'Approval states could not be loaded.');
    }
    setDetailLoading(false);
  }

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
  const selectedHasPendingApproval = approvals.some(
    (approval) => approval.investigationId === selectedInvestigationId && approval.status === 'pending'
  );

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

  async function submitInvestigation(event) {
    event.preventDefault();
    const requestUserId = authenticatedUserId;
    setInvestigationBusy(true);
    setInvestigationError('');
    try {
      const result = await api('/api/agent/investigate', {
        method: 'POST',
        body: JSON.stringify({ question: investigationQuestion })
      });
      if (activeUserId.current !== requestUserId) return;
      setInvestigation(result);
      setInvestigationQuestion('');
      if (result.investigationId) {
        setSelectedInvestigationId(result.investigationId);
        await loadInvestigationHistory(1);
        await loadInvestigationDetail(result.investigationId);
      } else {
        await loadInvestigationHistory(1);
      }
    } catch (err) {
      if (activeUserId.current === requestUserId) setInvestigationError(err.message);
      if (activeUserId.current !== requestUserId) return;
      await loadInvestigationHistory(1);
    } finally {
      if (activeUserId.current === requestUserId) {
        setInvestigationBusy(false);
        setInvestigationPage(1);
      }
    }
  }

  async function respondToApproval(approval, action) {
    const requestUserId = authenticatedUserId;
    setApprovalBusy((current) => ({ ...current, [approval.id]: true }));
    setInvestigationError('');
    try {
      const result = await api(`/api/agent/approvals/${approval.id}/${action}`, { method: 'POST' });
      if (activeUserId.current !== requestUserId) return;
      setApprovals((current) => current.map((item) => item.id === approval.id ? result.approval : item));
      await loadInvestigationHistory(investigationPage);
      if (selectedInvestigationId === approval.investigationId) {
        await loadInvestigationDetail(approval.investigationId);
      }
    } catch (err) {
      if (activeUserId.current !== requestUserId) return;
      setInvestigationError(err.message);
      if (approval.investigationId) {
        try {
          const history = await api(`/api/agent/investigations/${approval.investigationId}/approvals`);
          if (activeUserId.current !== requestUserId) return;
          setApprovals((current) => [
            ...history.approvals,
            ...current.filter((item) => item.investigationId !== approval.investigationId)
          ]);
        } catch (refreshError) {
          if (activeUserId.current !== requestUserId) return;
          setApprovalHistoryError(refreshError.message || 'Approval states could not be refreshed.');
        }
      }
    } finally {
      if (activeUserId.current === requestUserId) {
        setApprovalBusy((current) => ({ ...current, [approval.id]: false }));
      }
    }
  }

  if (!isLoaded) {
    return <main className="auth-screen"><LoaderCircle className="spin" size={20} /> Checking your session...</main>;
  }
  if (!isSignedIn) {
    return <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand">pulse<span>check</span></div>
        <p>Sign in to access the API reliability dashboard.</p>
        <SignIn />
      </section>
    </main>;
  }
  if (sessionReadyForUserId !== authenticatedUserId) {
    return <main className="auth-screen"><LoaderCircle className="spin" size={20} /> Loading your workspace...</main>;
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
        <button className="nav-item" onClick={() => document.getElementById('investigation')?.scrollIntoView({ behavior: 'smooth' })}><MessageSquareText size={17} /> Investigation</button>
        <div className="sidebar-spacer" />
        <div className="simulation-note"><div><Zap size={15} /> SAFE SIMULATIONS</div><p>Built-in targets run locally. Custom targets are restricted to public IP addresses.</p><button onClick={() => setEditing({})}>Explore simulations <span>↗</span></button></div>
        <div className="profile"><span className="profile-avatar">PC</span><span><strong>Signed in</strong><small>Clerk account</small></span><UserButton /></div>
      </aside>

      <main className="main">
        <header className="topbar"><div className="breadcrumb">Monitoring <span>/</span> <strong>Overview</strong></div><div className="top-actions"><span className={`live-status ${endpoints.some((endpoint) => endpoint.last_success === 0) ? 'has-errors' : ''}`}><i /> {endpoints.some((endpoint) => endpoint.last_success === 0) ? 'Failures recorded' : 'No recent failures'}</span><button className="icon-button" title="Help"><CircleHelp size={18} /></button><UserButton /></div></header>
        <div className="content">
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot" /> LIVE MONITORING</div><h1>API overview</h1><p>Keep an eye on your endpoints and catch issues before your users do.</p></div><button className="primary-button" onClick={() => setEditing({})}><Plus size={17} /> Add endpoint</button></section>
          {error && <div className="error-banner" role="alert"><AlertTriangle size={17} />{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}

          <section className="metrics-grid">
            <MetricCard icon={<Activity size={17} />} label="Total requests" value={summary?.request_count ?? '—'} note="In selected period" tone="blue" />
            <MetricCard icon={<ShieldCheck size={17} />} label="Success rate" value={rateText(summary?.success_rate)} note="Successful checks" tone="green" />
            <MetricCard icon={<Zap size={17} />} label="Avg. latency" value={summary?.average_latency_ms == null ? '—' : `${summary.average_latency_ms} ms`} note="Across all checks" tone="purple" />
            <MetricCard icon={<AlertTriangle size={17} />} label="Error count" value={summary?.error_count ?? '—'} note="Failed checks" tone="orange" />
          </section>

          <section className="panel investigation-panel" id="investigation">
            <div className="panel-heading"><div><h2><MessageSquareText size={16} /> API investigation</h2><p>Read-only checks run immediately; operational actions wait for your approval.</p></div><span className="approval-policy"><ShieldCheck size={14} /> HUMAN REVIEW</span></div>
            <form className="investigation-form" onSubmit={submitInvestigation}>
              <label htmlFor="investigation-question">Question</label>
              <textarea id="investigation-question" value={investigationQuestion} onChange={(event) => setInvestigationQuestion(event.target.value)} maxLength={2000} required placeholder="Describe the API behavior you want investigated..." />
              <button type="submit" className="primary-button" disabled={investigationBusy}>{investigationBusy ? <LoaderCircle className="spin" size={15} /> : <MessageSquareText size={15} />} Investigate</button>
            </form>
            {investigationError && <div className="approval-error" role="alert"><AlertTriangle size={15} />{investigationError}</div>}
            {investigation && selectedInvestigation?.id !== investigation.investigationId && <div className="investigation-result">
              <div className="investigation-result-head">
                <strong>Investigation #{investigation.investigationId}</strong>
                <span className={`approval-status ${investigationStatus(
                  investigation.complete ? 'completed' : 'incomplete',
                  investigation.approvalRequired
                ).tone}`}>
                  {investigationStatus(
                    investigation.complete ? 'completed' : 'incomplete',
                    investigation.approvalRequired
                  ).label}
                </span>
              </div>
              <p>{investigation.answer}</p>
              <div className="investigation-evidence">
                <h3>Monitoring tool calls</h3>
                <ToolCallList toolCalls={investigation.toolCalls} />
              </div>
            </div>}
            {approvalHistoryError && <div className="approval-error" role="alert"><AlertTriangle size={15} />{approvalHistoryError}</div>}
            {approvals.length > 0 && <div className="approval-list">
              <h3>Proposed operations</h3>
              {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={Boolean(approvalBusy[approval.id])} onAction={respondToApproval} />)}
            </div>}
          </section>

          <section className="panel investigation-history-panel" aria-labelledby="investigation-history-title">
            <div className="panel-heading">
              <div>
                <h2 id="investigation-history-title">Investigation history</h2>
                <p>Review saved findings and the monitoring evidence used.</p>
              </div>
              <button
                type="button"
                className="subtle-button"
                onClick={() => loadInvestigationHistory(investigationPagination.page)}
                disabled={historyLoading}
              >
                {historyLoading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                Refresh
              </button>
            </div>
            {historyError && <div className="approval-error history-error" role="alert">
              <AlertTriangle size={15} />{historyError}
              <button type="button" className="history-retry" onClick={() => loadInvestigationHistory(investigationPagination.page)}>Retry</button>
            </div>}
            {historyLoading && !investigationHistory.length && <div className="history-loading"><LoaderCircle className="spin" size={17} /> Loading investigations...</div>}
            {!historyLoading && !historyError && !investigationHistory.length && <EmptyState
              icon={<MessageSquareText size={20} />}
              title="No investigations yet"
              text="Submit a question above to start an evidence-based investigation."
            />}
            {investigationHistory.length > 0 && <>
              <div className="investigation-history-list">
                {investigationHistory.map((item) => {
                  const pendingApproval = approvals.some(
                    (approval) => approval.investigationId === item.id && approval.status === 'pending'
                  );
                  const status = investigationStatus(item.status, pendingApproval);
                  return <button
                    type="button"
                    className={`investigation-history-item ${selectedInvestigationId === item.id ? 'selected' : ''}`}
                    key={item.id}
                    onClick={() => loadInvestigationDetail(item.id)}
                    aria-current={selectedInvestigationId === item.id ? 'true' : undefined}
                  >
                    <span className="history-item-heading">
                      <strong>#{item.id} · {item.question}</strong>
                      <span className={`approval-status ${status.tone}`}>{status.label}</span>
                    </span>
                    <span className="history-item-meta">{prettyDate(item.created_at)}</span>
                    <span className="history-item-summary">{item.safe_summary || 'No tool-call summary available.'}</span>
                  </button>;
                })}
              </div>
              <div className="history-pagination">
                <span>{investigationPagination.total} investigations · Page {investigationPagination.page} of {investigationPagination.totalPages}</span>
                <div>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label="Previous investigation page"
                    disabled={historyLoading || investigationPagination.page <= 1}
                    onClick={() => setInvestigationPage((page) => Math.max(1, page - 1))}
                  ><ChevronLeft size={16} /></button>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label="Next investigation page"
                    disabled={historyLoading || investigationPagination.page >= investigationPagination.totalPages}
                    onClick={() => setInvestigationPage((page) => Math.min(investigationPagination.totalPages, page + 1))}
                  ><ChevronRight size={16} /></button>
                </div>
              </div>
            </>}
            {selectedInvestigationId != null && <div className="investigation-detail" aria-live="polite">
              <div className="investigation-detail-heading">
                <h3>Investigation details</h3>
                {selectedInvestigation && (() => {
                  const status = investigationStatus(selectedInvestigation.status, selectedHasPendingApproval);
                  return <span className={`approval-status ${status.tone}`}>{status.label}</span>;
                })()}
              </div>
              {detailLoading && <div className="history-loading"><LoaderCircle className="spin" size={16} /> Loading details...</div>}
              {detailError && <div className="approval-error" role="alert">
                <AlertTriangle size={15} />{detailError}
                <button type="button" className="history-retry" onClick={() => loadInvestigationDetail(selectedInvestigationId)}>Retry</button>
              </div>}
              {selectedInvestigation && <>
                <p className="detail-question">{selectedInvestigation.question}</p>
                <p className="detail-answer">{selectedInvestigation.answer}</p>
                <div className="investigation-evidence">
                  <h3>Evidence summary</h3>
                  <p className="evidence-summary">{selectedInvestigation.safe_summary}</p>
                  <h3>Monitoring tool calls</h3>
                  <ToolCallList toolCalls={selectedInvestigation.tool_calls} />
                </div>
              </>}
            </div>}
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

function ApprovalCard({ approval, busy, onAction }) {
  const isEndpointCheck = approval.toolName === 'run_endpoint_check';
  const actionTitle = isEndpointCheck ? 'Run endpoint health check' : `Run ${simulationLabels[approval.arguments?.key] || 'local'} simulation`;
  const explanation = isEndpointCheck
    ? `This creates one new health-check record for endpoint #${approval.arguments?.endpointId}.`
    : `This runs the built-in ${simulationLabels[approval.arguments?.key] || 'local'} scenario once.`;
  const result = approval.result;

  return <article className="approval-card">
    <div className="approval-card-main">
      <div className="approval-card-title"><strong>{actionTitle}</strong><span className={`approval-status ${approval.status}`}>{approval.status}</span></div>
      <p>{explanation}</p>
      <dl className="approval-arguments">
        {isEndpointCheck
          ? <><dt>Endpoint ID</dt><dd>{approval.arguments?.endpointId}</dd></>
          : <><dt>Scenario</dt><dd>{simulationLabels[approval.arguments?.key] || 'Local simulation'}</dd></>}
      </dl>
          <div className="approval-context">Investigation #{approval.investigationId}{approval.status === 'pending' ? ` · Expires ${prettyDate(approval.expiresAt)}` : ''}</div>
      {result && <div className="approval-execution-result">
        {result.status_code != null && <span>HTTP {result.status_code}</span>}
        {result.duration_ms != null && <span>{result.duration_ms} ms</span>}
        {result.code && <span>{result.code}</span>}
      </div>}
    </div>
    {approval.status === 'pending' && <div className="approval-actions">
      <button type="button" className="outline-button" disabled={busy} onClick={() => onAction(approval, 'reject')}>{busy ? <LoaderCircle className="spin" size={14} /> : <X size={14} />} Reject</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => onAction(approval, 'approve')}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Approve</button>
    </div>}
  </article>;
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
