let state = null;
let currentLogsProjectId = null;
let logsTimer = null;
let compact = true;

const $ = (id) => document.getElementById(id);

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function loadState() {
  state = await api('/api/state');
  renderState();
}

function renderState() {
  if (!state) return;
  $('lanIp').textContent = state.network.bestIP;
  $('runtimeCount').textContent = state.counts.runtimes;
  $('tunnelCount').textContent = state.counts.tunnels;
  $('hostName').textContent = state.tool.host || '-';
  $('nodeVersion').textContent = state.tool.node || '-';
  $('bestIp').textContent = state.network.bestIP || '-';
  $('projectCount').textContent = state.projects.length;

  renderProvider('providerLocaltunnel', true);
  renderProvider('providerNgrok', state.providers.ngrok);
  renderProvider('providerCloudflared', state.providers.cloudflared);
  renderAdapters();
  renderProjects();
}

function renderProvider(id, ready) {
  const el = $(id);
  el.textContent = ready ? 'Ready' : 'Missing';
  el.className = ready ? 'good' : 'bad';
}

function renderAdapters() {
  const box = $('adapterList');
  box.innerHTML = '';
  for (const adapter of state.network.adapters || []) {
    const item = document.createElement('div');
    item.className = `adapter ${adapter.virtual ? 'virtual' : ''}`;
    item.innerHTML = `
      <div><b>${escapeHtml(adapter.name)}</b><span>${adapter.address}</span></div>
      <em>${adapter.primary ? 'PRIMARY' : adapter.virtual ? 'VIRTUAL' : 'LAN'}</em>
    `;
    box.appendChild(item);
  }
}

function renderProjects() {
  const grid = $('projectGrid');
  const search = $('searchInput').value.trim().toLowerCase();
  const filter = $('typeFilter').value;
  const projects = (state.projects || []).filter((project) => {
    const matchSearch = !search || project.name.toLowerCase().includes(search);
    const normalizedType = project.type === 'fullstack-root' ? 'fullstack' : project.type;
    const matchType = filter === 'all' || normalizedType === filter;
    return matchSearch && matchType;
  });

  grid.innerHTML = projects.map(projectCard).join('');
}

function projectCard(project) {
  const typeLabel = typeText(project.type);
  const status = project.running ? 'RUNNING' : (project.status || 'STOPPED');
  const statusClass = status === 'RUNNING' ? 'running' : status === 'ERROR' ? 'error' : '';
  const tunnelBadge = project.tunnelStatus === 'ACTIVE' ? '<span class="badge tunnel">TUNNEL ACTIVE</span>' : '';
  const portLabel = project.runtimePort || project.staticPort || project.frontendPort || project.backendPort || 'Detecting';
  const provider = providerName(project.provider);
  const localValue = project.localTarget || 'Not started';
  const lanValue = project.lanTarget || (project.running ? '' : 'Start project first');
  const publicValue = project.publicUrl || 'No public URL yet';
  const rootMissing = !project.rootPath;
  const rootWarning = rootMissing ? '<div class="card-warning">Project root path missing. Edit project before starting.</div>' : '';

  const detailEndpoints = compact ? '' : extraEndpoints(project);

  return `
    <article class="project-card ${project.type}">
      <div class="card-head">
        <div>
          <h3 class="card-title">${escapeHtml(project.name)}</h3>
          <div class="badges">
            <span class="badge">${typeLabel}</span>
            <span class="badge">:${portLabel}</span>
            <span class="badge ${statusClass}">${status}</span>
            ${tunnelBadge}
          </div>
        </div>
        <button class="btn small ghost" onclick="openEdit('${project.id}')">Edit</button>
      </div>

      ${rootWarning}

      <div class="endpoint-grid">
        <div class="endpoint">
          <span>Local Target</span>
          <b class="${!project.localTarget ? 'empty' : ''}" title="${escapeHtml(localValue)}">${escapeHtml(localValue)}</b>
        </div>
        <div class="endpoint">
          <span>Provider</span>
          <b>${provider}</b>
        </div>
        <div class="endpoint">
          <span>LAN Endpoint</span>
          <b class="${!project.lanTarget ? 'empty' : ''}" title="${escapeHtml(lanValue)}">${escapeHtml(lanValue)}</b>
        </div>
        <div class="endpoint">
          <span>Public Endpoint</span>
          <b class="${!project.publicUrl ? 'empty' : ''}" title="${escapeHtml(publicValue)}">${escapeHtml(publicValue)}</b>
        </div>
        ${detailEndpoints}
      </div>

      <div class="card-actions">
        <button class="btn primary" onclick="startProject('${project.id}')">Start</button>
        <button class="btn ghost" onclick="stopProject('${project.id}')">Stop</button>
        <button class="btn ghost" onclick="restartProject('${project.id}')">Restart</button>
        <button class="btn outline" onclick="startTunnel('${project.id}')">Tunnel</button>
        <button class="btn ghost" onclick="stopTunnel('${project.id}')">Stop Tunnel</button>
        <button class="btn ghost" onclick="openProjectUrl('${project.id}')">Open</button>
        <button class="btn ghost" onclick="copyBestUrl('${project.id}')">Copy</button>
        <button class="btn ghost" onclick="openLogs('${project.id}', '${escapeAttr(project.name)}')">Logs</button>
        <button class="btn danger-soft" onclick="deleteProject('${project.id}')">Delete</button>
      </div>
    </article>
  `;
}

