const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const pty = require('node-pty');
const fs = require('fs');

let mainWindow = null;
const shells = new Map();
const HOME = process.env.HOME || '/';

// ─── Fix PATH (macOS launches from Dock/Spotlight without full shell PATH) ──

function fixElectronPath() {
    // Inherit user's shell PATH so npx, node, nvm all resolve correctly
    const shellPaths = [
        path.join(HOME, '.nvm/versions/node'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        path.join(HOME, '.local/bin'),
        path.join(HOME, '.cargo/bin'),
    ];

    // Find the actual current node version path from nvm if available
    try {
        const nvmDir = path.join(HOME, '.nvm/versions/node');
        if (fs.existsSync(nvmDir)) {
            const versions = fs.readdirSync(nvmDir).sort().reverse();
            if (versions.length > 0) {
                shellPaths.unshift(path.join(nvmDir, versions[0], 'bin'));
            }
        }
    } catch { }

    const currentPath = process.env.PATH || '';
    const missing = shellPaths.filter(p => !currentPath.includes(p) && fs.existsSync(p));
    if (missing.length > 0) {
        process.env.PATH = [...missing, currentPath].join(':');
    }
}
fixElectronPath();

// ─── Tasks File (Shared Store) ──────────────────────────────────────────────

const KAIZEN_DIR = path.join(HOME, '.kaizen-term');
const TASKS_FILE = path.join(KAIZEN_DIR, 'tasks.json');
const PIDS_FILE = path.join(KAIZEN_DIR, 'pids.json');
const SESSION_LOG = path.join(KAIZEN_DIR, 'session.log');
const BUFFERS_DIR = path.join(KAIZEN_DIR, 'terminal-buffers');
let tasksWatcher = null;

// ─── Terminal Output Ring Buffers ────────────────────────────────────────────

const RING_BUFFER_MAX_LINES = 200;
const terminalBuffers = new Map(); // id → string[]
let bufferFlushInterval = null;

function appendToBuffer(id, rawData) {
    if (!terminalBuffers.has(id)) terminalBuffers.set(id, []);
    const buf = terminalBuffers.get(id);
    // Strip ANSI escape codes for clean log
    const clean = rawData.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
    const lines = clean.split('\n');
    for (const line of lines) {
        if (line.trim()) buf.push(line);
    }
    // Trim to max
    while (buf.length > RING_BUFFER_MAX_LINES) buf.shift();
}

function flushBuffersToDisk() {
    try {
        if (!fs.existsSync(BUFFERS_DIR)) fs.mkdirSync(BUFFERS_DIR, { recursive: true });
        for (const [id, lines] of terminalBuffers) {
            fs.writeFileSync(path.join(BUFFERS_DIR, `${id}.log`), lines.join('\n'));
        }
    } catch { }
}

function startBufferFlush() {
    if (bufferFlushInterval) return;
    bufferFlushInterval = setInterval(flushBuffersToDisk, 2000);
}

function stopBufferFlush() {
    if (bufferFlushInterval) { clearInterval(bufferFlushInterval); bufferFlushInterval = null; }
    flushBuffersToDisk(); // Final flush
}

// ─── Session Log (Agent Telemetry) ──────────────────────────────────────────

function appendSessionLog(event) {
    try {
        ensureKaizenDir();
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${event}\n`;
        fs.appendFileSync(SESSION_LOG, line);

        // Rotate if too large (> 10k lines)
        try {
            const content = fs.readFileSync(SESSION_LOG, 'utf-8');
            const lines = content.split('\n');
            if (lines.length > 10000) {
                fs.writeFileSync(SESSION_LOG, lines.slice(-5000).join('\n'));
            }
        } catch { }
    } catch { }
}

function ensureKaizenDir() {
    if (!fs.existsSync(KAIZEN_DIR)) fs.mkdirSync(KAIZEN_DIR, { recursive: true });
}

function loadTasks() {
    ensureKaizenDir();
    if (!fs.existsSync(TASKS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
    } catch (err) {
        sendError(`Failed to parse tasks file: ${err.message}`);
        return [];
    }
}

function saveTasks(tasks) {
    ensureKaizenDir();
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function watchTasksFile() {
    ensureKaizenDir();
    // Touch the file if it doesn't exist
    if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]');

    let debounceTimer = null;
    try {
        tasksWatcher = fs.watch(TASKS_FILE, { persistent: false }, () => {
            // Debounce: coalesce rapid fs events (atomic renames, multi-writes)
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    const tasks = loadTasks();
                    mainWindow.webContents.send('tasks:updated', tasks);
                }
            }, 150);
        });
    } catch (err) {
        sendError(`Failed to watch tasks file: ${err.message}`);
    }
}

// ─── Error Channel ──────────────────────────────────────────────────────────

function sendError(message) {
    console.error(`[KaizenTerm] ${message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:error', message);
    }
}

// ─── Zombie Process Cleanup ─────────────────────────────────────────────────

function writePidLock() {
    ensureKaizenDir();
    const pids = Array.from(shells.entries()).map(([id, term]) => ({
        id,
        pid: term.pid,
        timestamp: Date.now(),
    }));
    try {
        fs.writeFileSync(PIDS_FILE, JSON.stringify(pids, null, 2));
    } catch { }
}

function cleanupOrphanedProcesses() {
    if (!fs.existsSync(PIDS_FILE)) return;
    try {
        const pids = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf-8'));
        for (const entry of pids) {
            try {
                // Check if process still exists (signal 0 = check only)
                process.kill(entry.pid, 0);
                // Process still running — kill it
                console.log(`[KaizenTerm] Killing orphaned process PID=${entry.pid} (${entry.id})`);
                process.kill(entry.pid, 'SIGTERM');
                setTimeout(() => {
                    try { process.kill(entry.pid, 'SIGKILL'); } catch { }
                }, 2000);
            } catch {
                // Process already dead — no action needed
            }
        }
        fs.unlinkSync(PIDS_FILE);
    } catch (err) {
        console.error(`[KaizenTerm] Failed to cleanup orphans: ${err.message}`);
    }
}

function cleanPidLock() {
    try { if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE); } catch { }
}

// ─── IPC Security: Path Validation ──────────────────────────────────────────

const ALLOWED_ROOTS = new Set([
    HOME,
    path.join(HOME, 'Documents'),
    path.join(HOME, '.mcp.json'),
    path.join(HOME, '.kaizen-term'),
    path.join(HOME, '.cursor'),
    path.join(HOME, '.vscode'),
    path.join(HOME, '.agents'),
    path.join(HOME, '.agent'),
    '/tmp',
]);

function isPathAllowed(targetPath) {
    const resolved = path.resolve(targetPath);
    // Block path traversal
    if (resolved.includes('..')) return false;
    // Check against allowed roots
    for (const root of ALLOWED_ROOTS) {
        if (resolved.startsWith(root)) return true;
    }
    return false;
}

// ─── Window Creation ─────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'KaizenTerm',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 12, y: 16 },
        backgroundColor: '#07070d',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        shells.forEach((term) => { try { term.kill(); } catch { } });
        shells.clear();
        if (tasksWatcher) { tasksWatcher.close(); tasksWatcher = null; }
    });

    watchTasksFile();
}

