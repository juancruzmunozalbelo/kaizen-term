// ===================================================
// KaizenTerm — Terminal Manager (Electron IPC + xterm.js)
// ===================================================

import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { ImageAddon } from '@xterm/addon-image';
import type { AgentConfig } from './state';

declare global {
    interface Window {
        kaizenBridge: {
            spawnTerminal: (opts: { id: string; cols: number; rows: number; cwd: string; timerState?: string }) => Promise<{ pid?: number; error?: string }>;
            writeTerminal: (id: string, data: string) => void;
            resizeTerminal: (id: string, cols: number, rows: number) => void;
            killTerminal: (id: string) => void;
            onTerminalData: (cb: (id: string, data: string) => void) => void;
            onTerminalExit: (cb: (id: string, exitCode: number) => void) => void;
            readTerminalOutput: (id: string) => Promise<{ lines: string[]; count: number }>;
            // Tasks (shared with MCP server)
            loadTasks: () => Promise<any[]>;
            saveTasks: (tasks: any[]) => Promise<{ ok: boolean }>;
            addTask: (task: any) => Promise<{ ok: boolean }>;
            updateTask: (id: string, updates: any) => Promise<{ ok: boolean; error?: string }>;
            deleteTask: (id: string) => Promise<{ ok: boolean }>;
            onTasksUpdated: (cb: (tasks: any[]) => void) => void;
            // Discovery
            discoverSkills: (paths: string[]) => Promise<any>;
            discoverMCP: (paths: string[]) => Promise<any>;
            // Filesystem (secured)
            readFile: (path: string) => Promise<string | null>;
            listDir: (path: string) => Promise<{ name: string; isDir: boolean }[]>;
            // Errors
            onAppError: (cb: (message: string) => void) => void;
            // Git
            gitBranch: (cwd?: string) => Promise<{ branch: string | null }>;
        };
    }
}

// Phase 8: Command block tracking
interface CommandBlock {
    command: string;
    output: string[];
    timestamp: number;
    hasError: boolean;
}

export interface TerminalInstance {
    id: string;
    agent: AgentConfig;
    terminal: Terminal;
    fitAddon: FitAddon;
    searchAddon: SearchAddon;
    element: HTMLElement;
    // Phase 8: Block tracking
    blocks: CommandBlock[];
    currentBlock: CommandBlock | null;
    lineBuffer: string;
}

export class TerminalManager {
    private terminals: Map<string, TerminalInstance> = new Map();
    private activeId: string | null = null;
    private onStatusChange?: (id: string, status: AgentConfig['status']) => void;
    private bridge = window.kaizenBridge;
    private ipcInitialized = false;