function extraEndpoints(project) {
  const parts = [];
  if (project.frontendTarget) {
    parts.push(`<div class="endpoint"><span>Frontend</span><b title="${escapeHtml(project.frontendTarget)}">${escapeHtml(project.frontendTarget)}</b></div>`);
  }
  if (project.backendTarget) {
    parts.push(`<div class="endpoint"><span>API Target</span><b title="${escapeHtml(project.backendTarget)}">${escapeHtml(project.backendTarget)}</b></div>`);
  }
  if (project.proxyTarget) {
    parts.push(`<div class="endpoint wide"><span>Proxy Target</span><b title="${escapeHtml(project.proxyTarget)}">${escapeHtml(project.proxyTarget)}</b></div>`);
  }
  return parts.join('');
}

function typeText(type) {
  return {
    auto: 'AUTO',
    static: 'STATIC',
    frontend: 'FRONTEND',
    api: 'API',
    server: 'SERVER APP',
    fullstack: 'FULL STACK',
    'fullstack-root': 'FULL STACK ROOT'
  }[type] || String(type || 'PROJECT').toUpperCase();
}

function providerName(provider) {
  return {
    localtunnel: 'LocalTunnel',
    ngrok: 'Ngrok',
    cloudflared: 'Cloudflared'
  }[provider] || provider || 'LocalTunnel';
}

async function startProject(id) {
  try {
    toast('Starting project...');
    await api(`/api/projects/${id}/start`, { method: 'POST', body: '{}' });
    await loadState();
    toast('Project started');
  } catch (error) {
    toast(error.message);
    await loadState().catch(() => {});
  }
}

async function stopProject(id) {
  try {
    await api(`/api/projects/${id}/stop`, { method: 'POST', body: '{}' });
    await loadState();
    toast('Project stopped');
  } catch (error) {
    toast(error.message);
  }
}

async function restartProject(id) {
  try {
    toast('Restarting project...');
    await api(`/api/projects/${id}/restart`, { method: 'POST', body: '{}' });
    await loadState();
    toast('Project restarted');
  } catch (error) {
    toast(error.message);
    await loadState().catch(() => {});
  }
}

async function startTunnel(id) {
  try {
    toast('Starting public tunnel...');
    await api(`/api/projects/${id}/tunnel/start`, { method: 'POST', body: '{}' });
    await loadState();
    toast('Tunnel starting. URL will appear soon.');
    setTimeout(loadState, 2500);
    setTimeout(loadState, 5000);
  } catch (error) {
    toast(error.message);
  }
}

async function stopTunnel(id) {
  try {
    await api(`/api/projects/${id}/tunnel/stop`, { method: 'POST', body: '{}' });
    await loadState();
    toast('Tunnel stopped');
  } catch (error) {
    toast(error.message);
  }
}

async function deleteProject(id) {
  if (!confirm('Delete this project from dashboard?')) return;
  try {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    await loadState();
    toast('Project deleted');
  } catch (error) {
    toast(error.message);
  }
}

function openUrl(url) {
  if (!url) return toast('No URL available yet');
  window.open(url, '_blank');
}

function openProjectUrl(id) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return toast('Project not found');
  if (!project.localTarget) return toast('No target URL. Start the project first.');
  openUrl(project.localTarget);
}

