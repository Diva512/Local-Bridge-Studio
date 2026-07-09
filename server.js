const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, execFile } = require('child_process');
const httpProxy = require('http-proxy');

const APP_PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let projects = loadProjects();
const logs = new Map();
const runtimes = new Map();
const tunnels = new Map();

function normalizeProject(raw = {}) {
  const id = raw.id || slugify(raw.name || `project-${Date.now()}`);
  return {
    id,
    name: raw.name || 'Untitled Project',
    type: raw.type || 'auto',
    rootPath: raw.rootPath || '',
    frontendFolder: raw.frontendFolder || '',
    backendFolder: raw.backendFolder || '',
    frontendCommand: raw.frontendCommand || '',
    backendCommand: raw.backendCommand || '',
    rootCommand: raw.rootCommand || '',
    staticPort: numberOrEmpty(raw.staticPort),
    frontendPort: numberOrEmpty(raw.frontendPort),
    backendPort: numberOrEmpty(raw.backendPort || raw.apiPort),
    proxyPort: numberOrEmpty(raw.proxyPort),
    apiPrefix: raw.apiPrefix || '/api',
    stripApiPrefix: Boolean(raw.stripApiPrefix),
    provider: raw.provider || 'localtunnel',
    autoInstall: Boolean(raw.autoInstall),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}

function loadProjects() {
  try {
    if (!fs.existsSync(PROJECTS_FILE)) {
      fs.writeFileSync(PROJECTS_FILE, '[]');
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.map(normalizeProject) : [];
  } catch (error) {
    console.error('Could not load projects:', error.message);
    return [];
  }
}

function saveProjects() {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function slugify(value) {
  return String(value || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `project-${Date.now()}`;
}

function numberOrEmpty(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : '';
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function appendLog(projectId, message) {
  if (!logs.has(projectId)) logs.set(projectId, []);
  const clean = String(message || '').replace(/\r/g, '').trimEnd();
  if (!clean) return;
  const lines = clean.split('\n').filter(Boolean);
  const list = logs.get(projectId);
  for (const line of lines) {
    list.push(`[${nowTime()}] ${line}`);
  }
  if (list.length > 600) list.splice(0, list.length - 600);
}

function getProject(id) {
  return projects.find((p) => p.id === id);
}

function resolveProjectPath(project, subFolder) {
  const root = project.rootPath ? path.resolve(project.rootPath) : '';
  if (!subFolder) return root;
  if (path.isAbsolute(subFolder)) return path.resolve(subFolder);
  return path.resolve(root, subFolder);
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function getPackageManager(rootPath) {
  if (!rootPath) return 'npm';
  if (fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(rootPath, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(rootPath, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function getRunCommand(rootPath, preferredKind) {
  const pkg = readJson(path.join(rootPath, 'package.json')) || {};
  const scripts = pkg.scripts || {};
  const manager = getPackageManager(rootPath);
  const run = (scriptName) => {
    if (manager === 'npm') return `npm run ${scriptName}`;
    if (manager === 'pnpm') return `pnpm ${scriptName}`;
    if (manager === 'yarn') return `yarn ${scriptName}`;
    if (manager === 'bun') return `bun run ${scriptName}`;
    return `npm run ${scriptName}`;
  };

  const candidates = [];
  if (preferredKind === 'frontend') candidates.push('dev:client', 'client', 'frontend', 'dev', 'start');
  else if (preferredKind === 'backend') candidates.push('dev:server', 'server', 'backend', 'api', 'dev', 'start');
  else candidates.push('dev', 'start', 'server', 'backend');

  for (const name of candidates) {
    if (scripts[name]) {
      if (name === 'start' && manager === 'npm') return 'npm start';
      if (name === 'start' && manager === 'pnpm') return 'pnpm start';
      if (name === 'start' && manager === 'yarn') return 'yarn start';
      if (name === 'start' && manager === 'bun') return 'bun start';
      return run(name);
    }
  }
  if (fs.existsSync(path.join(rootPath, 'server.js'))) return 'node server.js';
  if (fs.existsSync(path.join(rootPath, 'index.js'))) return 'node index.js';
  if (fs.existsSync(path.join(rootPath, 'app.js'))) return 'node app.js';
  return '';
}

function detectPortsFromEnv(rootPath) {
  const files = ['.env', '.env.local', '.env.development'];
  const keys = ['PORT', 'API_PORT', 'SERVER_PORT', 'BACKEND_PORT', 'FRONTEND_PORT', 'VITE_PORT'];
  const found = {};
  for (const file of files) {
    const full = path.join(rootPath, file);
    if (!fs.existsSync(full)) continue;
    const text = readText(full);
    for (const key of keys) {
      const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*([0-9]{2,5})`, 'i'));
      if (match) found[key] = Number(match[1]);
    }
  }
  return found;
}

function detectPortFromText(text) {
  const value = String(text || '');
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[^\]]+\])[:/]([0-9]{2,5})/i,
    /localhost:([0-9]{2,5})/i,
    /127\.0\.0\.1:([0-9]{2,5})/i,
    /0\.0\.0\.0:([0-9]{2,5})/i,
    /(?:port|listening on|server on|running on|started on|interface mapping).*?([0-9]{2,5})/i,
    /:([0-9]{4,5})\b/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

function detectAllPortsFromText(text) {
  const set = new Set();
  const value = String(text || '');
  const regexes = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[^\]]+\])[:/]([0-9]{2,5})/gi,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):([0-9]{2,5})/gi,
    /(?:port|listening on|server on|running on|started on|interface mapping).*?([0-9]{2,5})/gi
  ];
  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(value))) {
      const n = Number(match[1]);
      if (n > 0 && n < 65536) set.add(n);
    }
  }
  return [...set];
}

function detectProjectConfig(inputProject) {
  const project = normalizeProject(inputProject);
  const root = project.rootPath ? path.resolve(project.rootPath) : '';
  const result = { ...project, warnings: [], detected: {} };

  if (!root || !fs.existsSync(root)) {
    result.warnings.push('Project Root Path missing or not found.');
    return result;
  }

  const pkg = readJson(path.join(root, 'package.json')) || null;
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const depNames = Object.keys(deps).map((d) => d.toLowerCase());
  const hasDep = (names) => names.some((n) => depNames.includes(n));

  const frontendDirs = ['frontend', 'client', 'web', 'ui', 'app'].filter((d) => fs.existsSync(path.join(root, d)));
  const backendDirs = ['backend', 'server', 'api'].filter((d) => fs.existsSync(path.join(root, d)));
  const hasStaticIndex = fs.existsSync(path.join(root, 'index.html')) || fs.existsSync(path.join(root, 'public', 'index.html'));
  const isFrontend = hasDep(['vite', 'react', 'next', 'vue', '@angular/core', 'svelte']);
  const isBackend = hasDep(['express', 'fastify', 'koa', 'hapi', 'socket.io', 'ws', 'cors']);
  const envPorts = detectPortsFromEnv(root);

  result.detected.packageManager = getPackageManager(root);
  result.detected.hasPackageJson = Boolean(pkg);
  result.detected.frontendDirs = frontendDirs;
  result.detected.backendDirs = backendDirs;
  result.detected.envPorts = envPorts;

  if (project.type === 'auto') {
    if (frontendDirs.length && backendDirs.length) result.type = 'fullstack';
    else if (isFrontend && isBackend) result.type = 'fullstack-root';
    else if (isFrontend) result.type = 'frontend';
    else if (isBackend) result.type = 'api';
    else if (hasStaticIndex && !pkg) result.type = 'static';
    else if (pkg) result.type = 'api';
    else result.type = 'static';
  }

  if (!result.frontendFolder && frontendDirs.length) result.frontendFolder = frontendDirs[0];
  if (!result.backendFolder && backendDirs.length) result.backendFolder = backendDirs[0];

  if (!result.frontendCommand) {
    const frontendRoot = result.frontendFolder ? path.join(root, result.frontendFolder) : root;
    result.frontendCommand = getRunCommand(frontendRoot, 'frontend');
  }
  if (!result.backendCommand) {
    const backendRoot = result.backendFolder ? path.join(root, result.backendFolder) : root;
    result.backendCommand = getRunCommand(backendRoot, 'backend');
  }
  if (!result.rootCommand) result.rootCommand = getRunCommand(root, 'root');

  if (!result.staticPort) result.staticPort = envPorts.PORT || 4100;
  if (!result.frontendPort) result.frontendPort = envPorts.FRONTEND_PORT || envPorts.VITE_PORT || (isFrontend ? 5173 : '');
  if (!result.backendPort) result.backendPort = envPorts.API_PORT || envPorts.SERVER_PORT || envPorts.BACKEND_PORT || envPorts.PORT || (isBackend ? 5000 : '');
  if (!result.proxyPort) result.proxyPort = 9100 + projects.length + 1;

  return result;
}

function getLANAddresses() {
  const entries = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const lower = name.toLowerCase();
      const virtual = /vmware|virtualbox|vbox|hyper-v|loopback|wsl|docker|tailscale|npcap/.test(lower);
      entries.push({ name, address: item.address, virtual, primary: false });
    }
  }
  entries.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  if (entries[0]) entries[0].primary = true;
  return entries;
}

function getBestLANIP() {
  return getLANAddresses()[0]?.address || '127.0.0.1';
}

function checkPort(port, host = '127.0.0.1', timeout = 1000) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = net.createConnection({ host, port: Number(port) });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function findFreePort(start = 9101) {
  let port = Number(start) || 9101;
  while (port < 65000) {
    const busy = await checkPort(port);
    if (!busy) return port;
    port += 1;
  }
  throw new Error('No free port found.');
}

function spawnCommand(command, cwd, projectId, label, extraEnv = {}) {
  if (!command) throw new Error(`${label} command missing.`);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`${label} folder not found: ${cwd}`);

  appendLog(projectId, `${label}: ${command}`);
  const child = spawn(command, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      HOST: process.env.HOST || '0.0.0.0',
      ...extraEnv
    },
    windowsHide: true
  });

  const runtime = ensureRuntime(projectId);
  runtime.processes.push({ label, child, cwd, command, startedAt: new Date().toISOString() });

  child.stdout.on('data', (data) => handleProcessOutput(projectId, label, data.toString()));
  child.stderr.on('data', (data) => handleProcessOutput(projectId, label, data.toString()));
  child.on('error', (error) => appendLog(projectId, `${label} error: ${error.message}`));
  child.on('exit', (code) => {
    appendLog(projectId, `${label} exited with code ${code}`);
  });
  return child;
}

function handleProcessOutput(projectId, label, text) {
  appendLog(projectId, `[${label}] ${text}`);
  const runtime = ensureRuntime(projectId);
  const ports = detectAllPortsFromText(text);
  for (const port of ports) runtime.detectedPorts.add(port);

  const project = getProject(projectId);
  if (!project) return;
  const firstPort = ports[0];
  if (firstPort) {
    if (label.toLowerCase().includes('front')) {
      runtime.frontendPort = firstPort;
      runtime.frontendTarget = `http://localhost:${firstPort}`;
    } else if (label.toLowerCase().includes('back') || label.toLowerCase().includes('api') || project.type === 'api') {
      runtime.backendPort = firstPort;
      runtime.backendTarget = `http://localhost:${firstPort}`;
    } else if (!runtime.port) {
      runtime.port = firstPort;
      runtime.localTarget = `http://localhost:${firstPort}`;
    }
  }
}

function ensureRuntime(projectId) {
  if (!runtimes.has(projectId)) {
    runtimes.set(projectId, {
      projectId,
      status: 'STARTING',
      processes: [],
      staticServer: null,
      proxyServer: null,
      detectedPorts: new Set(),
      startedAt: new Date().toISOString(),
      port: null,
      localTarget: null,
      frontendPort: null,
      frontendTarget: null,
      backendPort: null,
      backendTarget: null,
      proxyPort: null,
      proxyTarget: null
    });
  }
  return runtimes.get(projectId);
}

function killChildProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || !child.pid) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(resolve, 250);
    }
  });
}

async function stopProjectRuntime(projectId, stopTunnel = false) {
  const project = getProject(projectId);
  const runtime = runtimes.get(projectId);
  if (stopTunnel) await stopTunnelForProject(projectId);

  if (!runtime) {
    appendLog(projectId, 'No runtime to stop.');
    return;
  }

  if (runtime.staticServer) {
    await new Promise((resolve) => runtime.staticServer.close(() => resolve()));
    appendLog(projectId, 'Static server stopped.');
  }
  if (runtime.proxyServer) {
    await new Promise((resolve) => runtime.proxyServer.close(() => resolve()));
    appendLog(projectId, 'Proxy server stopped.');
  }
  for (const item of runtime.processes || []) {
    await killChildProcess(item.child);
    appendLog(projectId, `${item.label} stopped.`);
  }
  runtimes.delete(projectId);
  if (project) appendLog(projectId, `Runtime stopped: ${project.name}`);
}

function startStaticServer(project) {
  return new Promise(async (resolve, reject) => {
    const root = resolveProjectPath(project);
    if (!root || !fs.existsSync(root)) return reject(new Error('Static root path not found.'));
    const runtime = ensureRuntime(project.id);
    const port = Number(project.staticPort || project.frontendPort || project.backendPort || project.proxyPort || 4100);
    const staticApp = express();
    staticApp.use(express.static(root));
    staticApp.use((req, res) => {
      const indexPath = path.join(root, 'index.html');
      if (fs.existsSync(indexPath)) res.sendFile(indexPath);
      else res.status(404).send('index.html not found');
    });
    const server = http.createServer(staticApp);
    server.on('error', (error) => reject(error));
    server.listen(port, '0.0.0.0', () => {
      runtime.staticServer = server;
      runtime.status = 'RUNNING';
      runtime.port = port;
      runtime.localTarget = `http://localhost:${port}`;
      appendLog(project.id, `Static project running on http://localhost:${port}`);
      resolve(runtime);
    });
  });
}

async function startCommandBasedProject(project) {
  const runtime = ensureRuntime(project.id);
  runtime.status = 'STARTING';

  const type = project.type;
  if (type === 'frontend') {
    const cwd = resolveProjectPath(project, project.frontendFolder);
    const cmd = project.frontendCommand || project.rootCommand || getRunCommand(cwd, 'frontend');
    spawnCommand(cmd, cwd, project.id, 'frontend');
    const port = await waitForDetectedOrConfiguredPort(project.id, [project.frontendPort, 5173, 3000, 8080]);
    runtime.frontendPort = port;
    runtime.port = port;
    runtime.frontendTarget = `http://localhost:${port}`;
    runtime.localTarget = runtime.frontendTarget;
    runtime.status = 'RUNNING';
    appendLog(project.id, `Frontend runtime ready on http://localhost:${port}`);
    return runtime;
  }

  if (type === 'api' || type === 'server' || type === 'fullstack-root') {
    const cwd = resolveProjectPath(project, project.backendFolder);
    const cmd = project.backendCommand || project.rootCommand || getRunCommand(cwd, 'backend');
    spawnCommand(cmd, cwd, project.id, 'backend/API');
    const port = await waitForDetectedOrConfiguredPort(project.id, [project.backendPort, project.staticPort, 5000, 3001, 4000, 7000, 8000, 8080]);
    runtime.backendPort = port;
    runtime.port = port;
    runtime.backendTarget = `http://localhost:${port}`;
    runtime.localTarget = runtime.backendTarget;
    runtime.status = 'RUNNING';
    appendLog(project.id, `Backend/API runtime ready on http://localhost:${port}`);
    return runtime;
  }

  return runtime;
}

async function waitForDetectedOrConfiguredPort(projectId, candidates = [], timeoutMs = 12000) {
  const started = Date.now();
  const runtime = ensureRuntime(projectId);

  while (Date.now() - started < timeoutMs) {
    const possible = new Set();
    for (const c of candidates) if (Number(c)) possible.add(Number(c));
    for (const p of runtime.detectedPorts) possible.add(Number(p));
    for (const port of possible) {
      if (await checkPort(port)) return port;
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  const fallback = [...runtime.detectedPorts][0] || candidates.find((c) => Number(c));
  if (fallback) {
    appendLog(projectId, `Port ${fallback} was selected but reachability is not confirmed yet.`);
    return Number(fallback);
  }
  appendLog(projectId, 'Port not detected yet. Runtime is still being watched.');
  return null;
}

async function startFullStackProject(project) {
  const runtime = ensureRuntime(project.id);
  runtime.status = 'STARTING';

  const root = resolveProjectPath(project);
  const frontendCwd = project.frontendFolder ? resolveProjectPath(project, project.frontendFolder) : root;
  const backendCwd = project.backendFolder ? resolveProjectPath(project, project.backendFolder) : root;

  const frontendCmd = project.frontendCommand || getRunCommand(frontendCwd, 'frontend');
  const backendCmd = project.backendCommand || getRunCommand(backendCwd, 'backend');

  if (project.backendFolder || backendCmd !== frontendCmd) {
    spawnCommand(backendCmd, backendCwd, project.id, 'backend');
  }
  if (project.frontendFolder || frontendCmd !== backendCmd) {
    spawnCommand(frontendCmd, frontendCwd, project.id, 'frontend');
  } else if (!runtime.processes.length) {
    spawnCommand(project.rootCommand || frontendCmd || backendCmd, root, project.id, 'root-dev');
  }

  const backendPort = await waitForDetectedOrConfiguredPort(project.id, [project.backendPort, 5000, 3001, 4000, 7000, 8000], 15000);
  const frontendPort = await waitForDetectedOrConfiguredPort(project.id, [project.frontendPort, 5173, 3000, 8080], 15000);

  runtime.backendPort = backendPort;
  runtime.frontendPort = frontendPort;
  runtime.backendTarget = backendPort ? `http://localhost:${backendPort}` : null;
  runtime.frontendTarget = frontendPort ? `http://localhost:${frontendPort}` : null;

  if (!frontendPort && backendPort) {
    runtime.port = backendPort;
    runtime.localTarget = `http://localhost:${backendPort}`;
    runtime.status = 'RUNNING';
    appendLog(project.id, `Only backend was detected on http://localhost:${backendPort}`);
    return runtime;
  }

  if (frontendPort && backendPort) {
    await startProxyServer(project, frontendPort, backendPort);
    runtime.status = 'RUNNING';
    return runtime;
  }

  if (frontendPort) {
    runtime.port = frontendPort;
    runtime.localTarget = `http://localhost:${frontendPort}`;
    runtime.status = 'RUNNING';
    appendLog(project.id, `Frontend detected on http://localhost:${frontendPort}`);
    return runtime;
  }

  runtime.status = 'STARTING';
  appendLog(project.id, 'Full-stack ports not detected yet. Check logs and project commands.');
  return runtime;
}

async function startProxyServer(project, frontendPort, backendPort) {
  const runtime = ensureRuntime(project.id);
  const proxyPort = Number(project.proxyPort) || await findFreePort(9101);
  const apiPrefix = project.apiPrefix || '/api';
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const isApi = url.startsWith(apiPrefix) || url.startsWith('/socket.io') || url.startsWith('/ws') || url.startsWith('/graphql');
    const target = isApi ? `http://localhost:${backendPort}` : `http://localhost:${frontendPort}`;

    if (isApi && project.stripApiPrefix && url.startsWith(apiPrefix)) {
      req.url = url.slice(apiPrefix.length) || '/';
    }

    proxy.web(req, res, { target }, (error) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${error.message}`);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    proxy.ws(req, socket, head, { target: `http://localhost:${backendPort}` });
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(proxyPort, '0.0.0.0', resolve);
  });

  runtime.proxyServer = server;
  runtime.proxyPort = proxyPort;
  runtime.port = proxyPort;
  runtime.proxyTarget = `http://localhost:${proxyPort}`;
  runtime.localTarget = runtime.proxyTarget;
  appendLog(project.id, `Proxy running on http://localhost:${proxyPort}`);
  appendLog(project.id, `/ -> http://localhost:${frontendPort}`);
  appendLog(project.id, `${apiPrefix} -> http://localhost:${backendPort}`);
}

async function startProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found.');
  await stopProjectRuntime(projectId, false).catch(() => {});

  appendLog(projectId, `Starting project: ${project.name}`);
  let effective = project;
  if (project.type === 'auto') {
    effective = normalizeProject({ ...project, ...detectProjectConfig(project) });
    Object.assign(project, effective, { updatedAt: new Date().toISOString() });
    saveProjects();
    appendLog(projectId, `Auto detected type: ${project.type}`);
  }

  if (project.type === 'static') return startStaticServer(project);
  if (project.type === 'fullstack') return startFullStackProject(project);
  if (project.type === 'fullstack-root') return startFullStackProject(project);
  return startCommandBasedProject(project);
}

function getTunnelTargetPort(project) {
  const runtime = runtimes.get(project.id);
  if (runtime?.proxyPort) return runtime.proxyPort;
  if (runtime?.port) return runtime.port;
  const type = project.type;
  if (type === 'fullstack' || type === 'fullstack-root') return project.proxyPort || runtime?.proxyPort || project.staticPort;
  if (type === 'static') return project.staticPort || runtime?.port;
  if (type === 'frontend') return project.frontendPort || runtime?.frontendPort || runtime?.port || project.staticPort;
  if (type === 'api' || type === 'server') return project.backendPort || runtime?.backendPort || runtime?.port || project.staticPort;
  return project.staticPort || project.frontendPort || project.backendPort || runtime?.backendPort || runtime?.frontendPort || runtime?.port;
}

function getTargetPort(project, runtime) {
  if (runtime?.proxyPort) return runtime.proxyPort;
  if (runtime?.port) return runtime.port;
  if (runtime?.backendPort && runtime?.frontendPort) return runtime.proxyPort || runtime.frontendPort;
  if (runtime?.backendPort) return runtime.backendPort;
  if (runtime?.frontendPort) return runtime.frontendPort;
  const type = project.type;
  if (type === 'fullstack' || type === 'fullstack-root') return project.proxyPort || project.staticPort;
  if (type === 'frontend') return project.frontendPort || project.staticPort;
  if (type === 'api' || type === 'server') return project.backendPort || project.staticPort;
  if (type === 'static') return project.staticPort;
  return project.staticPort || project.frontendPort || project.backendPort;
}

function spawnTunnel(provider, port, projectId) {
  const normalized = provider || 'localtunnel';
  let command;
  if (normalized === 'ngrok') {
    command = `ngrok http ${port} --log=stdout`;
  } else if (normalized === 'cloudflared') {
    command = `cloudflared tunnel --url http://localhost:${port}`;
  } else {
    command = `npx --yes localtunnel --port ${port}`;
  }

  appendLog(projectId, `Tunnel target: http://localhost:${port}`);
  appendLog(projectId, `Tunnel command: ${command}`);

  const child = spawn(command, { shell: true, windowsHide: true, env: process.env });
  const tunnel = { projectId, provider: normalized, port, child, publicUrl: '', status: 'STARTING', startedAt: new Date().toISOString() };
  tunnels.set(projectId, tunnel);

  const parse = (text) => {
    appendLog(projectId, `[tunnel] ${text}`);
    const urlMatch = String(text).match(/https:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
      tunnel.publicUrl = urlMatch[0].replace(/[),.]+$/, '');
      tunnel.status = 'ACTIVE';
      appendLog(projectId, `Public URL ready: ${tunnel.publicUrl}`);
    }
  };

  child.stdout.on('data', (data) => parse(data.toString()));
  child.stderr.on('data', (data) => parse(data.toString()));
  child.on('error', (error) => {
    tunnel.status = 'ERROR';
    appendLog(projectId, `Tunnel error: ${error.message}`);
  });
  child.on('exit', (code) => {
    appendLog(projectId, `Tunnel exited with code ${code}`);
    if (tunnels.get(projectId) === tunnel) tunnels.delete(projectId);
  });
  return tunnel;
}

async function startTunnelForProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found.');
  if (!runtimes.has(projectId)) await startProject(projectId);
  const port = getTunnelTargetPort(project);
  if (!port) throw new Error('No target port detected. Start the project first or set a port.');
  await stopTunnelForProject(projectId).catch(() => {});
  return spawnTunnel(project.provider, port, projectId);
}

async function stopTunnelForProject(projectId) {
  const tunnel = tunnels.get(projectId);
  if (!tunnel) return;
  await killChildProcess(tunnel.child);
  tunnels.delete(projectId);
  appendLog(projectId, 'Tunnel stopped.');
}

function providerCheckCommand(provider) {
  if (process.platform === 'win32') return ['where', [provider]];
  return ['which', [provider]];
}

function checkCommandAvailable(provider) {
  return new Promise((resolve) => {
    const [cmd, args] = providerCheckCommand(provider);
    const child = spawn(cmd, args, { shell: true, windowsHide: true });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function decorateProject(project) {
  const runtime = runtimes.get(project.id);
  const tunnel = tunnels.get(project.id);
  const lanIP = getBestLANIP();
  const status = runtime?.status || 'STOPPED';
  const running = Boolean(runtime && status !== 'STOPPED');
  const port = getTargetPort(project, runtime);
  const localTarget = port ? `http://localhost:${port}` : '';
  const lanTarget = port ? `http://${lanIP}:${port}` : '';

  return {
    ...project,
    status,
    running,
    localTarget,
    lanTarget,
    runtimePort: port || '',
    frontendTarget: runtime?.frontendTarget || (project.frontendPort ? `http://localhost:${project.frontendPort}` : ''),
    backendTarget: runtime?.backendTarget || (project.backendPort ? `http://localhost:${project.backendPort}` : ''),
    proxyTarget: runtime?.proxyTarget || (project.proxyPort && (project.type === 'fullstack' || project.type === 'fullstack-root') ? `http://localhost:${project.proxyPort}` : ''),
    publicUrl: tunnel?.publicUrl || '',
    tunnelStatus: tunnel?.status || 'STOPPED',
    detectedPorts: runtime ? [...runtime.detectedPorts] : []
  };
}

function getActiveCounts() {
  const runningProjectIds = new Set();
  for (const [id, runtime] of runtimes.entries()) {
    if (runtime && runtime.status !== 'STOPPED') runningProjectIds.add(id);
  }
  const activeTunnelIds = new Set();
  for (const [id, tunnel] of tunnels.entries()) {
    if (tunnel && tunnel.status !== 'STOPPED') activeTunnelIds.add(id);
  }
  return { runtimes: runningProjectIds.size, tunnels: activeTunnelIds.size };
}

app.get('/api/state', async (req, res) => {
  const ngrokReady = await checkCommandAvailable('ngrok');
  const cloudflaredReady = await checkCommandAvailable('cloudflared');
  res.json({
    tool: { port: APP_PORT, url: `http://localhost:${APP_PORT}`, host: os.hostname(), node: process.version },
    network: { bestIP: getBestLANIP(), adapters: getLANAddresses() },
    providers: {
      localtunnel: true,
      ngrok: ngrokReady,
      cloudflared: cloudflaredReady
    },
    counts: getActiveCounts(),
    projects: projects.map(decorateProject)
  });
});

app.get('/api/projects', (req, res) => res.json(projects.map(decorateProject)));

app.post('/api/projects', (req, res) => {
  const project = normalizeProject(req.body);
  if (!project.id) project.id = slugify(project.name);
  if (projects.some((p) => p.id === project.id)) project.id = `${project.id}-${Date.now()}`;
  projects.push(project);
  saveProjects();
  appendLog(project.id, `Project registered: ${project.name}`);
  res.json(decorateProject(project));
});

app.put('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  Object.assign(project, normalizeProject({ ...project, ...req.body, id: project.id }), { updatedAt: new Date().toISOString() });
  saveProjects();
  appendLog(project.id, `Project updated: ${project.name}`);
  res.json(decorateProject(project));
});

app.delete('/api/projects/:id', async (req, res) => {
  const id = req.params.id;
  await stopProjectRuntime(id, true).catch(() => {});
  projects = projects.filter((p) => p.id !== id);
  saveProjects();
  logs.delete(id);
  res.json({ success: true });
});

app.post('/api/projects/:id/detect', (req, res) => {
  const project = getProject(req.params.id) || normalizeProject({ ...req.body, id: req.params.id });
  const detected = detectProjectConfig({ ...project, ...req.body });
  appendLog(project.id, `Auto detect completed for ${detected.name}. Type: ${detected.type}`);
  res.json(detected);
});

app.post('/api/projects/:id/start', async (req, res) => {
  try {
    const runtime = await startProject(req.params.id);
    res.json({ success: true, runtime: { ...runtime, detectedPorts: [...runtime.detectedPorts] }, project: decorateProject(getProject(req.params.id)) });
  } catch (error) {
    appendLog(req.params.id, `Start error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:id/stop', async (req, res) => {
  try {
    await stopProjectRuntime(req.params.id, false);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:id/restart', async (req, res) => {
  try {
    await stopProjectRuntime(req.params.id, false);
    const runtime = await startProject(req.params.id);
    res.json({ success: true, runtime: { ...runtime, detectedPorts: [...runtime.detectedPorts] }, project: decorateProject(getProject(req.params.id)) });
  } catch (error) {
    appendLog(req.params.id, `Restart error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:id/tunnel/start', async (req, res) => {
  try {
    const tunnel = await startTunnelForProject(req.params.id);
    res.json({ success: true, tunnel: { ...tunnel, child: undefined } });
  } catch (error) {
    appendLog(req.params.id, `Tunnel start error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:id/tunnel/stop', async (req, res) => {
  try {
    await stopTunnelForProject(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id/logs', (req, res) => {
  res.json({ logs: logs.get(req.params.id) || [] });
});

app.delete('/api/projects/:id/logs', (req, res) => {
  logs.set(req.params.id, ['[logs cleared]']);
  res.json({ success: true });
});

app.post('/api/start-all', async (req, res) => {
  const results = [];
  for (const project of projects) {
    try {
      await startProject(project.id);
      results.push({ id: project.id, success: true });
    } catch (error) {
      results.push({ id: project.id, success: false, error: error.message });
    }
  }
  res.json({ results });
});

app.post('/api/stop-all', async (req, res) => {
  for (const project of projects) await stopProjectRuntime(project.id, true).catch(() => {});
  res.json({ success: true });
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(APP_PORT, '127.0.0.1', () => {
  console.log(`LocalBridge Studio running on http://localhost:${APP_PORT}`);
});

function shutdown() {
  Promise.all(projects.map((p) => stopProjectRuntime(p.id, true).catch(() => {}))).finally(() => {
    server.close(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
