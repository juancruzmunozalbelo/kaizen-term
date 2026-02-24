#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// KaizenTerm MCP Server — Task management via Model Context Protocol
// ═══════════════════════════════════════════════════════════════

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Task Storage ────────────────────────────────────────────────────────────

const TASKS_FILE = path.join(
    process.env.HOME || '/tmp',
    '.kaizen-term',
    'tasks.json'
);

interface Task {
    id: string;
    title: string;
    description: string;
    status: 'backlog' | 'doing' | 'review' | 'done';
    priority: 'low' | 'medium' | 'high' | 'critical';
    agentId?: string;
    labels: string[];
    jiraKey?: string;
    createdAt: string;
    updatedAt: string;
}

function ensureDir() {
    const dir = path.dirname(TASKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTasks(): Task[] {
    ensureDir();
    if (!fs.existsSync(TASKS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function saveTasks(tasks: Task[]) {
    ensureDir();
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function genId(): string {
    return `KZ-${Date.now().toString(36).toUpperCase()}`;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
    {
        name: 'kaizen-term',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
            resources: {},
        },
    }
);

// ─── Tools ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'list_tasks',
            description: 'List all Kaizen tasks, optionally filtered by status or priority',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    status: {
                        type: 'string',
                        description: 'Filter by status: backlog, doing, review, done',
                        enum: ['backlog', 'doing', 'review', 'done'],
                    },
                    priority: {
                        type: 'string',
                        description: 'Filter by priority: low, medium, high, critical',
                        enum: ['low', 'medium', 'high', 'critical'],
                    },
                },
            },
        },
        {
            name: 'create_task',
            description: 'Create a new Kaizen task',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    title: { type: 'string', description: 'Task title' },
                    description: { type: 'string', description: 'Task description' },
                    priority: {
                        type: 'string',
                        description: 'Priority level',
                        enum: ['low', 'medium', 'high', 'critical'],
                    },
                    status: {
                        type: 'string',
                        description: 'Initial status (default: backlog)',
                        enum: ['backlog', 'doing', 'review', 'done'],
                    },
                    labels: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Labels/tags for the task',
                    },
                    jiraKey: {
                        type: 'string',
                        description: 'Optional linked Jira issue key (e.g., PROJ-123)',
                    },
                },
                required: ['title'],
            },
        },
        {
            name: 'update_task',
            description: 'Update an existing task status, priority, or details',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string', description: 'Task ID' },
                    status: {
                        type: 'string',
                        enum: ['backlog', 'doing', 'review', 'done'],
                    },
                    priority: {
                        type: 'string',
                        enum: ['low', 'medium', 'high', 'critical'],
                    },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    agentId: { type: 'string', description: 'Assign to agent' },
                    jiraKey: { type: 'string' },
                },
                required: ['id'],
            },
        },
        {
            name: 'delete_task',
            description: 'Delete a task by ID',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    id: { type: 'string', description: 'Task ID to delete' },
                },
                required: ['id'],
            },
        },
        {
            name: 'get_board_summary',
            description: 'Get a summary of the Kaizen board: counts per status, priorities, and recent activity',
            inputSchema: {
                type: 'object' as const,
                properties: {},
            },
        },
        {
            name: 'import_from_jira',
            description: 'Import tasks from Jira by providing issue keys or JQL results. Creates Kaizen tasks linked to Jira issues.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    issues: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string' },
                                summary: { type: 'string' },
                                description: { type: 'string' },
                                status: { type: 'string' },
                                priority: { type: 'string' },
                            },
                            required: ['key', 'summary'],
                        },
                        description: 'Array of Jira issues to import',
                    },
                },
                required: ['issues'],
            },
        },
        {
            name: 'read_terminal_output',
            description: 'Read the last N lines of a KaizenTerm terminal output. Useful to see build results, test output, or compiler errors from an agent terminal.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    terminalId: { type: 'string', description: 'Terminal/agent ID to read output from' },
                    lines: { type: 'number', description: 'Number of lines to return (default: 50, max: 200)' },
                },
                required: ['terminalId'],
            },
        },
    ],
}));