async function copyBestUrl(id) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  const value = project.publicUrl || project.lanTarget || project.localTarget;
  if (!value) return toast('No URL available yet');
  await navigator.clipboard.writeText(value);
  toast('URL copied');
}

function openAdd() {
  $('modalTitle').textContent = 'Add Project';
  $('projectForm').reset();
  $('projectId').value = '';
  $('projectType').value = 'auto';
  $('provider').value = 'localtunnel';
  $('staticPort').value = '';
  $('apiPrefix').value = '/api';
  $('advancedBox').classList.add('hidden');
  $('advancedToggle').textContent = 'Show Advanced Settings';
  $('detectResult').classList.add('hidden');
  $('projectModal').classList.remove('hidden');
}

function openEdit(id) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  $('modalTitle').textContent = `Edit ${project.name}`;
  $('projectId').value = project.id;
  $('projectName').value = project.name || '';
  $('rootPath').value = project.rootPath || '';
  $('projectType').value = project.type || 'auto';
  $('provider').value = project.provider || 'localtunnel';
  $('staticPort').value = project.staticPort || '';
  $('frontendPort').value = project.frontendPort || '';
  $('backendPort').value = project.backendPort || '';
  $('proxyPort').value = project.proxyPort || '';
  $('frontendFolder').value = project.frontendFolder || '';
  $('backendFolder').value = project.backendFolder || '';
  $('rootCommand').value = project.rootCommand || '';
  $('frontendCommand').value = project.frontendCommand || '';
  $('backendCommand').value = project.backendCommand || '';
  $('apiPrefix').value = project.apiPrefix || '/api';
  $('stripApiPrefix').checked = Boolean(project.stripApiPrefix);
  $('autoInstall').checked = Boolean(project.autoInstall);
  $('advancedBox').classList.add('hidden');
  $('advancedToggle').textContent = 'Show Advanced Settings';
  $('detectResult').classList.add('hidden');
  $('projectModal').classList.remove('hidden');
  setTimeout(() => $('projectName').focus(), 100);
}

function closeModal() {
  $('projectModal').classList.add('hidden');
}

function collectForm() {
  return {
    name: $('projectName').value.trim(),
    rootPath: $('rootPath').value.trim(),
    type: $('projectType').value,
    provider: $('provider').value,
    staticPort: $('staticPort').value.trim(),
    frontendPort: $('frontendPort').value.trim(),
    backendPort: $('backendPort').value.trim(),
    proxyPort: $('proxyPort').value.trim(),
    frontendFolder: $('frontendFolder').value.trim(),
    backendFolder: $('backendFolder').value.trim(),
    rootCommand: $('rootCommand').value.trim(),
    frontendCommand: $('frontendCommand').value.trim(),
    backendCommand: $('backendCommand').value.trim(),
    apiPrefix: $('apiPrefix').value.trim() || '/api',
    stripApiPrefix: $('stripApiPrefix').checked,
    autoInstall: $('autoInstall').checked
  };
}

async function detectCurrentProject() {
  try {
    const id = $('projectId').value || 'preview';
    const data = collectForm();
    const detected = await api(`/api/projects/${id}/detect`, { method: 'POST', body: JSON.stringify(data) });
    applyDetected(detected);
    $('detectResult').textContent = formatDetected(detected);
    $('detectResult').classList.remove('hidden');
    toast('Detection completed');
  } catch (error) {
    toast(error.message);
  }
}

function applyDetected(detected) {
  $('projectType').value = detected.type || $('projectType').value;
  $('staticPort').value = detected.staticPort || '';
  $('frontendPort').value = detected.frontendPort || '';
  $('backendPort').value = detected.backendPort || '';
  $('proxyPort').value = detected.proxyPort || '';
  $('frontendFolder').value = detected.frontendFolder || '';
  $('backendFolder').value = detected.backendFolder || '';
  $('rootCommand').value = detected.rootCommand || '';
  $('frontendCommand').value = detected.frontendCommand || '';
  $('backendCommand').value = detected.backendCommand || '';
  $('apiPrefix').value = detected.apiPrefix || '/api';
}