// ─── IPC: Terminal ───────────────────────────────────────────────────────────

// Get active task context for agent environment injection
function getActiveTaskEnv() {
    const tasks = loadTasks();
    const activeTasks = tasks.filter(t => t.status === 'doing');
    const env = {};

    if (activeTasks.length > 0) {
        env.KAIZEN_ACTIVE_TASK = activeTasks.map(t =>
            `${t.id}: ${t.title}${t.jiraKey ? ` [${t.jiraKey}]` : ''}`
        ).join(' | ');
        env.KAIZEN_ACTIVE_TASK_IDS = activeTasks.map(t => t.id).join(',');
    }

    env.KAIZEN_TASK_COUNT = String(tasks.length);
    env.KAIZEN_MCP_SOCKET = 'stdio';
    return env;
}

ipcMain.handle('pty:spawn', (event, { id, cols, rows, cwd, timerState }) => {
    const shellPath = process.env.SHELL || '/bin/zsh';
    const workDir = cwd && fs.existsSync(cwd) ? cwd : (HOME);

    try {
        const taskEnv = getActiveTaskEnv();

        const term = pty.spawn(shellPath, [], {
            name: 'xterm-256color',
            cols: cols || 80,
            rows: rows || 24,
            cwd: workDir,
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
                ...taskEnv,
                KAIZEN_TIMER_STATE: timerState || 'unknown',
            },
        });

        shells.set(id, term);
        writePidLock();
        startBufferFlush();
        appendSessionLog(`SPAWN ${id} PID=${term.pid} CWD=${workDir}`);

        term.onData((data) => {
            // Capture output to ring buffer
            appendToBuffer(id, data);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('pty:data', { id, data });
            }
        });

        term.onExit(({ exitCode }) => {
            shells.delete(id);
            writePidLock();
            appendSessionLog(`EXIT ${id} CODE=${exitCode}`);
            // Flush buffer one last time before cleanup
            flushBuffersToDisk();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('pty:exit', { id, exitCode });
            }
        });

        return { pid: term.pid };
    } catch (err) {
        sendError(`Failed to spawn shell for ${id}: ${err.message}`);
        appendSessionLog(`SPAWN_FAIL ${id} ERROR=${err.message}`);
        return { error: err.message };
    }
});