    // ANSI error pattern: red/bright-red sequences or common error keywords
    private static readonly ANSI_ERROR_RE = /\x1b\[(?:31|91|1;31)m|\b(error|Error|ERROR|FAILED|failed|exception|Exception)\b/;
    // Strip ANSI for last-line display
    private static readonly ANSI_STRIP_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
    // Amber Alert: detect prompts waiting for user input
    private static readonly INPUT_BLOCKED_RE = /\?\s*$|\[y\/N\]|\[Y\/n\]|password:|Password:|passphrase:|Enter.*:|Select.*:|Press.*continue|\(yes\/no\)/i;
    // Shell prompt detection for pseudo-blocks / agent status
    private static readonly SHELL_PROMPT_RE = /[$❯%➜#]\s*$/;
    // Agent thinking/action patterns
    private static readonly AGENT_PATTERNS: Array<{ re: RegExp; label: string; icon: string }> = [
        { re: /searching|grep|find|looking/i, label: 'Searching...', icon: '🔍' },
        { re: /thinking|analyzing|planning/i, label: 'Thinking...', icon: '🧠' },
        { re: /writing|creating|editing|modifying/i, label: 'Writing...', icon: '✏️' },
        { re: /installing|npm|pip|apt/i, label: 'Installing...', icon: '📦' },
        { re: /testing|test|jest|vitest/i, label: 'Testing...', icon: '🧪' },
        { re: /building|compiling|webpack|vite|tsc/i, label: 'Building...', icon: '🔨' },
        { re: /deploying|deploy|push/i, label: 'Deploying...', icon: '🚀' },
    ];

    constructor() {
        this.initIPC();
    }

    private initIPC() {
        if (this.ipcInitialized) return;
        this.ipcInitialized = true;

        this.bridge.onTerminalData((id: string, data: string) => {
            const inst = this.terminals.get(id);
            if (inst) {
                inst.terminal.write(data);
                // Only update status indicators for non-active panels
                this.updatePanelActivity(id, data);
                // Phase 8: Block tracking
                this.trackBlocks(inst, data);
            }
        });

        this.bridge.onTerminalExit((id: string, exitCode: number) => {
            const inst = this.terminals.get(id);
            if (inst) {
                inst.terminal.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
                this.onStatusChange?.(id, 'done');
                // Phase 6: Show restart button in panel header
                this.showRestartButton(inst, exitCode);
                // Phase 9: Dispatch exit event for auto-close pipeline
                window.dispatchEvent(new CustomEvent('kaizen-agent-exit', {
                    detail: { agentId: id, exitCode }
                }));
            }
        });
    }

    private updatePanelActivity(id: string, rawData: string) {
        const inst = this.terminals.get(id);
        if (!inst) return;
        const isActive = id === this.activeId;

        // Strip ANSI for clean last-line text
        const clean = rawData
            .replace(TerminalManager.ANSI_STRIP_RE, '')
            .replace(/\r/g, '')
            .trim();
        const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
        const lastLine = lines[lines.length - 1];

        if (lastLine) {
            const lastLineEl = inst.element.querySelector('.panel-lastline') as HTMLElement | null;
            if (lastLineEl) lastLineEl.textContent = lastLine;
        }

        // Error glow: detect ANSI red or error keywords
        if (TerminalManager.ANSI_ERROR_RE.test(rawData)) {
            inst.element.querySelector('.panel-header')?.classList.add('has-errors');
            inst.element.querySelector('.panel-dot')?.classList.add('error-pulse');
            // Fix #10: emit event so nav tabs can update in real-time
            window.dispatchEvent(new CustomEvent('kaizen-terminal-error', { detail: { id } }));
        }

        // Activity indicator for non-focused panels
        if (!isActive) {
            inst.element.querySelector('.panel-header')?.classList.add('has-activity');
        }

        // Amber Alert: detect input prompts waiting for user action
        if (lastLine && TerminalManager.INPUT_BLOCKED_RE.test(lastLine)) {
            if (!isActive) {
                inst.element.querySelector('.panel-header')?.classList.add('is-blocked');
                inst.element.querySelector('.panel-dot')?.classList.add('blocked-pulse');
                window.dispatchEvent(new CustomEvent('kaizen-terminal-blocked', { detail: { id, prompt: lastLine } }));
            }
        }

        // Phase 6: Agent status badge based on output content
        this.updateAgentBadge(inst, lastLine || clean);
    }

    private updateAgentBadge(inst: TerminalInstance, text: string) {
        let badge = inst.element.querySelector('.agent-status-badge') as HTMLElement;
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'agent-status-badge';
            const body = inst.element.querySelector('.panel-body');
            if (body) {
                (body as HTMLElement).style.position = 'relative';
                body.appendChild(badge);
            }
        }

        // Check for shell prompt (command completed)
        if (TerminalManager.SHELL_PROMPT_RE.test(text)) {
            badge.textContent = '✓ Ready';
            badge.className = 'agent-status-badge status-ready';
            return;
        }

        // Check for agent activity patterns
        for (const pattern of TerminalManager.AGENT_PATTERNS) {
            if (pattern.re.test(text)) {
                badge.textContent = `${pattern.icon} ${pattern.label}`;
                badge.className = 'agent-status-badge status-active';
                return;
            }
        }
    }

    private showRestartButton(inst: TerminalInstance, exitCode: number) {
        // Remove existing restart button
        inst.element.querySelector('.panel-restart-btn')?.remove();

        const btn = document.createElement('button');
        btn.className = 'panel-restart-btn';
        btn.textContent = exitCode === 0 ? '↻ Restart' : `↻ Restart (exit ${exitCode})`;
        btn.title = 'Restart terminal process';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.remove();
            // Re-spawn the terminal process
            const { cols, rows } = inst.terminal;
            this.bridge.spawnTerminal({
                id: inst.id,
                cols,
                rows,
                cwd: inst.agent.cwd,
            }).then((result) => {
                if (result.error) {
                    inst.terminal.write(`\r\n\x1b[31m Error: ${result.error}\x1b[0m\r\n`);
                } else {
                    inst.terminal.write(`\r\n\x1b[32m Shell restarted \x1b[0m\r\n`);
                    this.onStatusChange?.(inst.id, 'idle');
                }
            });
        });

