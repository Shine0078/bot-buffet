const state = { data: null, selected: null, view: 'office' };
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c],
  );
async function api(path, options = {}) {
  const r = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      'x-bot-buffet-user': 'local-user',
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!r.ok) throw new Error((await r.json()).message || r.statusText);
  return r.json();
}
async function load() {
  state.data = await api('/api/v1/bootstrap');
  render();
}
function showError(message) {
  const activity = $('#activity');
  if (activity) activity.innerHTML = '<p class="muted">' + esc(message) + '</p>';
}
function switchView(view) {
  state.view = view;
  document
    .querySelectorAll('.nav-item')
    .forEach((x) => x.classList.toggle('active', x.dataset.view === state.view));
  if (state.view === 'office') {
    $('#officeView').classList.remove('hidden');
    $('#tableView').classList.add('hidden');
    $('#viewTitle').textContent = 'Office floor';
    $('#viewSubtitle').textContent = 'A calm view of agents, work, and evidence.';
    return Promise.resolve();
  }
  if (state.view === 'usage') return usageTable();
  table(state.view);
  return Promise.resolve();
}
async function createProject() {
  const name = window.prompt('Project name');
  if (name === null) return;
  const trimmed = name.trim() || 'Untitled project';
  const workspaceId = $('#workspaceSelect')?.value;
  await api('/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ name: trimmed, ...(workspaceId ? { workspaceId } : {}) }),
  });
  await load();
}
async function addScopedRecord() {
  if (state.view === 'office') return createProject();
  if (state.view === 'tasks') {
    const title = window.prompt('Task title');
    if (title === null) return;
    const projectId = $('#projectSelect')?.value || state.data?.projects?.[0]?.id;
    if (!projectId) throw new Error('Select a project first');
    const environments = await api('/api/v1/environments');
    const environment = (environments || []).find((item) => item.projectId === projectId);
    if (!environment) throw new Error('No environment for this project');
    await api('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        environmentId: environment.id,
        title: title.trim() || 'Untitled task',
      }),
    });
    await load();
    return switchView('tasks');
  }
  await switchView(state.view);
}
function render() {
  const d = state.data || {};
  $('#workspaceSelect').innerHTML = (d.workspaces || [])
    .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)
    .join('');
  $('#projectSelect').innerHTML = (d.projects || [])
    .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)
    .join('');
  const runs = d.runs || [],
    agents = d.agents || [];
  $('#agentCount').textContent = agents.length;
  $('#activeCount').textContent = runs.filter((x) =>
    ['running', 'queued', 'waiting_approval'].includes(x.status),
  ).length;
  $('#approvalCount').textContent = (d.approvals || []).length;
  $('#budget').textContent =
    '$' + (runs.reduce((n, x) => n + (x.costCents || 0), 0) / 100).toFixed(2);
  $('#agentDesks').innerHTML =
    agents.map(agentCard).join('') ||
    `<div class="empty-state"><h2>No agents yet</h2><p>Create an agent to start operating this project.</p></div>`;
  const task = (d.tasks || [])[0];
  $('#criteria').innerHTML = (task?.acceptanceCriteria || ['Create a project and assign work'])
    .map((x, i) => `<div><span class="check">${i ? '○' : '✓'}</span><span>${esc(x)}</span></div>`)
    .join('');
  $('#activity').innerHTML =
    runs.slice(-6).reverse().map(runEvent).join('') || '<p class="muted">No run events yet.</p>';
  $('#approvals').innerHTML =
    (d.approvals || []).map(approvalCard).join('') ||
    '<p class="muted">Nothing waiting for approval.</p>';
  if (state.selected) selectAgent(state.selected);
}
function agentCard(a) {
  const run =
    (state.data.runs || []).find((x) => x.id === a.currentRunId) ||
    (state.data.runs || []).find(
      (x) => x.agentId === a.id && ['running', 'waiting_approval', 'paused'].includes(x.status),
    );
  const task =
    (state.data.tasks || []).find((x) => x.id === a.currentTaskId) || state.data.tasks?.[0];
  return `<article class="desk" role="button" tabindex="0" aria-label="Inspect ${esc(a.profile?.name || 'Agent')}" data-agent="${esc(a.id)}"><div class="desk-top"><div class="avatar" aria-hidden="true">${esc(a.profile?.avatar || '◈')}</div><div><div class="desk-name">${esc(a.profile?.name || 'Agent')}</div><div class="desk-role">${esc(a.profile?.mission || 'Operator')}</div></div><span class="status ${esc(a.status)}">${esc(a.status)}</span></div><div class="desk-task">${esc(task?.title || 'Waiting for a task')}</div><div class="progress" aria-label="Run progress"><span style="width:${run ? Math.min(100, Math.round(((run.stepCount || 0) / (run.maxSteps || 1)) * 100)) : 0}%"></span></div><div class="desk-foot"><span>${esc(run ? `${run.stepCount || 0}/${run.maxSteps} steps` : 'Ready')}</span><span>${run ? '$' + ((run.costCents || 0) / 100).toFixed(2) : 'Local'}</span></div></article>`;
}
function runEvent(r) {
  return `<div class="timeline-item"><span class="bar"></span><div><p><strong>${esc(r.status)}</strong> · ${esc(r.mode || 'run')}</p><small>${esc(r.id)} · ${esc(r.agentId)}</small></div><time>${r.updatedAt ? new Date(r.updatedAt).toLocaleTimeString() : ''}</time></div>`;
}
function approvalCard(a) {
  return `<div class="approval"><strong>${esc(a.action)}</strong><small>${esc(a.risk)} risk · expires ${new Date(a.expiresAt).toLocaleTimeString()}</small><div class="approval-actions"><button class="approve" data-approval="${esc(a.id)}" data-approved="true">Approve</button><button data-approval="${esc(a.id)}" data-approved="false">Reject</button></div></div>`;
}
function selectAgent(id) {
  state.selected = id;
  const a = (state.data.agents || []).find((x) => x.id === id);
  if (!a) return;
  $('#inspectorContent').innerHTML =
    `<div class="agent-detail"><div class="detail-head"><div class="avatar">${esc(a.profile?.avatar || '◈')}</div><div><h2>${esc(a.profile?.name)}</h2><div class="detail-role">${esc(a.profile?.mission)}</div></div></div><div class="detail-list"><div><span>Status</span><strong>${esc(a.status)}</strong></div><div><span>Mode</span><strong>${esc(a.profile?.mode)}</strong></div><div><span>Network</span><strong>${esc(a.profile?.network)}</strong></div><div><span>Max steps</span><strong>${esc(a.profile?.maxSteps)}</strong></div><div><span>Tools</span><strong>${a.profile?.allowedToolIds?.length || 0} allowed</strong></div><div><span>Memory</span><strong>Project scoped</strong></div></div></div>`;
}
async function usageTable() {
  $('#viewTitle').textContent = 'Usage and cost';
  $('#viewSubtitle').textContent = 'Spend, tokens, and latency for the current month.';
  $('#officeView').classList.add('hidden');
  $('#tableView').classList.remove('hidden');
  $('#tableTitle').textContent = 'Usage by agent';
  const columns = ['key', 'costCents', 'tokensIn', 'tokensOut', 'calls'];
  $('#tableHead').innerHTML = '<tr>' + columns.map((x) => `<th>${esc(x)}</th>`).join('') + '</tr>';
  try {
    const report = await api('/api/v1/usage?groupBy=agent&period=monthly');
    $('#tableBody').innerHTML =
      (report.buckets || [])
        .map((row) => '<tr>' + columns.map((k) => `<td>${esc(row[k])}</td>`).join('') + '</tr>')
        .join('') || '<tr><td colspan="5" class="muted">No recorded usage yet.</td></tr>';
  } catch (err) {
    $('#tableBody').innerHTML =
      `<tr><td colspan="5" class="muted">Unable to load usage: ${esc(err.message)}</td></tr>`;
  }
}
function table(view) {
  const d = state.data || {};
  const cfg = {
    tasks: ['Tasks', d.tasks || [], ['title', 'status', 'priority']],
    runs: ['Runs', d.runs || [], ['id', 'status', 'stepCount', 'costCents']],
    models: ['Models', d.models || [], ['name', 'modelName', 'local', 'available']],
    audit: ['Audit log', d.audit || [], ['action', 'risk', 'decision', 'createdAt']],
    files: ['Files', d.files || [], ['path', 'size', 'versionLabel']],
    memory: ['Memory', d.memory || [], ['namespace', 'text', 'approved']],
    tools: ['Tools', d.tools || [], ['name', 'risk', 'enabled']],
    evaluations: ['Evaluations', d.evaluations || [], ['name', 'description', 'versionLabel']],
    budgets: [
      'Budgets',
      (d.budgets || []).map((b) => ({
        name: b.name,
        period: b.period,
        limit: '$' + ((b.limitCents || 0) / 100).toFixed(2),
        spent: '$' + ((b.status?.spentCents || 0) / 100).toFixed(2),
        state: b.status?.state || 'ok',
      })),
      ['name', 'period', 'limit', 'spent', 'state'],
    ],
    alerts: ['Alerts', d.alerts || [], ['severity', 'title', 'message', 'acknowledged']],
    workflows: [
      'Workflows',
      (d.workflows || []).map((w) => ({
        name: w.name,
        nodes: (w.nodes || []).length,
        edges: (w.edges || []).length,
        enabled: w.enabled,
      })),
      ['name', 'nodes', 'edges', 'enabled'],
    ],
  }[view] || ['Items', [], ['id', 'createdAt']];
  $('#viewTitle').textContent = cfg[0];
  $('#viewSubtitle').textContent = 'Inspect scoped records and evidence.';
  $('#officeView').classList.add('hidden');
  $('#tableView').classList.remove('hidden');
  $('#tableTitle').textContent = cfg[0];
  $('#tableHead').innerHTML = '<tr>' + cfg[2].map((x) => `<th>${esc(x)}</th>`).join('') + '</tr>';
  $('#tableBody').innerHTML =
    cfg[1]
      .map((row) => '<tr>' + cfg[2].map((k) => `<td>${esc(row[k])}</td>`).join('') + '</tr>')
      .join('') || '<tr><td colspan="6" class="muted">No records in this scope.</td></tr>';
}
document.addEventListener('click', async (e) => {
  const n = e.target.closest('[data-agent]');
  if (n) {
    selectAgent(n.dataset.agent);
    return;
  }
  const a = e.target.closest('[data-approval]');
  if (a) {
    await api('/api/v1/approvals/' + a.dataset.approval, {
      method: 'POST',
      body: JSON.stringify({ approved: a.dataset.approved === 'true' }),
    });
    await load();
    return;
  }
  const nav = e.target.closest('[data-view]');
  if (nav) {
    await switchView(nav.dataset.view);
  }
});
document.addEventListener('keydown', (e) => {
  const agent = e.target.closest('[data-agent]');
  if (!agent || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  selectAgent(agent.dataset.agent);
});
$('#refresh').onclick = load;
$('#newProject').onclick = () => createProject().catch((err) => showError(err.message));
$('#viewAllRuns').onclick = () => switchView('runs');
$('#tableAction').onclick = () => addScopedRecord().catch((err) => showError(err.message));
$('#globalStop').onclick = async () => {
  if (confirm('Stop all active runs?')) {
    await api('/api/v1/stop-all', { method: 'POST' });
    await load();
  }
};
$('#closeInspector').onclick = () => {
  $('#inspectorContent').innerHTML =
    '<div class="empty-state"><span class="empty-icon">⌁</span><h2>Select an agent</h2><p>Choose a desk to inspect status, model, permissions, and recent actions.</p></div>';
  state.selected = null;
};
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  $('#chatMessages').innerHTML += `<p><strong>You</strong> ${esc(text)}</p>`;
  $('#chatInput').value = '';
};
new EventSource('/events').onmessage = () => load();
load().catch((err) => {
  const fileHint =
    location.protocol === 'file:' ? ' Open http://127.0.0.1:8787/ instead of this file.' : '';
  showError('Unable to load control plane: ' + err.message + fileHint);
});
