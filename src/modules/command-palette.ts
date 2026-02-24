// ===================================================
// KaizenTerm — Command Palette
// ===================================================

interface PaletteCommand {
    id: string;
    icon: string;
    title: string;
    description: string;
    shortcut?: string;
    action: () => void;
    keywords?: string[];
}

export class CommandPalette {
    private commands: PaletteCommand[] = [];
    private paletteEl: HTMLElement;
    private inputEl: HTMLInputElement;
    private resultsEl: HTMLElement;
    private selectedIndex: number = 0;
    private filteredCommands: PaletteCommand[] = [];
    private isOpen: boolean = false;

    constructor() {
        this.paletteEl = document.getElementById('command-palette')!;
        this.inputEl = document.getElementById('palette-input') as HTMLInputElement;
        this.resultsEl = document.getElementById('palette-results')!;

        this.inputEl.addEventListener('input', () => this.filterCommands());
        this.inputEl.addEventListener('keydown', (e) => this.handleKeydown(e));

        // Backdrop click to close
        const backdrop = this.paletteEl.querySelector('.palette-backdrop') as HTMLElement;
        backdrop.addEventListener('click', () => this.close());

        // Global shortcut
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                this.toggle();
            }
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }

    registerCommand(cmd: PaletteCommand) {
        // Prevent duplicates
        this.commands = this.commands.filter(c => c.id !== cmd.id);
        this.commands.push(cmd);
    }

    unregisterCommand(id: string) {
        this.commands = this.commands.filter(c => c.id !== id);
    }

    registerCommands(cmds: PaletteCommand[]) {
        cmds.forEach(cmd => this.registerCommand(cmd));
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        this.isOpen = true;
        this.paletteEl.classList.remove('hidden');
        this.inputEl.value = '';
        this.selectedIndex = 0;
        this.filterCommands();
        // Use setTimeout to ensure the element is visible before focusing
        setTimeout(() => this.inputEl.focus(), 50);
    }

    close() {
        this.isOpen = false;
        this.paletteEl.classList.add('hidden');
        this.inputEl.value = '';
    }

    private filterCommands() {
        const query = this.inputEl.value.toLowerCase().trim();

        if (!query) {
            this.filteredCommands = [...this.commands];
        } else {
            this.filteredCommands = this.commands.filter(cmd => {
                const searchableText = `${cmd.title} ${cmd.description} ${(cmd.keywords || []).join(' ')}`.toLowerCase();
                return query.split(' ').every(word => searchableText.includes(word));
            });
        }

        this.selectedIndex = 0;
        this.renderResults();
    }

    private renderResults() {
        this.resultsEl.innerHTML = '';

        if (this.filteredCommands.length === 0) {
            this.resultsEl.innerHTML = '<li class="palette-item"><div class="palette-item-content"><span class="palette-item-title" style="color: var(--text-muted)">No matching commands</span></div></li>';
            return;
        }

        this.filteredCommands.forEach((cmd, i) => {
            const li = document.createElement('li');
            li.className = `palette-item${i === this.selectedIndex ? ' selected' : ''}`;
            li.innerHTML = `
        <span class="palette-item-icon">${cmd.icon}</span>
        <div class="palette-item-content">
          <div class="palette-item-title">${cmd.title}</div>
          <div class="palette-item-desc">${cmd.description}</div>
        </div>
        ${cmd.shortcut ? `<span class="palette-item-shortcut">${cmd.shortcut}</span>` : ''}
      `;

            li.addEventListener('click', () => {
                cmd.action();
                this.close();
            });

            li.addEventListener('mouseenter', () => {
                this.selectedIndex = i;
                this.updateSelection();
            });

            this.resultsEl.appendChild(li);
        });
    }

    private updateSelection() {
        const items = this.resultsEl.querySelectorAll('.palette-item');
        items.forEach((item, i) => {
            item.classList.toggle('selected', i === this.selectedIndex);
        });
    }

    private handleKeydown(e: KeyboardEvent) {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredCommands.length - 1);
                this.updateSelection();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
                this.updateSelection();
                break;
            case 'Enter':
                e.preventDefault();
                if (this.filteredCommands[this.selectedIndex]) {
                    this.filteredCommands[this.selectedIndex].action();
                    this.close();
                }
                break;
        }
    }
}