ipcMain.on('pty:write', (event, { id, data }) => {
    const term = shells.get(id);
    if (term) term.write(data);
});

ipcMain.on('pty:resize', (event, { id, cols, rows }) => {
    const term = shells.get(id);
    if (term) {
        try { term.resize(cols, rows); } catch { }
    }
});

ipcMain.on('pty:kill', (event, { id }) => {
    const term = shells.get(id);
    if (term) {
        term.kill();
        shells.delete(id);
        writePidLock();
        appendSessionLog(`KILL ${id}`);
    }
});

// Read terminal output ring buffer
ipcMain.handle('pty:readOutput', (event, id) => {
    const buf = terminalBuffers.get(id);
    if (!buf) return { lines: [], count: 0 };
    return { lines: buf, count: buf.length };
});

// ─── IPC: Tasks (Shared with MCP Server) ────────────────────────────────────

ipcMain.handle('tasks:load', () => {
    return loadTasks();
});

ipcMain.handle('tasks:save', (event, tasks) => {
    saveTasks(tasks);
    return { ok: true };
});

ipcMain.handle('tasks:add', (event, task) => {
    const tasks = loadTasks();
    tasks.push(task);
    saveTasks(tasks);
    return { ok: true };
});

ipcMain.handle('tasks:update', (event, { id, updates }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) return { error: 'Task not found' };
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    saveTasks(tasks);
    appendSessionLog(`TASK_UPDATE ${id} ${JSON.stringify(updates)}`);
    return { ok: true };
});

ipcMain.handle('tasks:delete', (event, id) => {
    let tasks = loadTasks();
    tasks = tasks.filter(t => t.id !== id);
    saveTasks(tasks);
    return { ok: true };
});

// ─── IPC: MCP / Skills Discovery ────────────────────────────────────────────

function getGlobalPaths(extraPaths) {
    const all = new Set([
        HOME,
        path.join(HOME, 'Documents'),
        ...extraPaths,
    ]);
    return [...all];
}

