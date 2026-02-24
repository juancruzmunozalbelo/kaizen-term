// ===================================================
// KaizenTerm — Main Application (Electron)
// ===================================================

import './styles/index.css';
import './styles/terminal.css';
import './styles/kanban.css';
import './styles/components.css';
import './styles/tools.css';
import 'xterm/css/xterm.css';


import { TerminalManager } from './modules/terminal-manager';
import { KanbanBoard } from './modules/kanban';
import { FocusTimer } from './modules/focus-timer';
import { CommandPalette } from './modules/command-palette';
import type { AppState, AgentConfig } from './modules/state';
import { loadState, saveState, createAgent } from './modules/state';
import { applyTheme, getThemeByName, THEMES } from './modules/themes';
import { PluginManager } from './modules/plugin-api';
import { CodebaseIndex } from './modules/codebase-index';

class KaizenApp {
  private state: AppState;
  private terminalManager: TerminalManager;
  private kanban: KanbanBoard;
  private timer: FocusTimer;
  private palette: CommandPalette;
  private saveDebounce: ReturnType<typeof setTimeout> | null = null;

  private pluginManager!: PluginManager;
  private codebaseIndex!: CodebaseIndex;

  constructor() {
    this.state = loadState();
    this.terminalManager = new TerminalManager();

    this.kanban = new KanbanBoard(
      document.getElementById('kanban-sidebar')!,
      this.state.tasks
    );

    this.timer = new FocusTimer(
      document.getElementById('focus-timer')!,
      this.state.timerSeconds,
      this.state.timerCycles
    );

    this.palette = new CommandPalette();
    this.init();
  }