        const actions = inst.element.querySelector('.panel-actions');
        if (actions) actions.prepend(btn);
    }

    setStatusCallback(cb: (id: string, status: AgentConfig['status']) => void) {
        this.onStatusChange = cb;
    }

    createTerminal(agent: AgentConfig, container: HTMLElement, taskContext?: { id: string; title: string } | null): TerminalInstance {
        const terminal = new Terminal({
            theme: {
                background: '#07070d',
                foreground: '#e8e8f0',
                cursor: agent.color,
                cursorAccent: '#07070d',
                selectionBackground: 'rgba(0, 229, 255, 0.2)',
                selectionForeground: '#e8e8f0',
                black: '#1a1a2e',
                red: '#ff006e',
                green: '#06d6a0',
                yellow: '#ffbe0b',
                blue: '#00e5ff',
                magenta: '#a855f7',
                cyan: '#00e5ff',
                white: '#e8e8f0',
                brightBlack: '#555577',
                brightRed: '#ff4d8e',
                brightGreen: '#39e8b8',
                brightYellow: '#ffd04b',
                brightBlue: '#4dddff',
                brightMagenta: '#c084fc',
                brightCyan: '#4dddff',
                brightWhite: '#ffffff',
            },
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 13,
            lineHeight: 1.4,
            cursorBlink: true,
            cursorStyle: 'bar',
            scrollback: 5000,
            allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        const webLinksAddon = new WebLinksAddon();
        terminal.loadAddon(webLinksAddon);

        // Create panel DOM
        const panel = document.createElement('div');
        panel.className = 'terminal-panel animate-in';
        panel.style.setProperty('--panel-color', agent.color);
        panel.dataset.termId = agent.id;

        panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-dot idle"></span>
        <span class="panel-name" title="Double-click to rename">${agent.name}</span>
        <span class="panel-status status-cycle status-idle" data-term-id="${agent.id}">idle</span>
        <span class="panel-lastline" title="Last terminal output"></span>
        <div class="panel-actions">
          <button class="panel-action-btn maximize" title="Maximize">⤢</button>
          <button class="panel-action-btn close" title="Close">✕</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="block-container"></div>
        <div class="terminal-mount"></div>
      </div>
    `;

        container.appendChild(panel);

        const mount = panel.querySelector('.terminal-mount') as HTMLElement;
        mount.style.width = '100%';
        mount.style.height = '100%';

        terminal.open(mount);

        // Feature 1: GPU-accelerated WebGL rendering with canvas fallback
        try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
                webglAddon.dispose();
            });
            terminal.loadAddon(webglAddon);
        } catch {
            // WebGL not supported — falls back to canvas renderer automatically
        }

        // Phase 6: Search addon
        const searchAddon = new SearchAddon();
        terminal.loadAddon(searchAddon);

        // Phase 7: Image display (Sixel / iTerm2 protocol)
        try {
            const imageAddon = new ImageAddon();
            terminal.loadAddon(imageAddon);
        } catch {
            // Image addon requires WebGL — skip if unavailable
        }

        requestAnimationFrame(() => {
            try { fitAddon.fit(); } catch { }
        });

        const inst: TerminalInstance = {
            id: agent.id,
            agent,
            terminal,
            fitAddon,
            searchAddon,
            element: panel,
            blocks: [],
            currentBlock: null,
            lineBuffer: '',
        };

        this.terminals.set(agent.id, inst);

        // Spawn real shell via Electron IPC
        const { cols, rows } = terminal;
        this.bridge.spawnTerminal({
            id: agent.id,
            cols,
            rows,
            cwd: agent.cwd,
            ...(taskContext ? { timerState: `task:${taskContext.id}` } : {}),
        }).then((result) => {
            // Remove loading indicator
            inst.element.querySelector('.terminal-loading')?.remove();
            if (result.error) {
                terminal.write(`\r\n\x1b[31m Error: ${result.error}\x1b[0m\r\n`);
                this.onStatusChange?.(agent.id, 'error');
                // Fix #6: only show dead shell overlay on actual spawn failure
                this.showDeadShellOverlay(inst, agent);
            } else {
                this.onStatusChange?.(agent.id, 'idle');
            }
        });

        // Fix #13: show loading indicator while shell is spawning
        const loadingEl = document.createElement('div');
        loadingEl.className = 'terminal-loading';
        loadingEl.innerHTML = '<span class="terminal-loading-dot">⟳</span> Connecting...';
        const body = panel.querySelector('.panel-body') as HTMLElement;
        body.style.position = 'relative';
        body.appendChild(loadingEl);

        // Forward keyboard input
        terminal.onData((data: string) => {
            this.writeToTerminal(agent.id, data);
        });

        // Fix #4: clear glow/activity when terminal gets focus (e.g., user clicks into it)
        terminal.textarea?.addEventListener('focus', () => {
            this.setActive(agent.id);
        });

        // Handle resize
        terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            this.bridge.resizeTerminal(agent.id, cols, rows);
        });

        // Panel click → activate
        panel.addEventListener('click', () => {
            this.setActive(agent.id);
        });

        // Double-click to rename
        const nameEl = panel.querySelector('.panel-name') as HTMLElement;
        nameEl.addEventListener('dblclick', () => {
            const input = document.createElement('input');
            input.className = 'panel-name-input';
            input.value = agent.name;
            nameEl.replaceWith(input);
            input.focus();
            input.select();

            const finish = () => {
                const newName = input.value.trim() || agent.name;
                agent.name = newName;
                const newNameEl = document.createElement('span');
                newNameEl.className = 'panel-name';
                newNameEl.title = 'Double-click to rename';
                newNameEl.textContent = newName;
                input.replaceWith(newNameEl);
                newNameEl.addEventListener('dblclick', () => nameEl.dispatchEvent(new Event('dblclick')));
                window.dispatchEvent(new CustomEvent('kaizen-state-change'));
            };

            input.addEventListener('blur', finish);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') finish();
                if (e.key === 'Escape') { input.value = agent.name; finish(); }
            });
        });

        // Status cycle click
        const statusEl = panel.querySelector('.status-cycle') as HTMLElement;
        statusEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const statuses: AgentConfig['status'][] = ['idle', 'working', 'done', 'error'];
            const current = statuses.indexOf(agent.status);
            const next = statuses[(current + 1) % statuses.length];
            this.setAgentStatus(agent.id, next);
        });

        // Close button
        const closeBtn = panel.querySelector('.panel-action-btn.close') as HTMLElement;
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeTerminal(agent.id);
        });

        // Maximize button
        const maxBtn = panel.querySelector('.panel-action-btn.maximize') as HTMLElement;
        maxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('maximized');
            requestAnimationFrame(() => {
                try { fitAddon.fit(); } catch { }
            });
        });

        this.setActive(agent.id);
        return inst;
    }

    setActive(id: string) {
        this.activeId = id;
        this.terminals.forEach((inst) => {
            const isActive = inst.id === id;
            inst.element.classList.toggle('active', isActive);
            if (isActive) {
                inst.terminal.focus();
                // Clear error glow and activity indicators when panel is focused
                inst.element.querySelector('.panel-header')?.classList.remove('has-errors', 'has-activity', 'is-blocked');
                inst.element.querySelector('.panel-dot')?.classList.remove('error-pulse', 'blocked-pulse');
            }
        });
    }

    setAgentStatus(id: string, status: AgentConfig['status']) {
        const inst = this.terminals.get(id);
        if (!inst) return;

        inst.agent.status = status;
        const dot = inst.element.querySelector('.panel-dot') as HTMLElement;
        const statusEl = inst.element.querySelector('.status-cycle') as HTMLElement;

        if (dot) dot.className = `panel-dot ${status}`;
        if (statusEl) {
            statusEl.className = `panel-status status-cycle status-${status}`;
            statusEl.textContent = status;
        }
        this.onStatusChange?.(id, status);
        window.dispatchEvent(new CustomEvent('kaizen-state-change'));
    }

    removeTerminal(id: string) {
        const inst = this.terminals.get(id);
        if (!inst) return;

        this.bridge.killTerminal(id);
        inst.terminal.dispose();

        inst.element.style.transition = 'opacity 0.2s, transform 0.2s';
        inst.element.style.opacity = '0';
        inst.element.style.transform = 'scale(0.95)';
        setTimeout(() => inst.element.remove(), 200);

        this.terminals.delete(id);

        if (this.activeId === id) {
            const remaining = Array.from(this.terminals.keys());
            if (remaining.length > 0) this.setActive(remaining[0]);
        }

        window.dispatchEvent(new CustomEvent('kaizen-agent-removed', { detail: { id } }));
        window.dispatchEvent(new CustomEvent('kaizen-state-change'));
    }

    fitAll() {
        this.terminals.forEach((inst) => {
            try { inst.fitAddon.fit(); } catch { }
        });
    }

    getActiveId(): string | null {
        return this.activeId;
    }

    /** Phase 6: Toggle search bar in active terminal */
    toggleSearch() {
        if (!this.activeId) return;
        const inst = this.terminals.get(this.activeId);
        if (!inst) return;

        const existing = inst.element.querySelector('.terminal-search-bar');
        if (existing) {
            inst.searchAddon.clearDecorations();
            existing.remove();
            inst.terminal.focus();
            return;
        }

        const bar = document.createElement('div');
        bar.className = 'terminal-search-bar';
        bar.innerHTML = `
            <input class="search-input" placeholder="Search..." />
            <button class="search-btn" title="Previous">\u25b2</button>
            <button class="search-btn" title="Next">\u25bc</button>
            <button class="search-btn search-close" title="Close">\u2715</button>
        `;

        const body = inst.element.querySelector('.panel-body') as HTMLElement;
        body.style.position = 'relative';
        body.appendChild(bar);

        const input = bar.querySelector('.search-input') as HTMLInputElement;
        const [prevBtn, nextBtn, closeBtn] = bar.querySelectorAll('.search-btn');

        input.addEventListener('input', () => {
            inst.searchAddon.findNext(input.value, { regex: false, caseSensitive: false });
        });
        nextBtn.addEventListener('click', () => inst.searchAddon.findNext(input.value));
        prevBtn.addEventListener('click', () => inst.searchAddon.findPrevious(input.value));
        closeBtn.addEventListener('click', () => {
            inst.searchAddon.clearDecorations();
            bar.remove();
            inst.terminal.focus();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.shiftKey ? inst.searchAddon.findPrevious(input.value) : inst.searchAddon.findNext(input.value); }
            if (e.key === 'Escape') { inst.searchAddon.clearDecorations(); bar.remove(); inst.terminal.focus(); }
        });

        setTimeout(() => input.focus(), 50);
    }

    /** Fix 6: Send data to all active terminals */
    broadcastToAll(data: string) {
        this.terminals.forEach((inst) => {
            this.bridge.writeTerminal(inst.id, data);
        });
    }

    /** Feature 3: Write data to a specific terminal */
    private inputBuffers: Map<string, string> = new Map();

    writeToTerminal(id: string, data: string) {
        // Phase 9: NL→Command — buffer input, check on Enter
        if (data === '\r') {
            const buffer = this.inputBuffers.get(id) || '';
            this.inputBuffers.set(id, '');

            if (buffer.startsWith('#') && buffer.length > 1) {
                // Clear typed line (Ctrl+U) and intercept
                this.bridge.writeTerminal(id, '\x15');
                const cleanStr = buffer.startsWith('# ') ? buffer.slice(2) : buffer.slice(1);
                window.dispatchEvent(new CustomEvent('kaizen-nl-command', {
                    detail: { agentId: id, naturalLanguage: cleanStr.trim() }
                }));
                return;
            }
            this.bridge.writeTerminal(id, data);
            return;
        }

        // Backspace: remove last buffered char
        if (data === '\x7f') {
            const buf = this.inputBuffers.get(id) || '';
            this.inputBuffers.set(id, buf.slice(0, -1));
            this.bridge.writeTerminal(id, data);
            return;
        }

        // Buffer printable characters
        if (data.length === 1 && data.charCodeAt(0) >= 32) {
            const buf = this.inputBuffers.get(id) || '';
            this.inputBuffers.set(id, buf + data);
        } else if (data.length > 1) {
            // Pasted text or control sequence — reset buffer
            this.inputBuffers.set(id, '');
        }

        this.bridge.writeTerminal(id, data);
    }

    /** Phase 9: Write raw data bypassing NL interception */
    writeRaw(id: string, data: string) {
        this.bridge.writeTerminal(id, data);
    }

    /** Fix 7: Dead shell overlay for restored sessions */
    private showDeadShellOverlay(inst: TerminalInstance, agent: AgentConfig) {
        // Remove existing overlay if any
        inst.element.querySelector('.shell-dead-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'shell-dead-overlay';
        overlay.innerHTML = `
            <span class="shell-dead-icon">💀</span>
            <span class="shell-dead-text">Shell exited — session was restored</span>
            <button class="shell-reconnect-btn">⟳ Reconnect Shell</button>
        `;

        const body = inst.element.querySelector('.panel-body') as HTMLElement;
        body.style.position = 'relative';
        body.appendChild(overlay);

        overlay.querySelector('.shell-reconnect-btn')!.addEventListener('click', () => {
            overlay.remove();
            const { cols, rows } = inst.terminal;
            this.bridge.spawnTerminal({ id: agent.id, cols, rows, cwd: agent.cwd })
                .then((result) => {
                    if (result.error) {
                        inst.terminal.write(`\r\n\x1b[31mFailed to reconnect: ${result.error}\x1b[0m\r\n`);
                        this.showDeadShellOverlay(inst, agent);
                    } else {
                        inst.terminal.write('\r\n\x1b[90m[Shell reconnected]\x1b[0m\r\n');
                        this.onStatusChange?.(agent.id, 'idle');
                    }
                });
        });
    }

    getTerminal(id: string): TerminalInstance | undefined {
        return this.terminals.get(id);
    }

    getAllTerminals(): TerminalInstance[] {
        return Array.from(this.terminals.values());
    }

    async discoverSkills(paths: string[]): Promise<any> {
        return this.bridge.discoverSkills(paths);
    }

    async discoverMCP(paths: string[]): Promise<any> {
        return this.bridge.discoverMCP(paths);
    }

    destroy() {
        this.terminals.forEach((inst) => {
            this.bridge.killTerminal(inst.id);
            inst.terminal.dispose();
        });
        this.terminals.clear();
    }

    // ─── Phase 8: Block-Based Output ──────────────────────────────────

    private trackBlocks(inst: TerminalInstance, data: string) {
        // Build up line buffer
        const clean = data
            .replace(TerminalManager.ANSI_STRIP_RE, '')
            .replace(/\r/g, '');

        inst.lineBuffer += clean;

        // Check for shell prompt at end (new command starting)
        const lines = inst.lineBuffer.split('\n');
        const lastLine = lines[lines.length - 1].trim();

        if (TerminalManager.SHELL_PROMPT_RE.test(lastLine) && inst.lineBuffer.length > 10) {
            // Finalize current block
            if (inst.currentBlock && (inst.currentBlock.command || inst.currentBlock.output.length > 0)) {
                inst.blocks.push(inst.currentBlock);
                this.renderBlock(inst, inst.currentBlock);
                // Keep max 50 blocks
                if (inst.blocks.length > 50) inst.blocks.shift();
            }

            // Start new block
            inst.currentBlock = {
                command: '',
                output: [],
                timestamp: Date.now(),
                hasError: false,
            };
            inst.lineBuffer = '';
        } else if (inst.currentBlock) {
            // Track output lines
            const outputLines = clean.split('\n').filter(l => l.trim());
            if (!inst.currentBlock.command && outputLines.length > 0) {
                inst.currentBlock.command = outputLines[0].trim();
                inst.currentBlock.output.push(...outputLines.slice(1));
            } else {
                inst.currentBlock.output.push(...outputLines);
            }

            // Check for errors
            if (TerminalManager.ANSI_ERROR_RE.test(data)) {
                inst.currentBlock.hasError = true;
            }
        }
    }

    private renderBlock(inst: TerminalInstance, block: CommandBlock) {
        const container = inst.element.querySelector('.block-container');
        if (!container) return;

        const el = document.createElement('div');
        el.className = `output-block${block.hasError ? ' has-error' : ''}`;

        const time = new Date(block.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
        const outputPreview = block.output.slice(0, 6).join('\n');
        const hasMore = block.output.length > 6;
        const fullOutput = block.output.join('\n');

        el.innerHTML = `
            <div class="block-header">
                <span class="block-cmd">${this.escapeHtml(block.command || '(no command)')}</span>
                <span class="block-time">${time}</span>
                <div class="block-actions">
                    <button class="block-btn" data-action="copy" title="Copy output">📋</button>
                    <button class="block-btn" data-action="ai" title="Ask AI about this">🤖</button>
                    <button class="block-btn" data-action="collapse" title="Collapse">${hasMore ? '▼' : '–'}</button>
                </div>
            </div>
            <pre class="block-output">${this.escapeHtml(hasMore ? outputPreview + '\n...' : outputPreview)}</pre>
            ${block.hasError ? '<div class="block-error-badge">⚠ Error detected</div>' : ''}
        `;

        // Store full output for copy/AI
        el.dataset.fullOutput = fullOutput;
        el.dataset.command = block.command;

        // Action handlers
        el.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
            if (!btn) return;
            const action = btn.dataset.action;
            if (action === 'copy') {
                navigator.clipboard.writeText(fullOutput);
                btn.textContent = '✅';
                setTimeout(() => btn.textContent = '📋', 1500);
            } else if (action === 'collapse') {
                const pre = el.querySelector('.block-output') as HTMLElement;
                if (pre) {
                    const isCollapsed = pre.classList.toggle('collapsed');
                    btn.textContent = isCollapsed ? '▶' : '▼';
                }
            } else if (action === 'ai') {
                // Dispatch event for main.ts to handle AI diagnosis
                window.dispatchEvent(new CustomEvent('kaizen-block-diagnose', {
                    detail: {
                        command: block.command,
                        output: fullOutput,
                        hasError: block.hasError,
                        agentId: inst.id,
                    }
                }));
            }
        });

        container.appendChild(el);
        // Auto-scroll to latest block
        container.scrollTop = container.scrollHeight;

        // Collapse older blocks (keep last 3 expanded)
        const allBlocks = container.querySelectorAll('.output-block');
        if (allBlocks.length > 3) {
            for (let i = 0; i < allBlocks.length - 3; i++) {
                const pre = allBlocks[i].querySelector('.block-output');
                if (pre && !pre.classList.contains('collapsed')) {
                    pre.classList.add('collapsed');
                    const collapseBtn = allBlocks[i].querySelector('[data-action="collapse"]');
                    if (collapseBtn) collapseBtn.textContent = '▶';
                }
            }
        }
    }

    private escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