function discoverSkills(basePaths) {
    const skills = [];
    const workflows = [];
    const skillDirs = ['.agents', '.agent', '_agents', '_agent'];
    const paths = getGlobalPaths(basePaths);

    for (const base of paths) {
        for (const dir of skillDirs) {
            const skillsPath = path.resolve(base, dir, 'skills');
            if (fs.existsSync(skillsPath)) {
                try {
                    const entries = fs.readdirSync(skillsPath, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const skillMd = path.resolve(skillsPath, entry.name, 'SKILL.md');
                            if (fs.existsSync(skillMd)) {
                                const content = fs.readFileSync(skillMd, 'utf-8');
                                const nameMatch = content.match(/name:\s*(.+)/);
                                const descMatch = content.match(/description:\s*(.+)/);
                                skills.push({
                                    name: nameMatch?.[1]?.trim() || entry.name,
                                    description: descMatch?.[1]?.trim() || 'No description',
                                    path: skillMd,
                                    source: base,
                                });
                            }
                        }
                    }
                } catch (err) {
                    sendError(`Skills scan error in ${skillsPath}: ${err.message}`);
                }
            }

            const workflowsPath = path.resolve(base, dir, 'workflows');
            if (fs.existsSync(workflowsPath)) {
                try {
                    const entries = fs.readdirSync(workflowsPath, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isFile() && entry.name.endsWith('.md')) {
                            const content = fs.readFileSync(path.resolve(workflowsPath, entry.name), 'utf-8');
                            const descMatch = content.match(/description:\s*(.+)/);
                            const nameMatch = content.match(/name:\s*(.+)/);
                            workflows.push({
                                name: nameMatch?.[1]?.trim() || entry.name.replace('.md', ''),
                                description: descMatch?.[1]?.trim() || 'Workflow',
                                path: path.resolve(workflowsPath, entry.name),
                                source: base,
                            });
                        }
                    }
                } catch (err) {
                    sendError(`Workflows scan error in ${workflowsPath}: ${err.message}`);
                }
            }
        }
    }
    return { skills, workflows };
}

function discoverMCPResources(basePaths) {
    const servers = [];
    const paths = getGlobalPaths(basePaths);

    const globalConfigs = [
        path.join(HOME, '.mcp.json'),
        path.join(HOME, '.mcp', 'configs.json'),
        path.join(HOME, '.cursor', 'mcp.json'),
        path.join(HOME, '.vscode', 'mcp.json'),
    ];

    const projectConfigs = [];
    for (const base of paths) {
        projectConfigs.push(
            path.resolve(base, '.mcp.json'),
            path.resolve(base, '.mcp', 'config.json'),
            path.resolve(base, 'mcp.json'),
        );
    }

    const allConfigs = [...new Set([...globalConfigs, ...projectConfigs])];

    for (const configPath of allConfigs) {
        if (fs.existsSync(configPath)) {
            try {
                const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                const serversObj = content.servers || content.mcpServers || {};
                for (const [name, config] of Object.entries(serversObj)) {
                    servers.push({
                        name,
                        type: 'mcp-server',
                        command: config.command || null,
                        args: config.args || [],
                        configPath,
                        source: configPath.startsWith(HOME + '/.') ? 'global' : 'project',
                    });
                }
            } catch (err) {
                sendError(`Failed to parse MCP config ${configPath}: ${err.message}`);
            }
        }
    }
    return servers;
}

ipcMain.handle('discover:skills', (event, paths) => {
    return discoverSkills(paths || []);
});

ipcMain.handle('discover:mcp', (event, paths) => {
    return discoverMCPResources(paths || []);
});

// ─── IPC: Filesystem (Secured) ──────────────────────────────────────────────

ipcMain.handle('fs:readFile', (event, filePath) => {
    if (!isPathAllowed(filePath)) {
        sendError(`Blocked file read: ${filePath} (outside allowed roots)`);
        return null;
    }
    try {
        if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        sendError(`Failed to read file ${filePath}: ${err.message}`);
    }
    return null;
});

ipcMain.handle('fs:listDir', (event, dirPath) => {
    if (!isPathAllowed(dirPath)) {
        sendError(`Blocked dir listing: ${dirPath} (outside allowed roots)`);
        return [];
    }
    try {
        if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
            return fs.readdirSync(dirPath, { withFileTypes: true }).map(e => ({
                name: e.name,
                isDir: e.isDirectory(),
            }));
        }
    } catch (err) {
        sendError(`Failed to list dir ${dirPath}: ${err.message}`);
    }
    return [];
});

// ─── IPC: Git ────────────────────────────────────────────────────────────────

