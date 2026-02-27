// ===================================================
// KaizenTerm — Kanban Board Module (IPC-backed)
// ===================================================
// Tasks are stored in ~/.kaizen-term/tasks.json (shared with MCP server).
// The main process watches the file and pushes updates via IPC.

import type { KanbanTask } from './state';
import { generateId } from './state';

type SpawnAgentCallback = (task: KanbanTask) => void;
type OpenDetailCallback = (task: KanbanTask) => void;

let bridge: typeof window.kaizenBridge | null = null;
try { bridge = window.kaizenBridge; } catch { }

const PRIORITY_META: Record<string, { dot: string; color: string; label: string }> = {
    low: { dot: '🔵', color: 'var(--text-muted)', label: 'Low' },
    medium: { dot: '🟡', color: 'var(--agent-amber)', label: 'Medium' },
    high: { dot: '🟠', color: '#ff8c00', label: 'High' },
    critical: { dot: '🔴', color: 'var(--agent-magenta)', label: 'Critical' },
};

export class KanbanBoard {
    private tasks: KanbanTask[] = [];
    private containerEl: HTMLElement;
    private onTasksChange?: (tasks: KanbanTask[]) => void;
    private spawnAgentCallback?: SpawnAgentCallback;
    private openDetailCallback?: OpenDetailCallback;
    private draggedTask: KanbanTask | null = null;
    private filterText: string = '';
    private filterPriority: string = '';

    private pendingWrite = false;

    constructor(containerEl: HTMLElement, _initialTasks: KanbanTask[] = []) {
        this.containerEl = containerEl;
        this.init();

        // Load tasks from shared file instead of localStorage
        this.loadFromFile();

        // Listen for live updates (from MCP server writing to file)
        if (bridge?.onTasksUpdated) {
            bridge.onTasksUpdated((tasks: any[]) => {
                // Skip if we just wrote to the file ourselves
                if (this.pendingWrite) {
                    this.pendingWrite = false;
                    return;
                }
                const normalized = this.normalizeFileTasks(tasks);
                // Only update if task set actually changed (avoid feedback loop)
                const currentIds = this.tasks.map(t => t.id).sort().join(',');
                const newIds = normalized.map(t => t.id).sort().join(',');
                if (currentIds === newIds && this.tasks.length === normalized.length) return;
                this.tasks = normalized;
                this.render();
                this.onTasksChange?.(this.tasks);
            });
        }
    }

    /** Load tasks from ~/.kaizen-term/tasks.json via IPC */
    private async loadFromFile() {
        if (!bridge?.loadTasks) {
            // Fallback: no bridge (e.g., running in browser for testing)
            this.render();
            return;
        }
        try {
            const fileTasks = await bridge.loadTasks();
            this.tasks = this.normalizeFileTasks(fileTasks || []);
            this.render();
        } catch {
            this.render();
        }
    }

    /** Normalize MCP-format tasks to KanbanTask format */
    private normalizeFileTasks(fileTasks: any[]): KanbanTask[] {
        return fileTasks.map(t => ({
            id: t.id || generateId(),
            title: t.title || 'Untitled',
            status: this.mapStatus(t.status),
            priority: t.priority || 'medium',
            description: t.description || '',
            labels: t.labels || [],
            jiraKey: t.jiraKey,
            agentId: t.agentId,
            createdAt: t.createdAt ? new Date(t.createdAt).getTime() : Date.now(),
        }));
    }

    /** Map various status strings to our Kanban statuses */
    private mapStatus(status: string): KanbanTask['status'] {
        const map: Record<string, KanbanTask['status']> = {
            backlog: 'backlog',
            doing: 'doing',
            'in progress': 'doing',
            review: 'review',
            'in review': 'review',
            done: 'done',
        };
        return map[status?.toLowerCase()] || 'backlog';
    }

    /** Convert a KanbanTask to MCP-compatible format */
    private toMcpFormat(t: KanbanTask) {
        return {
            id: t.id,
            title: t.title,
            description: t.description || '',
            status: t.status,
            priority: t.priority || 'medium',
            agentId: t.agentId,
            labels: t.labels || [],
            jiraKey: t.jiraKey,
            createdAt: new Date(t.createdAt).toISOString(),
            updatedAt: new Date().toISOString(),
        };
    }

