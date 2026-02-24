// ===================================================
// KaizenTerm — Plugin API (Phase 7, Sprint C)
// ===================================================
//
// Plugin interface for extending KaizenTerm without
// modifying source code. Plugins are loaded from
// ~/.kaizen-term/plugins/ as ES modules.
//

// (No external imports needed)

/** Plugin lifecycle interface */
export interface KaizenPlugin {
    name: string;
    version: string;
    description?: string;
    init(api: KaizenPluginAPI): void | Promise<void>;
    dispose?(): void;
}

/** Restricted API surface exposed to plugins */
export interface KaizenPluginAPI {
    // Commands
    registerCommand(id: string, title: string, action: () => void): void;

    // Status Bar
    addStatusBarItem(id: string, text: string): void;
    updateStatusBarItem(id: string, text: string): void;

    // Notifications
    showToast(type: 'info' | 'success' | 'warning' | 'error', message: string): void;

    // Terminal Data (read-only)
    getAgents(): Array<{ id: string; name: string; status: string; color: string }>;
    getActiveAgentId(): string | null;

    // Events
    onTerminalData(callback: (id: string, data: string) => void): void;
    onAgentSpawned(callback: (agent: { id: string; name: string }) => void): void;
    onAgentRemoved(callback: (id: string) => void): void;
}

/** Plugin registry and loader */
export class PluginManager {
    private plugins: Map<string, KaizenPlugin> = new Map();
    private api: KaizenPluginAPI;
    private eventListeners: Map<string, Array<(...args: any[]) => void>> = new Map();

    constructor(api: KaizenPluginAPI) {
        this.api = api;
    }

    /** Load a plugin from a module */
    async loadPlugin(plugin: KaizenPlugin): Promise<boolean> {
        if (this.plugins.has(plugin.name)) {
            console.warn(`[KaizenPlugins] Plugin "${plugin.name}" already loaded`);
            return false;
        }

        try {
            await plugin.init(this.api);
            this.plugins.set(plugin.name, plugin);
            console.log(`[KaizenPlugins] Loaded: ${plugin.name} v${plugin.version}`);
            return true;
        } catch (err) {
            console.error(`[KaizenPlugins] Failed to load ${plugin.name}:`, err);
            return false;
        }
    }

    /** Unload a plugin */
    unloadPlugin(name: string): boolean {
        const plugin = this.plugins.get(name);
        if (!plugin) return false;
        try {
            plugin.dispose?.();
        } catch { /* ignore */ }
        this.plugins.delete(name);
        console.log(`[KaizenPlugins] Unloaded: ${name}`);
        return true;
    }

    /** List all loaded plugins */
    getLoadedPlugins(): Array<{ name: string; version: string; description?: string }> {
        return Array.from(this.plugins.values()).map(p => ({
            name: p.name,
            version: p.version,
            description: p.description,
        }));
    }

    /** Unload all plugins */
    disposeAll() {
        this.plugins.forEach(p => {
            try { p.dispose?.(); } catch { /* ignore */ }
        });
        this.plugins.clear();
        this.eventListeners.clear();
    }

    /** Emit an event to all plugin listeners */
    emit(event: string, ...args: any[]) {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            for (const cb of listeners) {
                try { cb(...args); } catch { /* ignore */ }
            }
        }
    }

    /** Register an event listener (used by plugin API) */
    on(event: string, callback: (...args: any[]) => void) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(callback);
    }
}
