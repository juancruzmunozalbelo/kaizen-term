// ===================================================
// KaizenTerm — State Management
// ===================================================

export interface AgentConfig {
    id: string;
    name: string;
    color: string;
    status: 'idle' | 'working' | 'done' | 'error';
    cwd: string;
}

export interface KanbanTask {
    id: string;
    title: string;
    status: 'backlog' | 'doing' | 'review' | 'done';
    priority?: 'low' | 'medium' | 'high' | 'critical';
    description?: string;
    labels?: string[];
    jiraKey?: string;
    agentId?: string;
    createdAt: number;
}

export interface AppState {
    layout: 1 | 2 | 3 | 4 | 6;
    agents: AgentConfig[];
    tasks: KanbanTask[];
    kanbanOpen: boolean;
    toolsOpen: boolean;
    zenMode: boolean;
    timerRunning: boolean;
    timerSeconds: number;
    timerCycles: number;
    isBreak: boolean;
    sessionStart: number;
    scanPaths: string[];
    toolUsage: Record<string, number>;
    defaultAgentCommand: string;
    theme: string;
    splitRatios: number[];
    omniHistory: Array<{ role: string; text: string }>;
    // AI provider config (BYOLLM)
    aiProvider: 'ollama' | 'openai' | 'anthropic' | 'none';
    aiModel: string;
    aiBaseUrl: string;
    aiApiKey: string;
    onboarded: boolean;
}

const STORAGE_KEY = 'kaizen-term-state';

const AGENT_COLORS = [
    '#00e5ff', // cyan
    '#ff006e', // magenta
    '#ffbe0b', // amber
    '#06d6a0', // green
    '#a855f7', // purple
    '#f472b6', // rose
];

export function getAgentColor(index: number): string {
    return AGENT_COLORS[index % AGENT_COLORS.length];
}

export function createDefaultState(): AppState {
    return {
        layout: 1,
        agents: [],
        tasks: [],
        kanbanOpen: false,
        toolsOpen: false,
        zenMode: false,
        timerRunning: false,
        timerSeconds: 25 * 60,
        timerCycles: 0,
        isBreak: false,
        sessionStart: Date.now(),
        scanPaths: ['/Users/juancruz/Documents', '/Users/juancruz/nanoclaw'],
        toolUsage: {},
        defaultAgentCommand: '',
        theme: 'midnight',
        splitRatios: [],
        omniHistory: [],
        aiProvider: 'ollama',
        aiModel: 'qwen2.5-coder:1.5b',
        aiBaseUrl: 'http://localhost:11434',
        aiApiKey: '',
        onboarded: false,
    };
}

export function loadState(): AppState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            return {
                ...createDefaultState(),
                ...saved,
                sessionStart: Date.now(), // always reset session timer
                timerRunning: false, // never auto-resume timer
            };
        }
    } catch { /* use defaults */ }
    return createDefaultState();
}

export function saveState(state: AppState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            layout: state.layout,
            agents: state.agents.map(a => ({ ...a, status: 'idle' as const })),
            // NOTE: tasks are no longer stored in localStorage.
            // They live in ~/.kaizen-term/tasks.json (shared with MCP server).
            kanbanOpen: state.kanbanOpen,
            toolsOpen: state.toolsOpen,
            timerCycles: state.timerCycles,
            scanPaths: state.scanPaths,
            toolUsage: state.toolUsage,
        }));
    } catch { /* ignore */ }
}

export function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAgent(state: AppState, name?: string): AgentConfig {
    const index = state.agents.length;
    const agent: AgentConfig = {
        id: generateId(),
        name: name || `Agent ${index + 1}`,
        color: getAgentColor(index),
        status: 'idle',
        cwd: state.scanPaths[0] || '/Users/juancruz/Documents',
    };
    return agent;
}
