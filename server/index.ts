import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { resolve } from 'path';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files from Vite dev or dist
const distPath = resolve(process.cwd(), 'dist');
if (existsSync(distPath)) {
    app.use(express.static(distPath));
}

// ─── MCP / Skills Discovery ──────────────────────────────────────────────────

interface SkillInfo {
    name: string;
    description: string;
    path: string;
}

interface MCPResource {
    name: string;
    type: string;
    uri: string;
}

function discoverSkills(basePaths: string[]): SkillInfo[] {
    const skills: SkillInfo[] = [];
    const skillDirs = ['.agents', '.agent', '_agents', '_agent'];

    for (const base of basePaths) {
        for (const dir of skillDirs) {
            const skillsPath = resolve(base, dir, 'skills');
            if (!existsSync(skillsPath)) continue;

            try {
                const entries = readdirSync(skillsPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const skillMd = resolve(skillsPath, entry.name, 'SKILL.md');
                        if (existsSync(skillMd)) {
                            const content = readFileSync(skillMd, 'utf-8');
                            const nameMatch = content.match(/name:\s*(.+)/);
                            const descMatch = content.match(/description:\s*(.+)/);
                            skills.push({
                                name: nameMatch?.[1]?.trim() || entry.name,
                                description: descMatch?.[1]?.trim() || 'No description',
                                path: skillMd,
                            });
                        }
                    }
                }
            } catch { /* skip */ }
        }

        // Also look for workflows
        for (const dir of skillDirs) {
            const workflowsPath = resolve(base, dir, 'workflows');
            if (!existsSync(workflowsPath)) continue;

            try {
                const entries = readdirSync(workflowsPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith('.md')) {
                        const content = readFileSync(resolve(workflowsPath, entry.name), 'utf-8');
                        const descMatch = content.match(/description:\s*(.+)/);
                        skills.push({
                            name: `workflow/${entry.name.replace('.md', '')}`,
                            description: descMatch?.[1]?.trim() || 'Workflow',
                            path: resolve(workflowsPath, entry.name),
                        });
                    }
                }
            } catch { /* skip */ }
        }
    }
    return skills;
}

function discoverMCPResources(basePaths: string[]): MCPResource[] {
    const resources: MCPResource[] = [];

    for (const base of basePaths) {
        // Look for MCP config files
        const mcpConfigs = [
            resolve(base, '.mcp.json'),
            resolve(base, '.mcp', 'config.json'),
            resolve(base, 'mcp.json'),
        ];

        for (const configPath of mcpConfigs) {
            if (existsSync(configPath)) {
                try {
                    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
                    if (content.servers) {
                        for (const [name, server] of Object.entries(content.servers)) {
                            resources.push({
                                name,
                                type: 'mcp-server',
                                uri: configPath,
                            });
                        }
                    }
                    if (content.mcpServers) {
                        for (const [name, server] of Object.entries(content.mcpServers)) {
                            resources.push({
                                name,
                                type: 'mcp-server',
                                uri: configPath,
                            });
                        }
                    }
                } catch { /* skip */ }
            }
        }

        // Also scan for common project files
        const projectFiles = ['package.json', 'tsconfig.json', '.env'];
        for (const file of projectFiles) {
            const filePath = resolve(base, file);
            if (existsSync(filePath)) {
                resources.push({
                    name: file,
                    type: 'config',
                    uri: filePath,
                });
            }
        }
    }
    return resources;
}

// ─── WebSocket Handling ──────────────────────────────────────────────────────

const shells = new Map<string, pty.IPty>();

wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw: Buffer) => {
        let msg: any;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }

        switch (msg.type) {
            case 'spawn': {
                const id = msg.id || `term-${Date.now()}`;
                const cwd = msg.cwd || process.env.HOME || '/';

                // Find a valid shell
                const shellCandidates = [
                    process.env.SHELL,
                    '/bin/zsh',
                    '/bin/bash',
                    '/bin/sh',
                ].filter(Boolean) as string[];

                let shell = shellCandidates[0];
                for (const s of shellCandidates) {
                    if (existsSync(s)) { shell = s; break; }
                }

                try {
                    const term = pty.spawn(shell, [], {
                        name: 'xterm-256color',
                        cols: msg.cols || 80,
                        rows: msg.rows || 24,
                        cwd: existsSync(cwd) ? cwd : (process.env.HOME || '/'),
                        env: {
                            ...process.env,
                            TERM: 'xterm-256color',
                            COLORTERM: 'truecolor',
                        } as { [key: string]: string },
                    });

                    shells.set(id, term);

                    term.onData((data: string) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'output', id, data }));
                        }
                    });

                    term.onExit(({ exitCode }) => {
                        shells.delete(id);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'exit', id, exitCode }));
                        }
                    });

                    ws.send(JSON.stringify({ type: 'spawned', id, pid: term.pid }));
                    console.log(`  ✓ Spawned shell (${shell}) for ${id}, PID: ${term.pid}`);
                } catch (err: any) {
                    console.error(`  ✕ Failed to spawn shell for ${id}:`, err.message);
                    ws.send(JSON.stringify({
                        type: 'output',
                        id,
                        data: `\r\n\x1b[31mError spawning shell: ${err.message}\x1b[0m\r\n\x1b[90mTried: ${shell}\x1b[0m\r\n`,
                    }));
                    ws.send(JSON.stringify({ type: 'exit', id, exitCode: 1 }));
                }
                break;
            }

            case 'input': {
                const term = shells.get(msg.id);
                if (term) {
                    term.write(msg.data);
                }
                break;
            }

            case 'resize': {
                const term = shells.get(msg.id);
                if (term && msg.cols && msg.rows) {
                    try {
                        term.resize(msg.cols, msg.rows);
                    } catch { /* ignore */ }
                }
                break;
            }

            case 'kill': {
                const term = shells.get(msg.id);
                if (term) {
                    term.kill();
                    shells.delete(msg.id);
                }
                break;
            }

            case 'discover-skills': {
                const scanPaths = msg.paths || [process.env.HOME || '/'];
                const skills = discoverSkills(scanPaths);
                ws.send(JSON.stringify({ type: 'skills', skills }));
                break;
            }

            case 'discover-mcp': {
                const scanPaths = msg.paths || [process.env.HOME || '/'];
                const resources = discoverMCPResources(scanPaths);
                ws.send(JSON.stringify({ type: 'mcp-resources', resources }));
                break;
            }

            case 'read-file': {
                try {
                    if (existsSync(msg.path)) {
                        const content = readFileSync(msg.path, 'utf-8');
                        ws.send(JSON.stringify({ type: 'file-content', path: msg.path, content }));
                    }
                } catch { /* skip */ }
                break;
            }

            case 'list-dir': {
                try {
                    if (existsSync(msg.path) && statSync(msg.path).isDirectory()) {
                        const entries = readdirSync(msg.path, { withFileTypes: true }).map(e => ({
                            name: e.name,
                            isDir: e.isDirectory(),
                        }));
                        ws.send(JSON.stringify({ type: 'dir-listing', path: msg.path, entries }));
                    }
                } catch { /* skip */ }
                break;
            }
        }
    });

    ws.on('close', () => {
        // Kill all shells associated with this connection
        // In a more robust implementation, we'd track shells per connection
    });
});

// Cleanup on exit
process.on('exit', () => {
    shells.forEach(term => { try { term.kill(); } catch { } });
});

process.on('SIGINT', () => {
    shells.forEach(term => { try { term.kill(); } catch { } });
    process.exit(0);
});

const PORT = parseInt(process.env.PORT || '3847');
server.listen(PORT, () => {
    console.log(`\n  🔲 KaizenTerm Backend`);
    console.log(`  └─ WebSocket server on ws://localhost:${PORT}`);
    console.log(`  └─ Ready for terminal connections\n`);
});