ipcMain.handle('git:branch', (event, cwd) => {
    try {
        const { execSync } = require('child_process');
        const dir = cwd || HOME;
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: dir,
            encoding: 'utf8',
            timeout: 3000,
        }).trim();
        return { branch };
    } catch {
        return { branch: null };
    }
});

// ─── Auto-Setup: Ollama AI Backend ──────────────────────────────────────────

const DEFAULT_AI_MODEL = 'qwen2.5-coder:1.5b';

async function ensureOllama() {
    const { execSync, spawn } = require('child_process');

    // 1. Check if Ollama is installed
    let ollamaPath = null;
    try {
        ollamaPath = execSync('which ollama', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
        // Not found — try common macOS paths
        const commonPaths = ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'];
        for (const p of commonPaths) {
            if (fs.existsSync(p)) { ollamaPath = p; break; }
        }
    }

    if (!ollamaPath) {
        // Ollama not installed — auto-install
        console.log('[Ollama] Not installed. Attempting auto-install...');
        if (mainWindow) {
            mainWindow.webContents.send('app:error', '🤖 Installing Ollama (first run only)...');
        }

        // Try brew first (most common on macOS)
        try {
            const brewPath = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(p => fs.existsSync(p));
            if (brewPath) {
                console.log('[Ollama] Installing via Homebrew...');
                execSync(`"${brewPath}" install ollama`, { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
                // Re-check after install
                ollamaPath = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'].find(p => fs.existsSync(p)) || null;
            }
        } catch (brewErr) {
            console.log(`[Ollama] Brew install failed: ${brewErr.message}`);
        }

        // Fallback: curl installer from ollama.ai
        if (!ollamaPath) {
            try {
                console.log('[Ollama] Trying curl installer...');
                execSync('curl -fsSL https://ollama.ai/install.sh | sh', {
                    encoding: 'utf8',
                    timeout: 120000,
                    stdio: 'pipe',
                    shell: '/bin/bash',
                });
                ollamaPath = ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']
                    .find(p => fs.existsSync(p)) || null;
                if (!ollamaPath) {
                    // Check PATH again
                    try {
                        ollamaPath = execSync('which ollama', { encoding: 'utf8', timeout: 5000 }).trim();
                    } catch { /* still not found */ }
                }
            } catch (curlErr) {
                console.log(`[Ollama] Curl install failed: ${curlErr.message}`);
            }
        }

        if (!ollamaPath) {
            console.log('[Ollama] Auto-install failed. User must install manually.');
            if (mainWindow) {
                mainWindow.webContents.send('app:error', '⚠ Could not auto-install Ollama. Install manually from https://ollama.ai');
            }
            return;
        }

        console.log(`[Ollama] Installed at: ${ollamaPath}`);
        if (mainWindow) {
            mainWindow.webContents.send('app:error', '✅ Ollama installed! Setting up AI model...');
        }
    }

    console.log(`[Ollama] Found at: ${ollamaPath}`);

    // 2. Check if Ollama server is running
    let serverRunning = false;
    try {
        const http = require('http');
        await new Promise((resolve, reject) => {
            const req = http.get('http://127.0.0.1:11434/api/version', (res) => {
                serverRunning = res.statusCode === 200;
                res.resume();
                resolve();
            });
            req.on('error', () => { resolve(); });
            req.setTimeout(2000, () => { req.destroy(); resolve(); });
        });
    } catch { /* not running */ }

    if (!serverRunning) {
        console.log('[Ollama] Server not running. Starting...');
        // Start Ollama serve in background
        const ollamaServe = spawn(ollamaPath, ['serve'], {
            detached: false,
            stdio: 'ignore',
            env: { ...process.env },
        });
        ollamaServeProcess = ollamaServe;

        // Wait for server to be ready (up to 10 seconds)
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const http = require('http');
                await new Promise((resolve, reject) => {
                    const req = http.get('http://127.0.0.1:11434/api/version', (res) => {
                        if (res.statusCode === 200) serverRunning = true;
                        res.resume();
                        resolve();
                    });
                    req.on('error', () => resolve());
                    req.setTimeout(1000, () => { req.destroy(); resolve(); });
                });
                if (serverRunning) break;
            } catch { /* keep trying */ }
        }

        if (serverRunning) {
            console.log('[Ollama] Server started successfully.');
        } else {
            console.log('[Ollama] Could not start server.');
            return;
        }
    } else {
        console.log('[Ollama] Server already running.');
    }

    // 3. Check if model is available
    try {
        const models = execSync(`"${ollamaPath}" list`, { encoding: 'utf8', timeout: 10000 });
        if (models.includes('deepseek-coder-v2')) {
            console.log(`[Ollama] Model ${DEFAULT_AI_MODEL} already available.`);
            return;
        }
    } catch { /* list failed, try pulling anyway */ }

    // 4. Pull model in background
    console.log(`[Ollama] Pulling ${DEFAULT_AI_MODEL}... (this may take a few minutes)`);
    if (mainWindow) {
        mainWindow.webContents.send('app:error', `🤖 Downloading AI model (${DEFAULT_AI_MODEL})... First run only.`);
    }

    const pull = spawn(ollamaPath, ['pull', DEFAULT_AI_MODEL], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    const handlePullData = (data) => {
        // Strip ANSI escape codes
        const raw = data.toString().replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '');
        const line = raw.replace(/\r?\n/g, ' ').trim();
        if (!line || !mainWindow) return;
        console.log(`[Ollama] ${line}`);

        // Parse progress percentage
        const pctMatch = line.match(/(\d+)%/);
        const percent = pctMatch ? parseFloat(pctMatch[1]) : null;

        // Extract clean status: "pulling 29d8c98f: 18% 180MB/986MB 8.0MB/s"
        const sizeMatch = line.match(/(\d+\s*[GMKT]?B\s*\/\s*\d+\s*[GMKT]?B)/i);
        const speedMatch = line.match(/(\d+\.?\d*\s*[GMKT]?B\/s)/i);
        let status = 'Downloading AI model...';
        if (percent != null) {
            status = `Downloading: ${percent}%`;
            if (sizeMatch) status += ` (${sizeMatch[1].replace(/\s+/g, '')})`;
            if (speedMatch) status += ` ${speedMatch[1]}`;
        } else if (line.includes('pulling manifest')) {
            status = 'Pulling manifest...';
        } else if (line.includes('verifying')) {
            status = 'Verifying download...';
        }

        mainWindow.webContents.send('ollama:progress', {
            status,
            percent: percent ?? undefined,
        });
    };

    pull.stdout.on('data', handlePullData);
    pull.stderr.on('data', handlePullData);

    pull.on('close', (code) => {
        if (code === 0) {
            console.log(`[Ollama] Model ${DEFAULT_AI_MODEL} ready.`);
            if (mainWindow) {
                mainWindow.webContents.send('ollama:progress', { status: 'complete', percent: 100 });
            }
        } else {
            console.log(`[Ollama] Pull failed with code ${code}`);
            if (mainWindow) {
                mainWindow.webContents.send('app:error', `⚠ Failed to pull AI model. Run: ollama pull ${DEFAULT_AI_MODEL}`);
            }
        }
    });
}

// Track the ollama serve process so we can kill it on quit
let ollamaServeProcess = null;

// ─── App Lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
    cleanupOrphanedProcesses();
    createWindow();
    // Auto-setup Ollama (non-blocking)
    setTimeout(() => ensureOllama(), 3000);
});

app.on('window-all-closed', () => {
    shells.forEach((term) => { try { term.kill(); } catch { } });
    shells.clear();
    cleanPidLock();
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Graceful shutdown
app.on('before-quit', () => {
    appendSessionLog('APP_QUIT');
    if (ollamaServeProcess) {
        try { ollamaServeProcess.kill(); } catch { }
        ollamaServeProcess = null;
    }
    shells.forEach((term) => { try { term.kill(); } catch { } });
    shells.clear();
    cleanPidLock();
    stopBufferFlush();
    if (tasksWatcher) { tasksWatcher.close(); tasksWatcher = null; }
});