function formatDetected(detected) {
  const lines = [];
  lines.push(`Detected type: ${detected.type}`);
  if (detected.detected?.packageManager) lines.push(`Package manager: ${detected.detected.packageManager}`);
  if (detected.frontendFolder) lines.push(`Frontend folder: ${detected.frontendFolder}`);
  if (detected.backendFolder) lines.push(`Backend folder: ${detected.backendFolder}`);
  if (detected.rootCommand) lines.push(`Root command: ${detected.rootCommand}`);
  if (detected.frontendCommand) lines.push(`Frontend command: ${detected.frontendCommand}`);
  if (detected.backendCommand) lines.push(`Backend command: ${detected.backendCommand}`);
  if (detected.staticPort) lines.push(`Static port: ${detected.staticPort}`);
  if (detected.frontendPort) lines.push(`Frontend port: ${detected.frontendPort}`);
  if (detected.backendPort) lines.push(`Backend port: ${detected.backendPort}`);
  if (detected.proxyPort) lines.push(`Proxy port: ${detected.proxyPort}`);
  if (detected.warnings?.length) lines.push(`Warnings: ${detected.warnings.join(', ')}`);
  return lines.join('\n');
}

async function saveProject(event) {
  event.preventDefault();
  try {
    const id = $('projectId').value;
    const payload = collectForm();
    if (!payload.name) return toast('Project name required');
    if (!payload.rootPath) return toast('Project Root Path is required');
    const root = payload.rootPath.replace(/\\/g, '/');
    if (!id) {
      const exists = state.projects.some((p) => p.rootPath && p.rootPath.replace(/\\/g, '/') === root && p.id !== id);
      if (exists) return toast('A project with this root path already exists');
    }
    if (id) {
      await api(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModal();
    await loadState();
    toast('Project saved');
  } catch (error) {
    toast(error.message);
  }
}

async function openLogs(id, name) {
  currentLogsProjectId = id;
  $('logsTitle').textContent = `${name} Logs`;
  $('logsDrawer').classList.remove('hidden');
  await refreshLogs();
  clearInterval(logsTimer);
  logsTimer = setInterval(refreshLogs, 1400);
}

function closeLogs() {
  $('logsDrawer').classList.add('hidden');
  clearInterval(logsTimer);
  logsTimer = null;
  currentLogsProjectId = null;
}

async function refreshLogs() {
  if (!currentLogsProjectId) return;
  try {
    const data = await api(`/api/projects/${currentLogsProjectId}/logs`);
    $('logsOutput').textContent = (data.logs || []).join('\n') || 'Waiting...';
    $('logsOutput').scrollTop = $('logsOutput').scrollHeight;
  } catch (error) {
    $('logsOutput').textContent = error.message;
  }
}

async function clearLogs() {
  if (!currentLogsProjectId) return;
  try {
    await api(`/api/projects/${currentLogsProjectId}/logs`, { method: 'DELETE' });
    await refreshLogs();
    toast('Logs cleared');
  } catch (error) {
    toast(error.message);
  }
}

async function startAll() {
  try {
    toast('Starting all projects...');
    await api('/api/start-all', { method: 'POST', body: '{}' });
    await loadState();
    toast('Start All completed');
  } catch (error) {
    toast(error.message);
  }
}

async function stopAll() {
  try {
    await api('/api/stop-all', { method: 'POST', body: '{}' });
    await loadState();
    toast('All stopped');
  } catch (error) {
    toast(error.message);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

$('refreshBtn').addEventListener('click', loadState);
$('addProjectBtn').addEventListener('click', openAdd);
$('startAllBtn').addEventListener('click', startAll);
$('stopAllBtn').addEventListener('click', stopAll);
$('closeModalBtn').addEventListener('click', closeModal);
$('cancelBtn').addEventListener('click', closeModal);
$('projectForm').addEventListener('submit', saveProject);
$('detectBtn').addEventListener('click', detectCurrentProject);
$('closeLogsBtn').addEventListener('click', closeLogs);
$('clearLogsBtn').addEventListener('click', clearLogs);
$('searchInput').addEventListener('input', renderProjects);
$('typeFilter').addEventListener('change', renderProjects);
$('compactBtn').addEventListener('click', () => {
  compact = !compact;
  $('compactBtn').textContent = compact ? 'Compact' : 'Expanded';
  renderProjects();
});
$('advancedToggle').addEventListener('click', () => {
  const box = $('advancedBox');
  box.classList.toggle('hidden');
  $('advancedToggle').textContent = box.classList.contains('hidden') ? 'Show Advanced Settings' : 'Hide Advanced Settings';
});

loadState();
setInterval(loadState, 5000);
