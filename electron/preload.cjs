const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kaizenBridge', {
    // Terminal
    spawnTerminal: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    writeTerminal: (id, data) => ipcRenderer.send('pty:write', { id, data }),
    resizeTerminal: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
    killTerminal: (id) => ipcRenderer.send('pty:kill', { id }),
    onTerminalData: (callback) => {
        ipcRenderer.on('pty:data', (event, { id, data }) => callback(id, data));
    },
    onTerminalExit: (callback) => {
        ipcRenderer.on('pty:exit', (event, { id, exitCode }) => callback(id, exitCode));
    },
    readTerminalOutput: (id) => ipcRenderer.invoke('pty:readOutput', id),

    // Tasks (shared with MCP server via ~/.kaizen-term/tasks.json)
    loadTasks: () => ipcRenderer.invoke('tasks:load'),
    saveTasks: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
    addTask: (task) => ipcRenderer.invoke('tasks:add', task),
    updateTask: (id, updates) => ipcRenderer.invoke('tasks:update', { id, updates }),
    deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
    onTasksUpdated: (callback) => {
        ipcRenderer.on('tasks:updated', (event, tasks) => callback(tasks));
    },

    // Discovery
    discoverSkills: (paths) => ipcRenderer.invoke('discover:skills', paths),
    discoverMCP: (paths) => ipcRenderer.invoke('discover:mcp', paths),

    // Filesystem (secured — restricted to allowed paths)
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),

    // Error notifications from main process
    onAppError: (callback) => {
        ipcRenderer.on('app:error', (event, message) => callback(message));
    },

    // Ollama download progress
    onOllamaProgress: (callback) => {
        ipcRenderer.on('ollama:progress', (event, progress) => callback(progress));
    },

    // Git
    gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),

    // Dialog
    openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
    saveFileDialog: (defaultName, content) => ipcRenderer.invoke('dialog:saveFile', { defaultName, content }),

    // MCP Process Management
    startMCP: (name, command, args) => ipcRenderer.invoke('mcp:start', { name, command, args }),
    stopMCP: (name) => ipcRenderer.invoke('mcp:stop', { name }),
    getMCPStatus: () => ipcRenderer.invoke('mcp:status'),
});
