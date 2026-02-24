// ===================================================
// KaizenTerm — Codebase Index (Phase 7, Sprint C)
// ===================================================
//
// Lightweight codebase indexer that builds a symbol map
// of the project for AI/MCP context enrichment.
// Uses readFile/listDir from the Electron bridge.
//

interface FileSymbol {
    file: string;
    name: string;
    kind: 'function' | 'class' | 'export' | 'import' | 'type' | 'variable';
    line: number;
}

interface IndexState {
    files: string[];
    symbols: FileSymbol[];
    lastUpdated: number;
}

// Patterns for quick symbol extraction (no AST, just regex)
const SYMBOL_PATTERNS: Array<{ re: RegExp; kind: FileSymbol['kind'] }> = [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    { re: /^(?:export\s+)?class\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/gm, kind: 'variable' },
    { re: /^(?:export\s+)?(?:interface|type)\s+(\w+)/gm, kind: 'type' },
    { re: /^export\s+default\s+(?:class|function)?\s*(\w*)/gm, kind: 'export' },
];

const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
    '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.cs',
]);

export class CodebaseIndex {
    private bridge = window.kaizenBridge;
    private index: IndexState = { files: [], symbols: [], lastUpdated: 0 };
    private indexing = false;

    async indexDirectory(rootPath: string, maxDepth = 3): Promise<IndexState> {
        if (this.indexing) return this.index;
        this.indexing = true;

        try {
            this.index = { files: [], symbols: [], lastUpdated: Date.now() };
            await this.walkDir(rootPath, 0, maxDepth);
            console.log(`[CodebaseIndex] Indexed ${this.index.files.length} files, ${this.index.symbols.length} symbols`);
        } catch (err) {
            console.error('[CodebaseIndex] Indexing failed:', err);
        } finally {
            this.indexing = false;
        }

        return this.index;
    }

    private async walkDir(dirPath: string, depth: number, maxDepth: number) {
        if (depth >= maxDepth) return;

        try {
            const entries = await this.bridge.listDir(dirPath);

            for (const entry of entries) {
                const fullPath = `${dirPath}/${entry.name}`;

                // Skip hidden dirs and node_modules
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;

                if (entry.isDir) {
                    await this.walkDir(fullPath, depth + 1, maxDepth);
                } else {
                    const ext = entry.name.substring(entry.name.lastIndexOf('.'));
                    if (CODE_EXTENSIONS.has(ext)) {
                        this.index.files.push(fullPath);
                        await this.indexFile(fullPath);
                    }
                }
            }
        } catch {
            // Access denied or read error
        }
    }

    private async indexFile(filePath: string) {
        try {
            const content = await this.bridge.readFile(filePath);
            if (!content) return;

            for (const pattern of SYMBOL_PATTERNS) {
                // Reset regex state
                pattern.re.lastIndex = 0;
                let match;
                while ((match = pattern.re.exec(content)) !== null) {
                    const name = match[1];
                    if (name && name.length > 1) {
                        // Count newlines before match to get line number
                        const line = content.substring(0, match.index).split('\n').length;
                        this.index.symbols.push({
                            file: filePath,
                            name,
                            kind: pattern.kind,
                            line,
                        });
                    }
                }
            }
        } catch {
            // File read error
        }
    }

    /** Search symbols by name */
    searchSymbols(query: string, limit = 20): FileSymbol[] {
        const q = query.toLowerCase();
        return this.index.symbols
            .filter(s => s.name.toLowerCase().includes(q))
            .slice(0, limit);
    }

    /** Search files by name */
    searchFiles(query: string, limit = 20): string[] {
        const q = query.toLowerCase();
        return this.index.files
            .filter(f => f.toLowerCase().includes(q))
            .slice(0, limit);
    }

    /** Get full index summary for MCP context */
    getSummary(): string {
        const grouped = new Map<string, string[]>();
        for (const sym of this.index.symbols) {
            const key = sym.file;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(`  ${sym.kind}: ${sym.name} (L${sym.line})`);
        }

        let summary = `# Codebase Index (${this.index.files.length} files, ${this.index.symbols.length} symbols)\n\n`;
        for (const [file, syms] of grouped) {
            summary += `## ${file}\n${syms.join('\n')}\n\n`;
        }
        return summary;
    }

    getStats() {
        return {
            files: this.index.files.length,
            symbols: this.index.symbols.length,
            lastUpdated: this.index.lastUpdated,
        };
    }
}