  private init() {
    // ─── Callbacks ───────────────────────────────────────────────────
    this.terminalManager.setStatusCallback((id, status) => {
      const agent = this.state.agents.find(a => a.id === id);
      if (agent) agent.status = status;
      this.scheduleStateSave();
    });

    this.kanban.setChangeCallback((tasks) => {
      this.state.tasks = tasks;
      this.scheduleStateSave();
    });

    this.timer.setCycleCallback((cycles) => {
      this.state.timerCycles = cycles;
      this.scheduleStateSave();
    });

    // ─── Layout Buttons ──────────────────────────────────────────────
    document.querySelectorAll('.layout-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const layout = parseInt((btn as HTMLElement).dataset.layout || '1') as 1 | 2 | 4 | 6;
        this.setLayout(layout);
      });
    });

    // ─── Top Bar Actions ─────────────────────────────────────────────
    document.getElementById('add-agent-btn')!.addEventListener('click', () => this.addAgent());
    document.getElementById('zen-mode-btn')!.addEventListener('click', () => this.toggleZenMode());
    document.getElementById('cmd-palette-btn')!.addEventListener('click', () => this.palette.open());
    document.getElementById('kanban-toggle')!.addEventListener('click', () => this.toggleKanban());
    document.getElementById('kanban-close')!.addEventListener('click', () => this.toggleKanban());
    document.getElementById('tools-toggle')!.addEventListener('click', () => this.toggleTools());
    document.getElementById('tools-close')!.addEventListener('click', () => this.toggleTools());
    document.getElementById('mcp-refresh')!.addEventListener('click', () => this.runDiscovery());
    document.getElementById('skills-refresh')!.addEventListener('click', () => this.runDiscovery());

    // ─── Register Commands ───────────────────────────────────────────
    this.registerCommands();

    // ─── AI Readiness Polling (Loading Overlay) ──────────────────────
    this.pollOllamaReady();

    // ─── Keyboard Shortcuts ──────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); this.addAgent(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); this.toggleKanban(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); this.toggleTools(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') { e.preventDefault(); this.toggleZenMode(); }
      // Fix 6: Broadcast to all terminals
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') { e.preventDefault(); this.showBroadcastModal(); }
      // Feature 5: Omni-Agent drawer
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') { e.preventDefault(); this.toggleOmniDrawer(); }
      // Phase 6: Terminal search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); this.terminalManager.toggleSearch(); }
      // Fix 8: Escape key priority — omni > drawer > palette > zen, with early return
      if (e.key === 'Escape') {
        const omni = document.getElementById('omni-agent-drawer');
        if (omni && !omni.classList.contains('hidden')) { omni.classList.add('hidden'); return; }
        const drawer = document.getElementById('task-detail-drawer');
        const palette = document.querySelector('.command-palette:not(.hidden)');
        const broadcast = document.getElementById('broadcast-modal');
        if (drawer && !drawer.classList.contains('hidden')) { this.closeDetailDrawer(); return; }
        if (broadcast && !broadcast.classList.contains('hidden')) { broadcast.classList.add('hidden'); return; }
        if (palette) return; // palette handles its own escape
        if (this.state.zenMode) { e.preventDefault(); this.toggleZenMode(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (this.state.agents[idx]) {
          this.terminalManager.setActive(this.state.agents[idx].id);
          this.refreshAgentTabs();
        }
      }
    });

    // ─── Agent Removed Event ─────────────────────────────────────────
    window.addEventListener('kaizen-state-change', () => this.scheduleStateSave());
    window.addEventListener('kaizen-agent-removed', ((e: CustomEvent) => {
      this.state.agents = this.state.agents.filter(a => a.id !== e.detail.id);
      this.updateStatusBar();
      this.refreshAgentTabs();
      this.checkEmptyState();
      this.scheduleStateSave();
    }) as EventListener);
    // Fix 9: debounced palette sync (not on every state change)
    let paletteSyncTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('kaizen-state-change', () => {
      if (paletteSyncTimer) clearTimeout(paletteSyncTimer);
      paletteSyncTimer = setTimeout(() => this.syncPaletteAgentCommands(), 500);
    });

    // ─── Fix 4: Task Detail Drawer ───────────────────────────────────
    this.initDetailDrawer();

    // Fix #10: refresh agent tabs when a terminal emits errors
    window.addEventListener('kaizen-terminal-error', () => this.refreshAgentTabs());

    // Phase 8: AI block diagnosis — when user clicks 🤖 on a block
    window.addEventListener('kaizen-block-diagnose', ((e: CustomEvent) => {
      const { command, output, hasError } = e.detail;
      // Open omni drawer and prepare AI message
      const drawer = document.getElementById('omni-agent-drawer');
      if (drawer?.classList.contains('hidden')) {
        drawer.classList.remove('hidden');
      }
      const input = document.getElementById('omni-input') as HTMLTextAreaElement;
      if (input) {
        const prefix = hasError ? 'Explain this error and suggest a fix' : 'Explain this output';
        input.value = `${prefix}:\n\`\`\`\n$ ${command}\n${output.slice(0, 2000)}\n\`\`\``;
        // Auto-click AI button
        setTimeout(() => document.getElementById('omni-send-ai')?.click(), 100);
      }
    }) as EventListener);
    // Amber Alert: refresh tabs when an agent is blocked
    window.addEventListener('kaizen-terminal-blocked', ((e: CustomEvent) => {
      this.refreshAgentTabs();
      this.showToast('warning', `⏳ Agent waiting for input: ${e.detail.prompt?.slice(0, 50)}`);
    }) as EventListener);

    // Phase 9: Auto-close Kanban pipeline — Exit 0 → Card Done
    window.addEventListener('kaizen-agent-exit', ((e: CustomEvent) => {
      const { agentId, exitCode } = e.detail;
      if (exitCode !== 0) return; // Only auto-close on success

      // Find linked Kanban card
      const card = this.state.tasks.find(t => t.agentId === agentId && t.status !== 'done');
      if (card) {
        card.status = 'done';
        this.scheduleStateSave();
        this.showToast('success', `✅ Task "${card.title}" auto-completed (Exit 0)`);
        // Refresh Kanban if open
        if (this.state.kanbanOpen) {
          this.kanban?.render();
        }
      }
    }) as EventListener);

    // ─── Resize ──────────────────────────────────────────────────────
    let resizeTimer: ReturnType<typeof setTimeout>;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.terminalManager.fitAll(), 100);
    });

    // ─── Session Timer ──────────────────────────────────────────────
    setInterval(() => this.updateSessionTime(), 1000);

    // ─── Phase 9: NL→Command (# prefix) ──────────────────────────────
    window.addEventListener('kaizen-nl-command', (async (e: Event) => {
      const { agentId, naturalLanguage } = (e as CustomEvent).detail;
      this.showToast('info', `🗣️ Translating: "${naturalLanguage}"...`);

      try {
        const resp = await fetch(`${this.state.aiBaseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.state.aiModel,
            messages: [
              {
                role: 'system', content: `You are a shell command translator for macOS/Linux (zsh). Rules:
1. If input describes a shell task → output ONLY the raw command, single line, no explanation
2. If input is a greeting, question about you, or anything NOT a computer task → output NOTHING (empty string)
Examples:
- "list files" → "ls -la"
- "create folder test" → "mkdir test"
- "hola" → ""
- "hola que eres" → ""
- "who are you" → ""` },
              { role: 'user', content: naturalLanguage },
            ],
            stream: false,
          }),
        });

        if (!resp.ok) throw new Error(`${resp.status}`);
        const json = await resp.json();
        const command = json.choices?.[0]?.message?.content?.trim();

        // Validate: must be a single-line shell command
        const isValidCommand = command && !command.includes('\n') && command.length < 300
          && !command.toLowerCase().includes('command not recognized')
          && !command.toLowerCase().includes('please provide');

        if (isValidCommand) {
          this.showToast('success', `💡 ${command}`);
          this.terminalManager.writeRaw(agentId, command);
        } else {
          this.showToast('warning', '⚠️ Could not translate to a shell command. Try: # list files here');
        }
      } catch (err: any) {
        this.showToast('warning', `⚠️ AI translation failed: ${err.message}`);
      }
    }) as EventListener);

    // Ollama model download progress
    if ((window as any).kaizenBridge?.onOllamaProgress) {
      (window as any).kaizenBridge.onOllamaProgress((progress: { status: string; percent?: number }) => {
        this.showOllamaDownloadBanner(progress);
        // Also update loading overlay if still visible
        const loadingStatus = document.getElementById('ai-loading-status');
        if (loadingStatus) {
          const pct = progress.percent != null ? ` (${Math.round(progress.percent)}%)` : '';
          loadingStatus.textContent = `${progress.status}${pct}`;
        }
      });
    }

    // ─── Error Toasts from Main Process ──────────────────────────────
    if ((window as any).kaizenBridge?.onAppError) {
      (window as any).kaizenBridge.onAppError((msg: string) => {
        this.showToast('error', `⚠️ ${msg}`);
      });

      // Timer config (right-click on timer)
      window.addEventListener('kaizen-timer-config', () => this.configureTimer());

      // AI config (click on status-ai badge)
      window.addEventListener('kaizen-configure-ai', () => this.configureAI());
    }

    // ─── Synchronous Save on Close (Fix #6) ─────────────────────────
    window.addEventListener('beforeunload', () => {
      saveState(this.state);
    });

    // ─── Initialize ─────────────────────────────────────────────────
    this.setLayout(this.state.layout);
    if (this.state.kanbanOpen) document.getElementById('kanban-sidebar')!.classList.remove('hidden');
    if (this.state.toolsOpen) document.getElementById('tools-sidebar')!.classList.remove('hidden');

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    if (this.state.agents.length > 0) {
      this.restoreAgents();
    } else {
      this.checkEmptyState();
    }

    // Fix 3: wire Kanban spawn-agent callback
    this.kanban.setSpawnAgentCallback((task: any) => this.addAgentForTask(task));
    // Fix 4: wire Kanban open-detail callback
    this.kanban.setOpenDetailCallback((task: any) => this.openDetailDrawer(task));
    // Fix 8: initial tab render
    this.refreshAgentTabs();

    // Discover MCP/Skills
    setTimeout(() => this.runDiscovery(), 1500);

    this.rotateKaizenQuote();
    this.updateStatusBar();
    this.initAlertHistory();

    // Phase 10: Show onboarding on first launch
    if (!this.state.onboarded) {
      this.showOnboarding();
    }

    // Phase 7: Apply saved theme
    applyTheme(getThemeByName(this.state.theme || 'midnight'));

    // Phase 7: Git branch polling
    this.updateGitBranch();
    setInterval(() => this.updateGitBranch(), 30000);

    // Sprint C: Initialize plugin system
    this.initPluginSystem();

    // Sprint C: Initialize codebase index
    this.codebaseIndex = new CodebaseIndex();
  }

  // ─── Agent Management ──────────────────────────────────────────────

  addAgent(name?: string, taskContext?: { id: string; title: string }) {
    const agent = createAgent(this.state, name);
    if (taskContext) {
      (agent as any).taskId = taskContext.id;
      (agent as any).taskTitle = taskContext.title;
    }
    this.state.agents.push(agent);

    const grid = document.getElementById('terminal-grid')!;
    const emptyEl = grid.querySelector('.terminal-empty');
    if (emptyEl) emptyEl.remove();

    // Auto-scale layout BEFORE creating terminal so CSS grid is ready
    if (this.state.agents.length > 1 && this.state.layout < this.state.agents.length) {
      const newLayout = this.state.agents.length <= 2 ? 2 : this.state.agents.length <= 4 ? 4 : 6;
      this.setLayout(newLayout as 1 | 2 | 4 | 6);
    }

    this.terminalManager.createTerminal(agent, grid, taskContext);

    // Activate the new agent so it's visible (especially in layout-1)
    this.terminalManager.setActive(agent.id);

    this.updateStatusBar();
    this.refreshAgentTabs();
    this.scheduleStateSave();
    setTimeout(() => this.terminalManager.fitAll(), 100);
  }

  // Fix 3: Spawn agent pre-wired to a specific Kanban task
  addAgentForTask(task: { id: string; title: string }) {
    this.addAgent(`agent-${task.id.slice(-4)}`, task);
    if (!this.state.kanbanOpen) { /* keep kanban visible */ }
    this.showToast('success', `⚡ Spawning agent for: ${task.title}`);

    // Feature 3: Zero-click auto-kickoff
    if (this.state.defaultAgentCommand) {
      const cmd = this.state.defaultAgentCommand
        .replace('$TASK_ID', task.id)
        .replace('$TASK_TITLE', task.title);
      const lastAgent = this.state.agents[this.state.agents.length - 1];
      if (lastAgent) {
        setTimeout(() => {
          this.terminalManager.writeToTerminal(lastAgent.id, cmd + '\r');
        }, 800); // Wait for shell to be ready
      }
    }
  }

  private restoreAgents() {
    const grid = document.getElementById('terminal-grid')!;
    const agents = [...this.state.agents];
    this.state.agents = [];
    for (const cfg of agents) {
      const agent: AgentConfig = { ...cfg, status: 'idle' };
      this.state.agents.push(agent);
      this.terminalManager.createTerminal(agent, grid);
    }
    setTimeout(() => {
      this.terminalManager.fitAll();
      this.refreshAgentTabs();
    }, 200);
    this.updateStatusBar();
  }

  // ─── Layout ────────────────────────────────────────────────────────

  private splitInstances: any[] = [];

  setLayout(layout: 1 | 2 | 3 | 4 | 6) {
    this.state.layout = layout;
    const grid = document.getElementById('terminal-grid')!;
    grid.className = `terminal-grid layout-${layout}`;
    document.querySelectorAll('.layout-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt((btn as HTMLElement).dataset.layout || '0') === layout);
    });
    const names: Record<number, string> = { 1: '1×1', 2: '2×1', 3: 'Main', 4: '2×2', 6: '3×2' };
    const el = document.getElementById('status-layout');
    if (el) el.textContent = names[layout] || `${layout}`;

    // Feature 4: Initialize Split.js for drag-resizable panels
    this.initSplits();
    setTimeout(() => this.terminalManager.fitAll(), 50);
    this.scheduleStateSave();
  }

  private initSplits() {
    // Clean up any existing Split instances
    this.splitInstances.forEach(s => s.destroy());
    this.splitInstances = [];
    // Layouts are now pure CSS Grid — no drag-resize needed
  }

  toggleZenMode() {
    this.state.zenMode = !this.state.zenMode;
    document.getElementById('app')!.classList.toggle('zen-active', this.state.zenMode);
    // Hide agent tabs in zen mode
    const tabsEl = document.getElementById('agent-tabs');
    if (tabsEl) tabsEl.style.display = this.state.zenMode ? 'none' : '';

    // Show/hide floating exit button
    let exitBtn = document.getElementById('zen-exit-float');
    if (this.state.zenMode) {
      if (!exitBtn) {
        exitBtn = document.createElement('button');
        exitBtn.id = 'zen-exit-float';
        exitBtn.className = 'zen-exit-float';
        exitBtn.innerHTML = '◎ Exit Zen <span class="zen-exit-hint">Esc</span>';
        exitBtn.addEventListener('click', () => this.toggleZenMode());
        document.body.appendChild(exitBtn);
      }
      exitBtn.classList.add('visible');
    } else if (exitBtn) {
      exitBtn.classList.remove('visible');
      setTimeout(() => exitBtn?.remove(), 300);
    }

    setTimeout(() => this.terminalManager.fitAll(), 400);
  }

  toggleKanban() {
    this.state.kanbanOpen = !this.state.kanbanOpen;
    document.getElementById('kanban-sidebar')!.classList.toggle('hidden', !this.state.kanbanOpen);
    setTimeout(() => this.terminalManager.fitAll(), 350);
    this.scheduleStateSave();
  }

  toggleTools() {
    this.state.toolsOpen = !this.state.toolsOpen;
    document.getElementById('tools-sidebar')!.classList.toggle('hidden', !this.state.toolsOpen);
    setTimeout(() => this.terminalManager.fitAll(), 350);
    this.scheduleStateSave();
  }

  private checkEmptyState() {
    const grid = document.getElementById('terminal-grid')!;
    if (this.state.agents.length === 0 && !grid.querySelector('.terminal-empty')) {
      const empty = document.createElement('div');
      empty.className = 'terminal-empty';
      empty.innerHTML = `
        <div class="empty-icon">◎</div>
        <div class="empty-text">No agents active</div>
        <div class="empty-hint">Click here or press Ctrl+N to add an agent</div>
      `;
      empty.addEventListener('click', () => this.addAgent());
      grid.appendChild(empty);
    }
  }

  private updateStatusBar() {
    const el = document.getElementById('status-agents');
    if (el) el.textContent = `${this.state.agents.length} agent${this.state.agents.length !== 1 ? 's' : ''}`;
    // Fix #15: show active task in status bar
    const taskEl = document.getElementById('status-tasks');
    if (taskEl) {
      const doing = this.kanban.getTasks().filter((t: any) => t.status === 'doing');
      if (doing.length > 0) {
        taskEl.textContent = `🔥 ${doing[0].title}`;
      } else {
        const total = this.kanban.getTasks().length;
        taskEl.textContent = `${total} task${total !== 1 ? 's' : ''}`;
      }
    }
    // AI provider status
    const aiEl = document.getElementById('status-ai');
    if (aiEl) {
      const provider = this.state.aiProvider;
      const model = this.state.aiModel || '';
      const shortModel = model.length > 16 ? model.slice(0, 14) + '…' : model;
      if (provider === 'none') {
        aiEl.textContent = '🤖 AI off';
        aiEl.style.color = 'var(--text-muted, #555)';
      } else if (provider === 'ollama') {
        aiEl.textContent = `🤖 ${shortModel} [local]`;
        aiEl.style.color = 'var(--agent-cyan, #00e5ff)';
      } else {
        aiEl.textContent = `🤖 ${provider}/${shortModel} [api]`;
        aiEl.style.color = 'var(--agent-pink, #ff006e)';
      }
      aiEl.onclick = () => window.dispatchEvent(new CustomEvent('kaizen-configure-ai'));
    }
  }

  private updateSessionTime() {
    const elapsed = Math.floor((Date.now() - this.state.sessionStart) / 1000);
    const hrs = Math.floor(elapsed / 3600);
    const mins = Math.floor((elapsed % 3600) / 60);
    const secs = elapsed % 60;
    const el = document.getElementById('status-session');
    if (el) el.textContent = hrs > 0 ? `Session: ${hrs}h ${mins.toString().padStart(2, '0')}m` : `Session: ${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // ─── MCP / Skills ──────────────────────────────────────────────────

  private async runDiscovery() {
    // Discover Skills & Workflows
    try {
      const result = await this.terminalManager.discoverSkills(this.state.scanPaths);
      const skills = result.skills || [];
      const workflows = result.workflows || [];

      this.populateSidebarList('skills-list', skills, 'skill');
      this.populateSidebarList('workflows-list', workflows, 'workflow');

      if (skills.length > 0) {
        skills.forEach((s: any) => {
          this.palette.registerCommand({
            id: `skill-${s.name}`, icon: '🔧', title: s.name,
            description: s.description,
            action: () => this.showToast('info', `Skill: ${s.name}`),
            keywords: ['skill', 'workflow'],
          });
        });
      }

      if (workflows.length > 0) {
        workflows.forEach((w: any) => {
          this.palette.registerCommand({
            id: `wf-${w.name}`, icon: '📋', title: w.name,
            description: w.description,
            action: () => this.showToast('info', `Workflow: ${w.name}`),
            keywords: ['workflow'],
          });
        });
      }

      const total = skills.length + workflows.length;
      if (total > 0) this.showToast('info', `🔧 Found ${skills.length} skill${skills.length !== 1 ? 's' : ''}, ${workflows.length} workflow${workflows.length !== 1 ? 's' : ''}`);
    } catch { }

    // Discover MCP Servers
    try {
      const mcpServers = await this.terminalManager.discoverMCP(this.state.scanPaths);
      this.populateSidebarList('mcp-list', mcpServers, 'mcp');

      if (mcpServers.length > 0) {
        this.showToast('info', `🔌 Found ${mcpServers.length} MCP server${mcpServers.length !== 1 ? 's' : ''}`);
        mcpServers.forEach((r: any) => {
          this.palette.registerCommand({
            id: `mcp-${r.name}`, icon: '🔌', title: `MCP: ${r.name}`,
            description: r.command ? `${r.command} (${r.source})` : r.source,
            action: () => this.showToast('info', `MCP: ${r.name}`),
            keywords: ['mcp', 'server'],
          });
        });
      }
    } catch { }
  }

  private populateSidebarList(listId: string, items: any[], type: 'mcp' | 'skill' | 'workflow') {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = '';

    if (items.length === 0) {
      list.innerHTML = '<div class="tools-empty">None found</div>';
      return;
    }

    // Sort by usage (most used first)
    const sorted = [...items].sort((a, b) => {
      const usageA = this.state.toolUsage[a.name] || 0;
      const usageB = this.state.toolUsage[b.name] || 0;
      return usageB - usageA;
    });

    const icons: Record<string, string> = { mcp: '🔌', skill: '🔧', workflow: '📋' };
    const badges: Record<string, { text: string; cls: string }> = {
      mcp: { text: 'installed', cls: 'installed' },
      skill: { text: 'ready', cls: 'online' },
      workflow: { text: 'ready', cls: 'online' },
    };

    for (const item of sorted) {
      const el = document.createElement('div');
      el.className = 'tool-item';
      // Fix #12: use DOM API instead of innerHTML for user-controllable content
      const iconDiv = document.createElement('div');
      iconDiv.className = `tool-item-icon ${type}`;
      iconDiv.textContent = icons[type];

      const infoDiv = document.createElement('div');
      infoDiv.className = 'tool-item-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'tool-item-name';
      nameDiv.textContent = item.name;
      const descDiv = document.createElement('div');
      descDiv.className = 'tool-item-desc';
      descDiv.textContent = item.description || item.command || '';
      infoDiv.appendChild(nameDiv);
      infoDiv.appendChild(descDiv);

      const badge = document.createElement('span');
      badge.className = `tool-item-badge ${badges[type].cls}`;
      badge.textContent = badges[type].text;

      el.appendChild(iconDiv);
      el.appendChild(infoDiv);
      el.appendChild(badge);

      el.addEventListener('click', () => {
        // Track usage
        this.state.toolUsage[item.name] = (this.state.toolUsage[item.name] || 0) + 1;
        this.scheduleStateSave();
        this.showToast('info', `${icons[type]} ${item.name}`);
      });
      list.appendChild(el);
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────

  private registerCommands() {
    this.palette.registerCommands([
      { id: 'new-agent', icon: '＋', title: 'New Agent', description: 'Add a new terminal agent', shortcut: '⌘N', action: () => this.addAgent(), keywords: ['add', 'agent', 'terminal'] },
      { id: 'toggle-kanban', icon: '☰', title: 'Toggle Kanban Board', description: 'Show/hide the Kaizen task board', shortcut: '⌘B', action: () => this.toggleKanban(), keywords: ['kanban', 'board', 'tasks'] },
      { id: 'zen-mode', icon: '◎', title: 'Zen Mode', description: 'Toggle distraction-free mode', shortcut: '⌘⇧Z', action: () => this.toggleZenMode(), keywords: ['zen', 'focus', 'minimal'] },
      { id: 'layout-1', icon: '▢', title: 'Layout: Single', description: 'Single terminal pane', action: () => this.setLayout(1), keywords: ['layout', 'single'] },
      { id: 'layout-2', icon: '▥', title: 'Layout: Split', description: 'Two panes side by side', action: () => this.setLayout(2), keywords: ['layout', 'split'] },
      { id: 'layout-3', icon: '◧', title: 'Layout: Main + Sides', description: 'One main pane + smaller side panes', action: () => this.setLayout(3), keywords: ['layout', 'main', 'sides', 'focus'] },
      { id: 'layout-4', icon: '⊞', title: 'Layout: Grid 2×2', description: 'Four terminal panes', action: () => this.setLayout(4), keywords: ['layout', 'grid', 'four'] },
      { id: 'layout-6', icon: '⊞', title: 'Layout: Grid 3×2', description: 'Six terminal panes', action: () => this.setLayout(6), keywords: ['layout', 'grid', 'six'] },
      { id: 'timer-toggle', icon: '▶', title: 'Start/Pause Timer', description: 'Toggle Pomodoro focus timer', action: () => this.timer.toggle(), keywords: ['timer', 'pomodoro'] },
      { id: 'timer-reset', icon: '⟲', title: 'Reset Timer', description: 'Reset timer to configured duration', action: () => this.timer.reset(), keywords: ['timer', 'reset'] },
      { id: 'timer-config', icon: '⏱', title: 'Configure Timer', description: 'Set custom work/break durations', action: () => this.configureTimer(), keywords: ['timer', 'pomodoro', 'duration', 'minutes', 'config'] },
      { id: 'add-task', icon: '✓', title: 'Add Task', description: 'Add task to backlog', action: () => { if (!this.state.kanbanOpen) this.toggleKanban(); (document.querySelector('.add-task-btn[data-status="backlog"]') as HTMLElement)?.click(); }, keywords: ['task', 'add'] },
      { id: 'discover-skills', icon: '🔧', title: 'Discover Skills', description: 'Scan for available skills', action: () => { this.runDiscovery(); this.showToast('info', 'Scanning...'); }, keywords: ['skills', 'scan'] },
      // Fix 6: Broadcast command
      { id: 'broadcast', icon: '📡', title: 'Broadcast to All Terminals', description: 'Send the same command to every agent terminal', shortcut: '⌘⇧B', action: () => this.showBroadcastModal(), keywords: ['broadcast', 'all', 'send', 'multi'] },
      // Feature 5: Omni-Agent Drawer
      { id: 'omni-agent', icon: '🤖', title: 'Agent Chat', description: 'Open AI / prompt drawer', shortcut: '⌘⇧A', action: () => this.toggleOmniDrawer(), keywords: ['agent', 'chat', 'ai', 'prompt', 'omni'] },
      // Feature 3: Configure default agent command
      { id: 'set-agent-cmd', icon: '⚙️', title: 'Set Default Agent Command', description: 'Configure the command auto-run when spawning agents from tasks', action: () => this.promptDefaultAgentCommand(), keywords: ['agent', 'command', 'config', 'kickoff'] },
      // Phase 7: Theme switcher
      { id: 'switch-theme', icon: '🎨', title: 'Switch Theme', description: 'Cycle through color themes', action: () => this.cycleTheme(), keywords: ['theme', 'color', 'dark', 'appearance'] },
      // Phase 7: Terminal search
      { id: 'terminal-search', icon: '🔍', title: 'Search in Terminal', description: 'Find text in active terminal', shortcut: '⌘F', action: () => this.terminalManager.toggleSearch(), keywords: ['search', 'find'] },
      // Sprint C: Plugin commands
      { id: 'list-plugins', icon: '🧩', title: 'List Plugins', description: 'Show loaded plugins', action: () => this.listPlugins(), keywords: ['plugin', 'extension'] },
      // Sprint C: Codebase indexing
      { id: 'index-codebase', icon: '🗂️', title: 'Index Codebase', description: 'Build symbol index of the project', action: () => this.runCodebaseIndex(), keywords: ['index', 'codebase', 'symbols'] },
      { id: 'search-codebase', icon: '🔎', title: 'Search Codebase Symbols', description: 'Search indexed symbols', action: () => this.searchCodebase(), keywords: ['search', 'symbols', 'code'] },
      // BYOLLM: AI config
      { id: 'configure-ai', icon: '🤖', title: 'Configure AI Provider', description: `Current: ${this.state.aiProvider} / ${this.state.aiModel}`, action: () => this.configureAI(), keywords: ['ai', 'ollama', 'openai', 'anthropic', 'model', 'api'] },
      // Phase 10: Workspace Sharing
      { id: 'export-workspace', icon: '📦', title: 'Export Workspace', description: 'Save agents + tasks as .kaizen file to share', action: () => this.exportWorkspace(), keywords: ['export', 'share', 'workspace', 'save'] },
      { id: 'import-workspace', icon: '📥', title: 'Import Workspace', description: 'Load a .kaizen workspace file', action: () => this.importWorkspace(), keywords: ['import', 'load', 'workspace', 'open'] },
    ]);

    // Init Omni-Agent drawer
    this.initOmniDrawer();
  }

  private toggleOmniDrawer() {
    const drawer = document.getElementById('omni-agent-drawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden');
    if (!drawer.classList.contains('hidden')) {
      setTimeout(() => (document.getElementById('omni-input') as HTMLTextAreaElement)?.focus(), 100);
    }
  }

  private initOmniDrawer() {
    const drawer = document.getElementById('omni-agent-drawer');
    if (!drawer) return;

    const closeBtn = document.getElementById('omni-close');
    const sendBtn = document.getElementById('omni-send-terminal');
    const input = document.getElementById('omni-input') as HTMLTextAreaElement;
    const messages = document.getElementById('omni-messages')!;

    closeBtn?.addEventListener('click', () => drawer.classList.add('hidden'));

    // Sprint B: Restore saved omni history
    if (this.state.omniHistory?.length) {
      // Remove welcome message
      const welcome = messages.querySelector('.omni-welcome');
      if (welcome) welcome.remove();

      for (const entry of this.state.omniHistory.slice(-50)) {
        const msg = document.createElement('div');
        msg.className = `omni-msg ${entry.role}`;
        msg.textContent = entry.text;
        messages.appendChild(msg);
      }
      requestAnimationFrame(() => messages.scrollTop = messages.scrollHeight);
    }

    const addMessage = (role: string, text: string) => {
      const msg = document.createElement('div');
      msg.className = `omni-msg ${role}`;
      msg.textContent = text;
      messages.appendChild(msg);
      // Sprint B: persist (cap at 50)
      if (!this.state.omniHistory) this.state.omniHistory = [];
      this.state.omniHistory.push({ role, text });
      if (this.state.omniHistory.length > 50) this.state.omniHistory = this.state.omniHistory.slice(-50);
      this.scheduleStateSave();
      messages.scrollTop = messages.scrollHeight;
    };

    const sendToTerminal = () => {
      const text = input.value.trim();
      if (!text) return;

      addMessage('user', text);

      // Send to active terminal
      const activeAgent = this.state.agents.find(a => a.id === (this.terminalManager as any).activeId);
      if (activeAgent) {
        this.terminalManager.writeToTerminal(activeAgent.id, text + '\r');
        addMessage('system', `↳ Sent to ${activeAgent.name}`);
      } else {
        addMessage('system', '⚠ No active terminal');
      }

      input.value = '';
    };

    sendBtn?.addEventListener('click', sendToTerminal);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendToTerminal();
      }
    });

    // Sprint B: MCP routing — Send prompt with terminal context to MCP
    const mcpBtn = document.getElementById('omni-send-mcp');
    mcpBtn?.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;

      addMessage('user', text);

      // Get terminal context for MCP
      const activeId = this.terminalManager.getActiveId();
      let context = '';
      if (activeId) {
        try {
          const output = await window.kaizenBridge.readTerminalOutput(activeId);
          context = output.lines.slice(-30).join('\n');
        } catch { /* ignore */ }
      }

      addMessage('system', '🔌 Sending to MCP agent...');

      // Send prompt + context to active terminal as a structured command
      if (activeId) {
        const mcpPrompt = context
          ? `# Context (last 30 lines):\n${context}\n\n# User prompt:\n${text}`
          : text;
        this.terminalManager.writeToTerminal(activeId, mcpPrompt + '\r');
        addMessage('system', '↳ Prompt with context sent to active terminal');
      } else {
        addMessage('system', '⚠ No active terminal for MCP routing');
      }

      input.value = '';
    });

    // BYOLLM: AI streaming chat handler
    const aiBtn = document.getElementById('omni-send-ai');
    aiBtn?.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;

      if (this.state.aiProvider === 'none') {
        addMessage('system', '⚠ AI disabled. Use Cmd+K → "Configure AI" to set up.');
        return;
      }

      addMessage('user', text);
      input.value = '';

      // Phase 9: Multi-agent @mentions — parse @agent-name from text
      const mentionPattern = /@([\w-]+)/g;
      const mentions = [...text.matchAll(mentionPattern)].map(m => m[1]);
      const userPrompt = text.replace(mentionPattern, '').trim() || text;

      // Build context from mentioned agents (or active terminal)
      let termContext = '';
      const contextSources: string[] = [];

      if (mentions.length > 0) {
        // Pull context from each mentioned agent
        for (const mention of mentions) {
          const agent = this.state.agents.find(a =>
            a.name.toLowerCase() === mention.toLowerCase() ||
            a.id.toLowerCase() === mention.toLowerCase()
          );
          if (agent) {
            try {
              const output = await window.kaizenBridge.readTerminalOutput(agent.id);
              const lines = output.lines.slice(-30).join('\n');
              termContext += `\n--- Terminal: ${agent.name} (${agent.id}) ---\n${lines}\n`;
              contextSources.push(agent.name);
            } catch { /* ignore */ }
          }
        }
        if (contextSources.length > 0) {
          addMessage('system', `📡 Context from: ${contextSources.join(', ')}`);
        }
      } else {
        // Default: use active terminal
        const activeId = this.terminalManager.getActiveId();
        if (activeId) {
          try {
            const output = await window.kaizenBridge.readTerminalOutput(activeId);
            termContext = output.lines.slice(-40).join('\n');
            const activeAgent = this.state.agents.find(a => a.id === activeId);
            if (activeAgent) contextSources.push(activeAgent.name);
          } catch { /* ignore */ }
        }
      }

      const codebaseStats = this.codebaseIndex?.getStats();
      const systemPrompt = `You are a concise terminal/coding assistant embedded in KaizenTerm.
You help developers understand errors, suggest fixes, and write code.
Keep answers short and actionable. Use code blocks with language tags.
${contextSources.length > 0 ? `\nActive agents: ${contextSources.join(', ')}` : ''}
${termContext ? `\nTerminal output:\n\`\`\`\n${termContext}\n\`\`\`` : ''}
${codebaseStats?.symbols ? `\nProject has ${codebaseStats.files} indexed files and ${codebaseStats.symbols} symbols.` : ''}`;

      // Create streaming response bubble
      const responseBubble = document.createElement('div');
      responseBubble.className = 'omni-msg ai';
      responseBubble.textContent = '⏳';
      messages.appendChild(responseBubble);
      messages.scrollTop = messages.scrollHeight;

      try {
        // Build API URL based on provider
        let url: string;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        if (this.state.aiProvider === 'ollama') {
          url = `${this.state.aiBaseUrl}/v1/chat/completions`;
        } else if (this.state.aiProvider === 'openai') {
          url = 'https://api.openai.com/v1/chat/completions';
          headers['Authorization'] = `Bearer ${this.state.aiApiKey}`;
        } else if (this.state.aiProvider === 'anthropic') {
          url = 'https://api.anthropic.com/v1/messages';
          headers['x-api-key'] = this.state.aiApiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          throw new Error('Unknown provider');
        }

        // Anthropic has a different format
        if (this.state.aiProvider === 'anthropic') {
          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: this.state.aiModel,
              max_tokens: 1024,
              system: systemPrompt,
              messages: [{ role: 'user', content: userPrompt }],
              stream: true,
            }),
          });

          const reader = resp.body?.getReader();
          const decoder = new TextDecoder();
          let fullText = '';
          responseBubble.textContent = '';

          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                  const json = JSON.parse(line.slice(6));
                  const delta = json.delta?.text || '';
                  fullText += delta;
                  responseBubble.textContent = fullText;
                  messages.scrollTop = messages.scrollHeight;
                } catch { /* skip */ }
              }
            }
          }
          addMessage('ai', fullText);
          responseBubble.remove();
        } else {
          // OpenAI-compatible (Ollama, OpenAI)
          const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: this.state.aiModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              stream: true,
            }),
          });

          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`${resp.status}: ${errText.slice(0, 100)}`);
          }

          const reader = resp.body?.getReader();
          const decoder = new TextDecoder();
          let fullText = '';
          responseBubble.textContent = '';

          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
                try {
                  const json = JSON.parse(line.slice(6));
                  const delta = json.choices?.[0]?.delta?.content || '';
                  fullText += delta;
                  responseBubble.textContent = fullText;
                  messages.scrollTop = messages.scrollHeight;
                } catch { /* skip */ }
              }
            }
          }
          addMessage('ai', fullText);
          responseBubble.remove();
        }
      } catch (err: any) {
        responseBubble.textContent = `❌ ${err.message || 'Connection failed'}`;
        responseBubble.className = 'omni-msg system';
        if (err.message?.includes('Failed to fetch') || err.message?.includes('ECONNREFUSED')) {
          addMessage('system', '💡 Make sure Ollama is running: `ollama serve`');
        }
      }
    });
  }

  private promptDefaultAgentCommand() {
    const current = this.state.defaultAgentCommand || '';
    const cmd = prompt('Default agent command (use $TASK_ID and $TASK_TITLE as variables):', current);
    if (cmd !== null) {
      this.state.defaultAgentCommand = cmd;
      this.scheduleStateSave();
      this.showToast('success', cmd ? `⚙️ Agent command set: ${cmd}` : '⚙️ Agent auto-command disabled');
    }
  }

  // ─── Toasts ────────────────────────────────────────────────────────

  private alertHistory: Array<{ type: string; message: string; time: number }> = [];
  private alertUnread = 0;

  private showToast(type: 'info' | 'success' | 'warning' | 'error', message: string) {
    let container = document.querySelector('.toast-container') as HTMLElement;
    if (!container) { container = document.createElement('div'); container.className = 'toast-container'; document.body.appendChild(container); }
    const icons: Record<string, string> = { info: '💡', success: '✅', warning: '⚠️', error: '❌' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('toast-fade-out'); setTimeout(() => toast.remove(), 300); }, 3500);

    // Save to alert history
    this.alertHistory.unshift({ type, message, time: Date.now() });
    if (this.alertHistory.length > 50) this.alertHistory.pop();
    this.alertUnread++;
    this.updateAlertBadge();
    this.renderAlertHistory();
  }

  private updateAlertBadge() {
    const badge = document.getElementById('alert-badge');
    if (!badge) return;
    if (this.alertUnread > 0) {
      badge.textContent = this.alertUnread > 9 ? '9+' : String(this.alertUnread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  private renderAlertHistory() {
    const list = document.getElementById('alert-history-list');
    if (!list) return;
    if (this.alertHistory.length === 0) {
      list.innerHTML = '<div class="alert-empty">No alerts yet</div>';
      return;
    }
    const icons: Record<string, string> = { info: '💡', success: '✅', warning: '⚠️', error: '❌' };
    list.innerHTML = this.alertHistory.map(a => {
      const ago = this.timeAgo(a.time);
      return `<div class="alert-item alert-${a.type}"><span class="alert-item-icon">${icons[a.type] || '📌'}</span><span class="alert-item-msg">${a.message}</span><span class="alert-item-time">${ago}</span></div>`;
    }).join('');
  }

  private timeAgo(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'now';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  private initAlertHistory() {
    const bell = document.getElementById('alert-bell');
    const panel = document.getElementById('alert-history-panel');
    const clearBtn = document.getElementById('alert-clear');
    if (!bell || !panel) return;

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        this.alertUnread = 0;
        this.updateAlertBadge();
        this.renderAlertHistory(); // refresh time-ago
      }
    });

    clearBtn?.addEventListener('click', () => {
      this.alertHistory = [];
      this.alertUnread = 0;
      this.updateAlertBadge();
      this.renderAlertHistory();
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target as Node) && !bell.contains(e.target as Node)) {
        panel.classList.add('hidden');
      }
    });
  }

  // ─── Fix 4: Task Detail Drawer ─────────────────────────────────────

  private currentDetailTaskId: string | null = null;

  initDetailDrawer() {
    const drawer = document.getElementById('task-detail-drawer')!;
    const closeBtn = document.getElementById('task-detail-close')!;
    const titleInput = document.getElementById('task-detail-title') as HTMLInputElement;
    const descInput = document.getElementById('task-detail-desc') as HTMLTextAreaElement;
    const statusSel = document.getElementById('task-detail-status') as HTMLSelectElement;
    const prioritySel = document.getElementById('task-detail-priority') as HTMLSelectElement;
    const spawnBtn = document.getElementById('task-detail-spawn')!;

    const save = () => {
      if (!this.currentDetailTaskId) return;
      const updates: any = {
        title: titleInput.value.trim(),
        description: descInput.value.trim(),
        status: statusSel.value,
        priority: prioritySel.value,
      };
      this.kanban.updateTaskDetails(this.currentDetailTaskId, updates);
    };

    titleInput.addEventListener('blur', save);
    descInput.addEventListener('blur', save);
    statusSel.addEventListener('change', save);
    prioritySel.addEventListener('change', save);

    closeBtn.addEventListener('click', () => this.closeDetailDrawer());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !drawer.classList.contains('hidden')) this.closeDetailDrawer();
    });

    spawnBtn.addEventListener('click', () => {
      if (!this.currentDetailTaskId) return;
      const task = this.kanban.getTasks().find(t => t.id === this.currentDetailTaskId);
      if (task) { this.closeDetailDrawer(); this.addAgentForTask(task); }
    });
  }

  openDetailDrawer(task: { id: string; title: string;[key: string]: any }) {
    this.currentDetailTaskId = task.id;
    const drawer = document.getElementById('task-detail-drawer')!;
    (document.getElementById('task-detail-title') as HTMLInputElement).value = task.title;
    (document.getElementById('task-detail-desc') as HTMLTextAreaElement).value = task.description || '';
    (document.getElementById('task-detail-status') as HTMLSelectElement).value = task.status || 'backlog';
    (document.getElementById('task-detail-priority') as HTMLSelectElement).value = task.priority || 'medium';
    const jiraEl = document.getElementById('task-detail-jira')!;
    jiraEl.textContent = task.jiraKey || '—';
    drawer.classList.remove('hidden');
  }

  closeDetailDrawer() {
    this.currentDetailTaskId = null;
    document.getElementById('task-detail-drawer')?.classList.add('hidden');
  }

  // ─── Fix 5: Palette Dynamic Agent/Task Commands ────────────────────

  private syncPaletteAgentCommands() {
    // Remove and re-add dynamic agent/task commands each time
    this.state.agents.forEach((agent, i) => {
      const id = `goto-agent-${agent.id}`;
      this.palette.unregisterCommand(id);
      this.palette.registerCommand({
        id, icon: '⬡',
        title: `Go to: ${agent.name}`,
        description: `Status: ${agent.status} — press to focus`,
        action: () => { this.terminalManager.setActive(agent.id); this.refreshAgentTabs(); },
        keywords: ['agent', 'terminal', 'focus', String(i + 1)],
      });
    });
    const doingTasks = this.kanban.getTasks().filter((t: any) => t.status === 'doing');
    doingTasks.forEach((task: any) => {
      const id = `focus-task-${task.id}`;
      this.palette.unregisterCommand(id);
      this.palette.registerCommand({
        id, icon: '🔥',
        title: `Active: ${task.title}`,
        description: `In Progress — click to view or spawn agent`,
        action: () => { if (!this.state.kanbanOpen) this.toggleKanban(); this.openDetailDrawer(task); },
        keywords: ['task', 'active', 'doing'],
      });
    });
  }

  // ─── Fix 6: Broadcast Modal ───────────────────────────────────────

  private showBroadcastModal() {
    const terminals = this.terminalManager.getAllTerminals();
    if (terminals.length === 0) { this.showToast('warning', 'No active agents to broadcast to'); return; }

    let modal = document.getElementById('broadcast-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'broadcast-modal';
      modal.className = 'broadcast-modal';
      modal.innerHTML = `
        <div class="broadcast-backdrop"></div>
        <div class="broadcast-dialog">
          <div class="broadcast-header">📡 Broadcast to All Terminals <span class="broadcast-count"></span></div>
          <input class="broadcast-input" placeholder="Enter command to send to all agents..." />
          <div class="broadcast-actions">
            <button class="broadcast-cancel">Cancel</button>
            <button class="broadcast-send">Send to All ⏎</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const backdrop = modal.querySelector('.broadcast-backdrop')!;
      const input = modal.querySelector('.broadcast-input') as HTMLInputElement;
      const sendBtn = modal.querySelector('.broadcast-send')!;
      const cancelBtn = modal.querySelector('.broadcast-cancel')!;

      const send = () => {
        const cmd = input.value.trim();
        if (!cmd) return;
        // Fix #5: get fresh terminal list at send time, not modal creation time
        const currentTerminals = this.terminalManager.getAllTerminals();
        this.terminalManager.broadcastToAll(cmd + '\r');
        this.showToast('success', `📡 Sent to ${currentTerminals.length} terminals: ${cmd}`);
        input.value = '';
        modal!.classList.add('hidden');
      };

      sendBtn.addEventListener('click', send);
      cancelBtn.addEventListener('click', () => modal!.classList.add('hidden'));
      backdrop.addEventListener('click', () => modal!.classList.add('hidden'));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') send();
        if (e.key === 'Escape') modal!.classList.add('hidden');
      });
    }

    modal.querySelector<HTMLElement>('.broadcast-count')!.textContent = `(${terminals.length} agents)`;
    modal.classList.remove('hidden');
    setTimeout(() => (modal!.querySelector('.broadcast-input') as HTMLInputElement).focus(), 50);
  }

  // ─── Fix 8: Agent Nav Tabs ────────────────────────────────────────

  refreshAgentTabs() {
    const tabsEl = document.getElementById('agent-tabs');
    if (!tabsEl) return;
    const activeId = this.terminalManager.getActiveId();
    tabsEl.innerHTML = '';

    for (const agent of this.state.agents) {
      const tab = document.createElement('div');
      tab.className = `agent-tab${agent.id === activeId ? ' active' : ''}`;
      tab.style.setProperty('--tab-color', agent.color);
      tab.dataset.agentId = agent.id;

      // Check if panel has error or activity
      const panel = document.querySelector(`.terminal-panel[data-term-id="${agent.id}"]`);
      const hasError = panel?.querySelector('.panel-header.has-errors') !== null;
      const hasActivity = panel?.querySelector('.panel-header.has-activity') !== null;

      const indicator = hasError
        ? `<span class="agent-tab-error"></span>`
        : hasActivity
          ? `<span class="agent-tab-activity"></span>`
          : '';

      // Fix #14: keyboard accessibility
      tab.setAttribute('tabindex', '0');
      tab.setAttribute('role', 'tab');
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.terminalManager.setActive(agent.id);
          this.refreshAgentTabs();
        }
      });

      tab.innerHTML = `<span class="agent-tab-dot"></span>${agent.name}${indicator}`;
      tab.addEventListener('click', () => {
        this.terminalManager.setActive(agent.id);
        this.refreshAgentTabs();
      });

      // Phase 7: Drag & drop reorder
      tab.setAttribute('draggable', 'true');
      tab.addEventListener('dragstart', (e) => {
        (e as DragEvent).dataTransfer?.setData('text/plain', agent.id);
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
      tab.addEventListener('dragover', (e) => { e.preventDefault(); tab.classList.add('drag-over'); });
      tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        const draggedId = (e as DragEvent).dataTransfer?.getData('text/plain');
        if (!draggedId || draggedId === agent.id) return;
        const fromIdx = this.state.agents.findIndex(a => a.id === draggedId);
        const toIdx = this.state.agents.findIndex(a => a.id === agent.id);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [moved] = this.state.agents.splice(fromIdx, 1);
          this.state.agents.splice(toIdx, 0, moved);
          this.refreshAgentTabs();
          this.scheduleStateSave();
        }
      });

      tabsEl.appendChild(tab);
    }
  }

  // ─── Quotes ────────────────────────────────────────────────────────

  // Phase 7: Git branch display
  private async updateGitBranch() {
    try {
      const result = await window.kaizenBridge.gitBranch();
      const el = document.getElementById('status-git');
      if (el) {
        el.textContent = result.branch ? `⎇ ${result.branch}` : '';
      }
    } catch {
      // Git not available
    }
  }

  // Phase 7: Theme cycling
  // Sprint C: Plugin system initialization
  private initPluginSystem() {
    const api = {
      registerCommand: (id: string, title: string, action: () => void) => {
        this.palette.registerCommand({ id: `plugin:${id}`, icon: '🧩', title, description: 'Plugin command', action, keywords: ['plugin'] });
      },
      addStatusBarItem: (id: string, text: string) => {
        const statusBar = document.getElementById('status-bar');
        if (!statusBar) return;
        const span = document.createElement('span');
        span.id = `plugin-status-${id}`;
        span.className = 'status-item';
        span.textContent = text;
        const spacer = statusBar.querySelector('.status-spacer');
        if (spacer) statusBar.insertBefore(span, spacer);
      },
      updateStatusBarItem: (id: string, text: string) => {
        const el = document.getElementById(`plugin-status-${id}`);
        if (el) el.textContent = text;
      },
      showToast: (type: 'info' | 'success' | 'warning' | 'error', message: string) => this.showToast(type, message),
      getAgents: () => this.state.agents.map(a => ({ id: a.id, name: a.name, status: a.status, color: a.color })),
      getActiveAgentId: () => this.terminalManager.getActiveId(),
      onTerminalData: (cb: (id: string, data: string) => void) => this.pluginManager.on('terminalData', cb),
      onAgentSpawned: (cb: (agent: { id: string; name: string }) => void) => this.pluginManager.on('agentSpawned', cb),
      onAgentRemoved: (cb: (id: string) => void) => this.pluginManager.on('agentRemoved', cb),
    };
    this.pluginManager = new PluginManager(api);
  }

  // Sprint C: List loaded plugins
  private listPlugins() {
    const plugins = this.pluginManager.getLoadedPlugins();
    if (plugins.length === 0) {
      this.showToast('info', '🧩 No plugins loaded. Place JS modules in ~/.kaizen-term/plugins/');
    } else {
      this.showToast('info', `🧩 ${plugins.length} plugins: ${plugins.map(p => p.name).join(', ')}`);
    }
  }

  // Sprint C: Run codebase indexing
  private async runCodebaseIndex() {
    this.showToast('info', '🗂️ Indexing codebase...');
    const root = this.state.scanPaths[0] || '/Users/juancruz/Documents';
    const result = await this.codebaseIndex.indexDirectory(root, 4);
    this.showToast('success', `🗂️ Indexed ${result.files.length} files, ${result.symbols.length} symbols`);
  }

  // Sprint C: Search codebase symbols
  private searchCodebase() {
    const query = prompt('Search symbols:');
    if (!query) return;
    const results = this.codebaseIndex.searchSymbols(query, 10);
    if (results.length === 0) {
      this.showToast('info', `🔎 No symbols found for "${query}"`);
    } else {
      const summary = results.map(r => `${r.kind}:${r.name} (${r.file.split('/').pop()}:${r.line})`).join('\n');
      this.showToast('success', `🔎 Found ${results.length} symbols:\n${summary}`);
    }
  }

  // BYOLLM: Configure AI provider
  private ollamaBanner: HTMLElement | null = null;

  private showOllamaDownloadBanner(progress: { status: string; percent?: number }) {
    if (!this.ollamaBanner) {
      this.ollamaBanner = document.createElement('div');
      this.ollamaBanner.id = 'ollama-download-banner';
      this.ollamaBanner.innerHTML = `
        <span class="ollama-banner-icon">🤖</span>
        <span class="ollama-banner-text">Downloading AI model...</span>
        <div class="ollama-progress-track"><div class="ollama-progress-bar"></div></div>
        <span class="ollama-banner-pct">0%</span>
      `;
      document.body.appendChild(this.ollamaBanner);
    }

    const pct = progress.percent ?? 0;
    const bar = this.ollamaBanner.querySelector('.ollama-progress-bar') as HTMLElement;
    const txt = this.ollamaBanner.querySelector('.ollama-banner-pct') as HTMLElement;
    const label = this.ollamaBanner.querySelector('.ollama-banner-text') as HTMLElement;

    if (bar) bar.style.width = `${pct}%`;
    if (txt) txt.textContent = `${Math.round(pct)}%`;
    if (label) label.textContent = progress.status || 'Downloading AI model...';

    if (pct >= 100 || progress.status?.includes('complete') || progress.status?.includes('ready')) {
      setTimeout(() => {
        this.ollamaBanner?.remove();
        this.ollamaBanner = null;
        this.showToast('success', '🤖 AI model ready! NL→Command enabled.');
      }, 1500);
    }
  }

  private configureTimer() {
    const d = this.timer.getDurations();
    const input = prompt(
      `Timer Durations (minutes)\nFormat: work / break / long break\nCurrent: ${d.work} / ${d.break} / ${d.longBreak}`,
      `${d.work} / ${d.break} / ${d.longBreak}`
    );
    if (!input) return;

    const parts = input.split('/').map(s => parseInt(s.trim(), 10));
    const work = parts[0] || 25;
    const brk = parts[1] || 5;
    const longBrk = parts[2] || 15;

    this.timer.setDurations(work, brk, longBrk);
    this.showToast('success', `⏱ Timer: ${work}min work / ${brk}min break / ${longBrk}min long break`);
    this.scheduleStateSave();
  }

  private configureAI() {
    const providers = ['ollama', 'openai', 'anthropic', 'none'] as const;
    const currentIdx = providers.indexOf(this.state.aiProvider);
    const choice = prompt(
      `AI Provider (type number):\n1. ollama (local, free)\n2. openai (API key required)\n3. anthropic (API key required)\n4. none (disabled)\n\nCurrent: ${this.state.aiProvider}`,
      String(currentIdx + 1)
    );
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < providers.length) {
      this.state.aiProvider = providers[idx];
    }

    const model = prompt('Model name:', this.state.aiModel);
    if (model) this.state.aiModel = model;

    if (this.state.aiProvider === 'ollama') {
      const url = prompt('Ollama base URL:', this.state.aiBaseUrl);
      if (url) this.state.aiBaseUrl = url;
    }

    if (this.state.aiProvider === 'openai' || this.state.aiProvider === 'anthropic') {
      const key = prompt('API Key:', this.state.aiApiKey ? '***' : '');
      if (key && key !== '***') this.state.aiApiKey = key;
    }

    this.scheduleStateSave();
    this.showToast('success', `🤖 AI: ${this.state.aiProvider} / ${this.state.aiModel}`);
  }

  // Phase 10: Workspace Sharing
  private exportWorkspace() {
    const workspace = {
      version: 1,
      name: prompt('Workspace name:', 'my-workspace') || 'my-workspace',
      exportedAt: new Date().toISOString(),
      agents: this.state.agents.map(a => ({
        name: a.name,
        color: a.color,
        cwd: a.cwd,
      })),
      tasks: this.state.tasks.map(t => ({
        title: t.title,
        status: t.status,
      })),
      config: {
        theme: this.state.theme,
        defaultAgentCommand: this.state.defaultAgentCommand,
        aiProvider: this.state.aiProvider,
        aiModel: this.state.aiModel,
        aiBaseUrl: this.state.aiBaseUrl,
        layout: this.state.layout,
      },
    };

    const json = JSON.stringify(workspace, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${workspace.name}.kaizen`;
    a.click();
    URL.revokeObjectURL(url);

    this.showToast('success', `📦 Exported: ${workspace.agents.length} agents, ${workspace.tasks.length} tasks → ${workspace.name}.kaizen`);
  }

  private importWorkspace() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.kaizen,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const workspace = JSON.parse(text);

        if (!workspace.version || !workspace.agents) {
          this.showToast('warning', '⚠ Invalid .kaizen file');
          return;
        }

        // Merge agents (add new ones, skip duplicates by name)
        const existingNames = new Set(this.state.agents.map(a => a.name));
        let addedAgents = 0;
        for (const agent of workspace.agents) {
          if (!existingNames.has(agent.name)) {
            this.state.agents.push({
              id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              name: agent.name,
              color: agent.color || '#00e5ff',
              status: 'idle',
              cwd: agent.cwd || '~',
            });
            addedAgents++;
          }
        }

        // Merge tasks (add all as new)
        let addedTasks = 0;
        for (const task of workspace.tasks || []) {
          this.state.tasks.push({
            id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            title: task.title,
            status: task.status || 'backlog',
            createdAt: Date.now(),
          });
          addedTasks++;
        }

        // Apply config
        if (workspace.config) {
          if (workspace.config.theme) this.state.theme = workspace.config.theme;
          if (workspace.config.defaultAgentCommand) this.state.defaultAgentCommand = workspace.config.defaultAgentCommand;
          if (workspace.config.aiProvider) this.state.aiProvider = workspace.config.aiProvider;
          if (workspace.config.aiModel) this.state.aiModel = workspace.config.aiModel;
          if (workspace.config.layout) this.state.layout = workspace.config.layout;
        }

        this.scheduleStateSave();
        this.showToast('success', `📥 Imported "${workspace.name}": ${addedAgents} agents, ${addedTasks} tasks`);

        // Refresh UI
        this.refreshAgentTabs();
        if (this.state.kanbanOpen) {
          this.kanban?.render();
        }
      } catch (err: any) {
        this.showToast('warning', `⚠ Failed to import: ${err.message}`);
      }
    };
    input.click();
  }

  // Phase 10: First-run onboarding
  private showOnboarding() {
    const overlay = document.getElementById('onboarding-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    let currentStep = 0;
    const steps = overlay.querySelectorAll('.onboarding-step');
    const dots = overlay.querySelectorAll('.onboarding-dots .dot');
    const nextBtn = document.getElementById('onboarding-next') as HTMLButtonElement;

    const goToStep = (idx: number) => {
      steps.forEach(s => s.classList.remove('active'));
      dots.forEach(d => d.classList.remove('active'));
      steps[idx]?.classList.add('active');
      dots[idx]?.classList.add('active');
      currentStep = idx;
      // Change button text on last step
      if (idx === steps.length - 1) {
        nextBtn.textContent = 'Let\'s Go! 🚀';
      } else {
        nextBtn.textContent = 'Next →';
      }
    };

    nextBtn?.addEventListener('click', () => {
      if (currentStep < steps.length - 1) {
        goToStep(currentStep + 1);
      } else {
        // Dismiss
        overlay.classList.add('hidden');
        this.state.onboarded = true;
        this.scheduleStateSave();
      }
    });

    // Click dots to navigate
    dots.forEach((dot, idx) => {
      dot.addEventListener('click', () => goToStep(idx));
    });
  }

  private cycleTheme() {
    const currentIdx = THEMES.findIndex(t => t.name === (this.state.theme || 'midnight'));
    const nextIdx = (currentIdx + 1) % THEMES.length;
    const theme = THEMES[nextIdx];
    this.state.theme = theme.name;
    applyTheme(theme);
    this.scheduleStateSave();
    this.showToast('info', `${theme.label}`);
  }

  private rotateKaizenQuote() {
    const quotes = [
      '改善 — Continuous Improvement', '整理 — Sort and Organize', '清掃 — Shine and Clean',
      '標準化 — Standardize', '躾 — Sustain Discipline', 'Focus on process, not results',
      'Small changes, big impact', 'Eliminate waste, maximize value',
    ];
    const el = document.getElementById('kaizen-quote');
    let i = 0;
    setInterval(() => {
      i = (i + 1) % quotes.length;
      if (el) { el.style.opacity = '0'; setTimeout(() => { el.textContent = quotes[i]; el.style.opacity = '0.6'; }, 300); }
    }, 15000);
  }

  private scheduleStateSave() {
    if (this.saveDebounce) clearTimeout(this.saveDebounce);
    this.saveDebounce = setTimeout(() => saveState(this.state), 500);
  }

  private dismissAiLoadingOverlay() {
    const overlay = document.getElementById('ai-loading-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 600);
  }

  private pollOllamaReady() {
    // Skip if AI is disabled
    if (this.state.aiProvider === 'none') {
      this.dismissAiLoadingOverlay();
      return;
    }

    const statusEl = document.getElementById('ai-loading-status');
    const baseUrl = this.state.aiBaseUrl || 'http://localhost:11434';
    const model = this.state.aiModel || 'qwen2.5-coder:1.5b';
    let attempts = 0;
    const maxAttempts = 120; // 4 minutes max

    const messages = [
      'Starting AI server...',
      'Loading model into memory...',
      'Warming up neural weights...',
      'Almost there...',
    ];

    const check = async () => {
      if (attempts >= maxAttempts) {
        if (statusEl) statusEl.textContent = '⚠ AI took too long — check Ollama';
        setTimeout(() => this.dismissAiLoadingOverlay(), 3000);
        return;
      }

      const msgIdx = Math.min(Math.floor(attempts / 8), messages.length - 1);
      if (statusEl) statusEl.textContent = messages[msgIdx];

      try {
        const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          const json = await resp.json();
          const models: string[] = (json.models || []).map((m: any) => m.name as string);
          const modelReady = models.some(m => m.includes(model.split(':')[0]));
          if (modelReady) {
            if (statusEl) statusEl.textContent = '✅ AI ready!';
            setTimeout(() => this.dismissAiLoadingOverlay(), 800);
            this.updateStatusBar();
            return;
          }
          if (statusEl) statusEl.textContent = `Downloading model (${model})...`;
        }
      } catch {
        // Server not up yet
      }

      attempts++;
      setTimeout(check, 2000);
    };

    check();
  }
}

document.addEventListener('DOMContentLoaded', () => { new KaizenApp(); });
