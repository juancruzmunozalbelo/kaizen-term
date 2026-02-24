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

export class KanbanBoard {
    private tasks: KanbanTask[] = [];
    private containerEl: HTMLElement;
    private onTasksChange?: (tasks: KanbanTask[]) => void;
    private spawnAgentCallback?: SpawnAgentCallback;
    private openDetailCallback?: OpenDetailCallback;
    private draggedTask: KanbanTask | null = null;

    constructor(containerEl: HTMLElement, _initialTasks: KanbanTask[] = []) {
        this.containerEl = containerEl;
        this.init();

        // Load tasks from shared file instead of localStorage
        this.loadFromFile();

        // Listen for live updates (from MCP server writing to file)
        if (bridge?.onTasksUpdated) {
            bridge.onTasksUpdated((tasks: any[]) => {
                this.tasks = this.normalizeFileTasks(tasks);
                this.render();
                this.emitChange();
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
            agentId: t.agentId,
            createdAt: t.createdAt ? new Date(t.createdAt).getTime() : Date.now(),
            // Preserve extra MCP fields
            ...(t.priority && { priority: t.priority }),
            ...(t.description && { description: t.description }),
            ...(t.jiraKey && { jiraKey: t.jiraKey }),
            ...(t.labels && { labels: t.labels }),
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
            description: (t as any).description || '',
            status: t.status,
            priority: (t as any).priority || 'medium',
            agentId: t.agentId,
            labels: (t as any).labels || [],
            jiraKey: (t as any).jiraKey,
            createdAt: new Date(t.createdAt).toISOString(),
            updatedAt: new Date().toISOString(),
        };
    }

    setChangeCallback(cb: (tasks: KanbanTask[]) => void) { this.onTasksChange = cb; }
    setSpawnAgentCallback(cb: SpawnAgentCallback) { this.spawnAgentCallback = cb; }
    setOpenDetailCallback(cb: OpenDetailCallback) { this.openDetailCallback = cb; }

    private init() {
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

    private showInlineAdd(status: KanbanTask['status']) {
        const columnTasks = this.containerEl.querySelector(`.column-tasks[data-status="${status}"]`);
        if (!columnTasks) return;

        const existing = columnTasks.querySelector('.task-inline-add');
        if (existing) existing.remove();

        const wrapper = document.createElement('div');
        wrapper.className = 'task-inline-add';
        wrapper.innerHTML = `<input type="text" class="task-card-title-input" placeholder="Task description..." autofocus />`;
        columnTasks.appendChild(wrapper);

        const input = wrapper.querySelector('input') as HTMLInputElement;
        input.focus();

        const finish = () => {
            const title = input.value.trim();
            if (title) {
                this.addTask(title, status);
            }
            wrapper.remove();
        };

        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') finish();
            if (e.key === 'Escape') { input.value = ''; finish(); }
        });
    }

    addTask(title: string, status: KanbanTask['status'] = 'backlog'): KanbanTask {
        const task: KanbanTask = {
            id: generateId(),
            title,
            status,
            createdAt: Date.now(),
        };
        this.tasks.push(task);
        this.render();
        this.emitChange();
        // Granular IPC: only add the new task, don't overwrite the array
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
            bridge?.updateTask?.(id, { status: newStatus });
        }
    }

    removeTask(id: string) {
        this.tasks = this.tasks.filter(t => t.id !== id);
        this.render();
        this.emitChange();
        // Granular IPC: only delete this specific task
        bridge?.deleteTask?.(id);
    }

    private emitChange() {
        this.onTasksChange?.(this.tasks);
        window.dispatchEvent(new CustomEvent('kaizen-state-change'));
    }

    render() {
        const statuses: KanbanTask['status'][] = ['backlog', 'doing', 'review', 'done'];
        for (const status of statuses) {
            const column = this.containerEl.querySelector(`.column-tasks[data-status="${status}"]`) as HTMLElement;
            if (!column) continue;

            const tasksForStatus = this.tasks.filter(t => t.status === status);
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
        }

        const statusTasks = document.getElementById('status-tasks');
        if (statusTasks) {
            const doing = this.tasks.filter(t => t.status === 'doing').length;
            const done = this.tasks.filter(t => t.status === 'done').length;
            statusTasks.textContent = `${this.tasks.length} tasks (${doing} active, ${done} done)`;
        }
    }

    private createTaskCard(task: KanbanTask): HTMLElement {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.draggable = true;
        card.dataset.taskId = task.id;

        // Show Jira key badge if linked (escaped to prevent XSS)
        const jiraKey = (task as any).jiraKey;
        const jiraBadge = jiraKey ? `<span class="task-jira-badge">${this.escapeHtml(jiraKey)}</span>` : '';

        card.innerHTML = `
      <span class="task-card-title">${this.escapeHtml(task.title)}</span>
      ${jiraBadge}
      <div class="task-card-actions">
        <button class="task-card-spawn" title="Spawn agent for this task">⚡</button>
        <button class="task-card-delete" title="Delete task">✕</button>
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

            const finish = () => {
                const newTitle = input.value.trim() || task.title;
                task.title = newTitle;
                this.render();
                this.emitChange();
                // Granular IPC: only update title
                bridge?.updateTask?.(task.id, { title: newTitle });
            };

            input.addEventListener('blur', finish);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') finish();
                if (e.key === 'Escape') { input.value = task.title; finish(); }
            });
        });

        return card;
    }

    getTasks(): KanbanTask[] {
        return [...this.tasks];
    }

    /** Fix 4: Update task from detail drawer */
    updateTaskDetails(id: string, updates: Partial<KanbanTask & { description: string; priority: string }>) {
        const task = this.tasks.find(t => t.id === id);
        if (!task) return;
        Object.assign(task, updates);
        this.render();
        this.emitChange();
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