// ─── Tool Execution ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
        case 'list_tasks': {
            let tasks = loadTasks();
            if (args?.status) tasks = tasks.filter(t => t.status === args.status);
            if (args?.priority) tasks = tasks.filter(t => t.priority === args.priority);

            if (tasks.length === 0) {
                return { content: [{ type: 'text', text: '📋 No tasks found.' }] };
            }

            const statusEmoji: Record<string, string> = {
                backlog: '📥', doing: '🔧', review: '🔍', done: '✅'
            };
            const priorityEmoji: Record<string, string> = {
                low: '🔵', medium: '🟡', high: '🟠', critical: '🔴'
            };

            const lines = tasks.map(t =>
                `${statusEmoji[t.status] || '📌'} ${priorityEmoji[t.priority] || ''} **${t.id}** — ${t.title}${t.jiraKey ? ` [${t.jiraKey}]` : ''}${t.agentId ? ` (Agent: ${t.agentId})` : ''}`
            );

            return {
                content: [{ type: 'text', text: `📋 **Tasks** (${tasks.length})\n\n${lines.join('\n')}` }],
            };
        }

        case 'create_task': {
            const tasks = loadTasks();
            const task: Task = {
                id: genId(),
                title: (args?.title as string) || 'Untitled',
                description: (args?.description as string) || '',
                status: (args?.status as Task['status']) || 'backlog',
                priority: (args?.priority as Task['priority']) || 'medium',
                labels: (args?.labels as string[]) || [],
                jiraKey: args?.jiraKey as string,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            tasks.push(task);
            saveTasks(tasks);

            return {
                content: [{ type: 'text', text: `✅ Created task **${task.id}** — "${task.title}" [${task.status}] ${task.jiraKey ? `linked to ${task.jiraKey}` : ''}` }],
            };
        }

        case 'update_task': {
            const tasks = loadTasks();
            const task = tasks.find(t => t.id === args?.id);
            if (!task) {
                return { content: [{ type: 'text', text: `❌ Task ${args?.id} not found` }] };
            }

            if (args?.status) task.status = args.status as Task['status'];
            if (args?.priority) task.priority = args.priority as Task['priority'];
            if (args?.title) task.title = args.title as string;
            if (args?.description) task.description = args.description as string;
            if (args?.agentId) task.agentId = args.agentId as string;
            if (args?.jiraKey) task.jiraKey = args.jiraKey as string;
            task.updatedAt = new Date().toISOString();

            saveTasks(tasks);
            return {
                content: [{ type: 'text', text: `✏️ Updated task **${task.id}** — "${task.title}" → [${task.status}]` }],
            };
        }

        case 'delete_task': {
            let tasks = loadTasks();
            const before = tasks.length;
            tasks = tasks.filter(t => t.id !== args?.id);
            saveTasks(tasks);

            return {
                content: [{
                    type: 'text',
                    text: before > tasks.length
                        ? `🗑️ Deleted task ${args?.id}`
                        : `❌ Task ${args?.id} not found`,
                }],
            };
        }

        case 'get_board_summary': {
            const tasks = loadTasks();
            const byStatus = { backlog: 0, doing: 0, review: 0, done: 0 };
            const byPriority = { low: 0, medium: 0, high: 0, critical: 0 };

            for (const t of tasks) {
                byStatus[t.status] = (byStatus[t.status] || 0) + 1;
                byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
            }

            const summary = [
                `📊 **Kaizen Board Summary**`,
                ``,
                `📥 Backlog: ${byStatus.backlog}  |  🔧 In Progress: ${byStatus.doing}  |  🔍 Review: ${byStatus.review}  |  ✅ Done: ${byStatus.done}`,
                ``,
                `🔵 Low: ${byPriority.low}  |  🟡 Medium: ${byPriority.medium}  |  🟠 High: ${byPriority.high}  |  🔴 Critical: ${byPriority.critical}`,
                ``,
                `Total: ${tasks.length} tasks`,
            ];

            if (tasks.filter(t => t.jiraKey).length > 0) {
                summary.push(`\n🔗 ${tasks.filter(t => t.jiraKey).length} tasks linked to Jira`);
            }

            return { content: [{ type: 'text', text: summary.join('\n') }] };
        }

        case 'import_from_jira': {
            const issues = args?.issues as any[];
            if (!issues || issues.length === 0) {
                return { content: [{ type: 'text', text: '❌ No issues to import' }] };
            }

            const tasks = loadTasks();
            const imported: string[] = [];

            const jiraStatusMap: Record<string, Task['status']> = {
                'to do': 'backlog',
                'open': 'backlog',
                'in progress': 'doing',
                'in review': 'review',
                'review': 'review',
                'done': 'done',
                'closed': 'done',
                'resolved': 'done',
            };

            const jiraPriorityMap: Record<string, Task['priority']> = {
                'lowest': 'low',
                'low': 'low',
                'medium': 'medium',
                'high': 'high',
                'highest': 'critical',
                'critical': 'critical',
                'blocker': 'critical',
            };

            for (const issue of issues) {
                // Skip if already imported
                if (tasks.some(t => t.jiraKey === issue.key)) {
                    imported.push(`⏭️ ${issue.key} already exists`);
                    continue;
                }

                const task: Task = {
                    id: genId(),
                    title: issue.summary,
                    description: issue.description || '',
                    status: jiraStatusMap[issue.status?.toLowerCase()] || 'backlog',
                    priority: jiraPriorityMap[issue.priority?.toLowerCase()] || 'medium',
                    labels: ['jira-import'],
                    jiraKey: issue.key,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                tasks.push(task);
                imported.push(`✅ ${issue.key} → ${task.id} "${task.title}"`);
            }

            saveTasks(tasks);
            return {
                content: [{ type: 'text', text: `📥 **Imported from Jira**\n\n${imported.join('\n')}` }],
            };
        }

        case 'read_terminal_output': {
            const terminalId = args?.terminalId as string;
            const lineCount = Math.min(Math.max((args?.lines as number) || 50, 1), 200);

            const bufferFile = path.join(
                process.env.HOME || '/tmp',
                '.kaizen-term',
                'terminal-buffers',
                `${terminalId}.log`
            );

            if (!fs.existsSync(bufferFile)) {
                return { content: [{ type: 'text', text: `❌ No output found for terminal "${terminalId}". The terminal may not have produced output yet, or the ID is incorrect.` }] };
            }

            try {
                const content = fs.readFileSync(bufferFile, 'utf-8');
                const allLines = content.split('\n');
                const lines = allLines.slice(-lineCount);
                return {
                    content: [{ type: 'text', text: `📺 **Terminal Output** (${terminalId}, last ${lines.length} lines)\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`` }],
                };
            } catch (err: any) {
                return { content: [{ type: 'text', text: `❌ Failed to read terminal output: ${err.message}` }] };
            }
        }

        default:
            return { content: [{ type: 'text', text: `❌ Unknown tool: ${name}` }] };
    }
});

// ─── Resources ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        {
            uri: 'kaizen://board',
            name: 'Kaizen Board',
            description: 'Current state of the Kaizen task board',
            mimeType: 'application/json',
        },
        {
            uri: 'kaizen://tasks/active',
            name: 'Active Tasks',
            description: 'Tasks currently in progress',
            mimeType: 'application/json',
        },
        {
            uri: 'kaizen://session-log',
            name: 'Session Log',
            description: 'Recent agent lifecycle events (spawns, exits, task updates)',
            mimeType: 'text/plain',
        },
    ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'kaizen://board') {
        const tasks = loadTasks();
        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({
                    backlog: tasks.filter(t => t.status === 'backlog'),
                    doing: tasks.filter(t => t.status === 'doing'),
                    review: tasks.filter(t => t.status === 'review'),
                    done: tasks.filter(t => t.status === 'done'),
                    total: tasks.length,
                }, null, 2),
            }],
        };
    }

    if (uri === 'kaizen://tasks/active') {
        const tasks = loadTasks().filter(t => t.status === 'doing');
        return {
            contents: [{
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(tasks, null, 2),
            }],
        };
    }

    if (uri === 'kaizen://session-log') {
        const logFile = path.join(process.env.HOME || '/tmp', '.kaizen-term', 'session.log');
        let logContent = 'No session log yet.';
        if (fs.existsSync(logFile)) {
            const lines = fs.readFileSync(logFile, 'utf-8').split('\n');
            // Return last 50 events
            logContent = lines.slice(-50).join('\n');
        }
        return {
            contents: [{
                uri,
                mimeType: 'text/plain',
                text: logContent,
            }],
        };
    }

    // Dynamic terminal resources: kaizen://terminal/<id>
    if (uri.startsWith('kaizen://terminal/')) {
        const termId = uri.replace('kaizen://terminal/', '');
        const bufferFile = path.join(process.env.HOME || '/tmp', '.kaizen-term', 'terminal-buffers', `${termId}.log`);

        if (!fs.existsSync(bufferFile)) {
            return {
                contents: [{
                    uri,
                    mimeType: 'text/plain',
                    text: `No output captured for terminal "${termId}"`,
                }],
            };
        }

        return {
            contents: [{
                uri,
                mimeType: 'text/plain',
                text: fs.readFileSync(bufferFile, 'utf-8'),
            }],
        };
    }

    return { contents: [] };
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('🔲 KaizenTerm MCP Server running on stdio');
}

main().catch(console.error);