    setChangeCallback(cb: (tasks: KanbanTask[]) => void) { this.onTasksChange = cb; }
    setSpawnAgentCallback(cb: SpawnAgentCallback) { this.spawnAgentCallback = cb; }
    setOpenDetailCallback(cb: OpenDetailCallback) { this.openDetailCallback = cb; }

    private init() {
        // Filter bar
        const columnsEl = this.containerEl.querySelector('.kanban-columns');
        if (columnsEl && !this.containerEl.querySelector('.kanban-filter-bar')) {
            const bar = document.createElement('div');
            bar.className = 'kanban-filter-bar';
            bar.innerHTML = `
                <input type="text" class="kanban-filter-input" placeholder="Filter tasks…" />
                <div class="kanban-filter-priorities">
                    <button class="filter-priority-btn" data-priority="" title="All">All</button>
                    <button class="filter-priority-btn" data-priority="critical" title="Critical">🔴</button>
                    <button class="filter-priority-btn" data-priority="high" title="High">🟠</button>
                    <button class="filter-priority-btn" data-priority="medium" title="Medium">🟡</button>
                    <button class="filter-priority-btn" data-priority="low" title="Low">🔵</button>
                </div>
            `;
            columnsEl.parentElement?.insertBefore(bar, columnsEl);

            const filterInput = bar.querySelector('.kanban-filter-input') as HTMLInputElement;
            filterInput.addEventListener('input', () => {
                this.filterText = filterInput.value.toLowerCase();
                this.render();
            });

            bar.querySelectorAll('.filter-priority-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const p = (btn as HTMLElement).dataset.priority || '';
                    this.filterPriority = p;
                    bar.querySelectorAll('.filter-priority-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.render();
                });
            });
            // Default: "All" is active
            bar.querySelector('.filter-priority-btn')?.classList.add('active');
        }

        const addBtns = this.containerEl.querySelectorAll('.add-task-btn');
        addBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const status = (e.currentTarget as HTMLElement).dataset.status as KanbanTask['status'];
                this.showInlineAdd(status);
            });
        });

        const columns = this.containerEl.querySelectorAll('.column-tasks');
        columns.forEach(col => {
            col.addEventListener('dragover', (e) => {
                e.preventDefault();
                (col as HTMLElement).classList.add('drag-over');
            });
            col.addEventListener('dragleave', () => {
                (col as HTMLElement).classList.remove('drag-over');
            });
            col.addEventListener('drop', (e) => {
                e.preventDefault();
                (col as HTMLElement).classList.remove('drag-over');
                if (this.draggedTask) {
                    const newStatus = (col as HTMLElement).dataset.status as KanbanTask['status'];
                    this.moveTask(this.draggedTask.id, newStatus);
                    this.draggedTask = null;
                }
            });
        });
    }

    // ─── Enhanced Inline Add ──────────────────────────────────────────────

    private showInlineAdd(status: KanbanTask['status']) {
        const columnTasks = this.containerEl.querySelector(`.column-tasks[data-status="${status}"]`);
        if (!columnTasks) return;

        const existing = columnTasks.querySelector('.task-inline-add');
        if (existing) existing.remove();

        let selectedPriority: KanbanTask['priority'] = 'medium';

        const wrapper = document.createElement('div');
        wrapper.className = 'task-inline-add';
        wrapper.innerHTML = `
            <input type="text" class="task-card-title-input" placeholder="Task title..." autofocus />
            <div class="inline-add-row">
                <div class="inline-priority-picker">
                    <button class="priority-dot-btn" data-priority="low" title="Low"><span class="priority-dot priority-low"></span></button>
                    <button class="priority-dot-btn selected" data-priority="medium" title="Medium"><span class="priority-dot priority-medium"></span></button>
                    <button class="priority-dot-btn" data-priority="high" title="High"><span class="priority-dot priority-high"></span></button>
                    <button class="priority-dot-btn" data-priority="critical" title="Critical"><span class="priority-dot priority-critical"></span></button>
                </div>
                <span class="inline-add-hint">↵ Enter</span>
            </div>
        `;
        columnTasks.appendChild(wrapper);

        const input = wrapper.querySelector('input') as HTMLInputElement;
        input.focus();

        // Priority picker
        const priorityBtns = wrapper.querySelectorAll('.priority-dot-btn');
        priorityBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                priorityBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                selectedPriority = (btn as HTMLElement).dataset.priority as KanbanTask['priority'];
                input.focus(); // Keep focus on input
            });
        });

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            const title = input.value.trim();
            if (title) {
                this.addTask(title, status, selectedPriority);
            }
            wrapper.remove();
        };

        input.addEventListener('blur', (e) => {
            // Don't close if clicking on priority buttons
            const related = e.relatedTarget as HTMLElement;
            if (related && wrapper.contains(related)) return;
            setTimeout(() => {
                if (!finished && !wrapper.contains(document.activeElement)) finish();
            }, 100);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(); }
            if (e.key === 'Escape') { input.value = ''; finish(); }
        });
    }

    addTask(title: string, status: KanbanTask['status'] = 'backlog', priority: KanbanTask['priority'] = 'medium'): KanbanTask {
        const task: KanbanTask = {
            id: generateId(),
            title,
            status,
            priority,
            description: '',
            labels: [],
            createdAt: Date.now(),
        };
        this.tasks.push(task);
        this.render();
        this.emitChange();
        // Granular IPC: only add the new task, don't overwrite the array
        this.pendingWrite = true;
        bridge?.addTask?.(this.toMcpFormat(task));
        return task;
    }

    moveTask(id: string, newStatus: KanbanTask['status']) {
        const task = this.tasks.find(t => t.id === id);
        if (task) {
            task.status = newStatus;
            this.render();
            this.emitChange();
            // Granular IPC: only update this task's status
            this.pendingWrite = true;
            bridge?.updateTask?.(id, { status: newStatus });
        }
    }

    removeTask(id: string) {
        this.tasks = this.tasks.filter(t => t.id !== id);
        this.render();
        this.emitChange();
        // Granular IPC: only delete this specific task
        this.pendingWrite = true;
        bridge?.deleteTask?.(id);
    }

    private emitChange() {
        this.onTasksChange?.(this.tasks);
        window.dispatchEvent(new CustomEvent('kaizen-state-change'));
    }

    // ─── Render ──────────────────────────────────────────────────────────

    render() {
        const statuses: KanbanTask['status'][] = ['backlog', 'doing', 'review', 'done'];
        for (const status of statuses) {
            const column = this.containerEl.querySelector(`.column-tasks[data-status="${status}"]`) as HTMLElement;
            if (!column) continue;

            let tasksForStatus = this.tasks.filter(t => t.status === status);

            // Apply filters
            if (this.filterText) {
                tasksForStatus = tasksForStatus.filter(t =>
                    t.title.toLowerCase().includes(this.filterText) ||
                    (t.description || '').toLowerCase().includes(this.filterText) ||
                    (t.labels || []).some(l => l.toLowerCase().includes(this.filterText))
                );
            }
            if (this.filterPriority) {
                tasksForStatus = tasksForStatus.filter(t => (t.priority || 'medium') === this.filterPriority);
            }

            const inlineAdd = column.querySelector('.task-inline-add');

            column.innerHTML = '';

            if (tasksForStatus.length === 0 && !inlineAdd) {
                column.innerHTML = '<div class="column-empty">No tasks</div>';
            } else {
                tasksForStatus.forEach(task => {
                    const card = this.createTaskCard(task);
                    column.appendChild(card);
                });
            }

            if (inlineAdd) column.appendChild(inlineAdd);

            // Update column count in header
            const colEl = column.closest('.kanban-column');
            const countBadge = colEl?.querySelector('.column-count') as HTMLElement;
            if (countBadge) {
                countBadge.textContent = `${tasksForStatus.length}`;
                countBadge.style.display = tasksForStatus.length > 0 ? '' : 'none';
            }
        }

        const statusTasks = document.getElementById('status-tasks');
        if (statusTasks) {
            const doing = this.tasks.filter(t => t.status === 'doing').length;
            const done = this.tasks.filter(t => t.status === 'done').length;
            statusTasks.textContent = `${this.tasks.length} tasks (${doing} active, ${done} done)`;
        }
    }

    // ─── Card Creation ───────────────────────────────────────────────────

    private createTaskCard(task: KanbanTask): HTMLElement {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.draggable = true;
        card.dataset.taskId = task.id;

        // Priority dot
        const priority = task.priority || 'medium';
        const pMeta = PRIORITY_META[priority] || PRIORITY_META.medium;

        // Jira badge
        const jiraBadge = task.jiraKey
            ? `<span class="task-jira-badge">${this.escapeHtml(task.jiraKey)}</span>`
            : '';

        // Description preview (first line, max 60 chars)
        const descPreview = task.description
            ? this.escapeHtml(task.description.split('\n')[0].slice(0, 60))
            : '';

        // Labels
        const labelsHtml = (task.labels || []).slice(0, 3).map(l =>
            `<span class="task-label">${this.escapeHtml(l)}</span>`
        ).join('');

        // Task age
        const age = this.formatAge(task.createdAt);

        // Due date badge
        let dueBadge = '';
        if (task.dueDate) {
            const now = Date.now();
            const diff = task.dueDate - now;
            const dueDate = new Date(task.dueDate);
            const dateStr = `${dueDate.getMonth() + 1}/${dueDate.getDate()}`;
            if (diff < 0) {
                dueBadge = `<span class="task-due-badge overdue">🔴 ${dateStr}</span>`;
            } else if (diff < 86400000) {
                dueBadge = `<span class="task-due-badge today">🟡 ${dateStr}</span>`;
            } else {
                dueBadge = `<span class="task-due-badge">${dateStr}</span>`;
            }
        }

        // Subtask progress
        let subtaskBadge = '';
        if (task.subtasks && task.subtasks.length > 0) {
            const done = task.subtasks.filter((s: any) => s.done).length;
            const total = task.subtasks.length;
            const color = done === total ? 'var(--agent-green)' : 'var(--text-muted)';
            subtaskBadge = `<span class="task-subtask-badge" style="color:${color}">☑ ${done}/${total}</span>`;
        }

        card.innerHTML = `
            <div class="task-card-row">
                <span class="priority-dot priority-${priority}" title="${pMeta.label} priority"></span>
                <span class="task-card-title">${this.escapeHtml(task.title)}</span>
            </div>
            ${descPreview ? `<div class="task-card-desc">${descPreview}</div>` : ''}
            <div class="task-card-footer">
                <div class="task-card-tags">
                    ${jiraBadge}
                    ${labelsHtml}
                    ${dueBadge}
                    ${subtaskBadge}
                </div>
                <div class="task-card-meta-right">
                    <span class="task-card-age">${age}</span>
                    <div class="task-card-actions">
                        <button class="task-card-spawn" title="Spawn agent for this task">⚡</button>
                        <button class="task-card-delete" title="Delete task">✕</button>
                    </div>
                </div>
            </div>
        `;

        // Single-click: open detail drawer
        card.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            this.openDetailCallback?.(task);
        });

        card.addEventListener('dragstart', (e) => {
            this.draggedTask = task;
            card.classList.add('dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
            }
        });

        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            this.draggedTask = null;
        });

        const spawnBtn = card.querySelector('.task-card-spawn') as HTMLElement;
        spawnBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.spawnAgentCallback?.(task);
        });

        const deleteBtn = card.querySelector('.task-card-delete') as HTMLElement;
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeTask(task.id);
        });

        const titleEl = card.querySelector('.task-card-title') as HTMLElement;
        titleEl.addEventListener('dblclick', () => {
            const input = document.createElement('input');
            input.className = 'task-card-title-input';
            input.value = task.title;
            titleEl.replaceWith(input);
            input.focus();
            input.select();

            let editDone = false;
            const finish = () => {
                if (editDone) return;
                editDone = true;
                const newTitle = input.value.trim() || task.title;
                task.title = newTitle;
                this.render();
                this.emitChange();
                // Granular IPC: only update title
                this.pendingWrite = true;
                bridge?.updateTask?.(task.id, { title: newTitle });
            };

            input.addEventListener('blur', finish);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); finish(); }
                if (e.key === 'Escape') { input.value = task.title; finish(); }
            });
        });

        return card;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    private formatAge(timestamp: number): string {
        const diff = Date.now() - timestamp;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        const days = Math.floor(hrs / 24);
        return `${days}d`;
    }

    getTasks(): KanbanTask[] {
        return [...this.tasks];
    }

    /** Update task from detail drawer */
    updateTaskDetails(id: string, updates: Partial<KanbanTask>) {
        const task = this.tasks.find(t => t.id === id);
        if (!task) return;
        Object.assign(task, updates);
        this.render();
        this.emitChange();
        this.pendingWrite = true;
        bridge?.updateTask?.(id, updates);
    }

    setTasks(tasks: KanbanTask[]) {
        this.tasks = tasks;
        this.render();
        // Bulk save only used for external full-set operations (e.g., import)
        bridge?.saveTasks?.(tasks.map(t => this.toMcpFormat(t)));
    }

    private escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}
