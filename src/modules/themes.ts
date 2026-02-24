// ===================================================
// KaizenTerm — Theme Engine (Operation Modes)
// ===================================================
// Themes are not cosmetic preferences — they're operation modes.
// Each adapts the interface to your context and energy level.

export interface KaizenTheme {
    name: string;
    label: string;
    description: string;
    css: Record<string, string>;
    xterm: {
        background: string;
        foreground: string;
        cursor: string;
        selectionBackground: string;
    };
}

export const THEMES: KaizenTheme[] = [
    // ─── 🌑 MIDNIGHT ──────────────────────────────────────────────────
    // Deep focus, nighttime coding. Maximum contrast, vivid glows.
    // When: Late night sessions, deep debugging, solo work.
    {
        name: 'midnight',
        label: '🌑 Midnight — Deep Focus',
        description: 'Maximum contrast, vivid glows. For nighttime deep work.',
        css: {
            // Surfaces
            '--bg-primary': '#07070d',
            '--bg-secondary': '#0a0a14',
            '--bg-surface': '#0f0f1c',
            '--bg-hover': '#13132a',
            // Text
            '--text-primary': '#e8e8f0',
            '--text-secondary': '#b0b0c8',
            '--text-muted': '#7777aa',
            // Borders
            '--border-color': 'rgba(255, 255, 255, 0.06)',
            '--border-active': 'rgba(0, 229, 255, 0.15)',
            // Semantic colors
            '--agent-cyan': '#00e5ff',
            '--agent-magenta': '#ff006e',
            '--agent-amber': '#ffbe0b',
            '--agent-green': '#06d6a0',
            // Operation mode variables
            '--glow-intensity': '1',
            '--glow-error': '0 0 12px rgba(255, 0, 110, 0.6)',
            '--glow-success': '0 0 8px rgba(0, 229, 255, 0.4)',
            '--anim-speed': '0.3s',
            '--anim-pulse': '2s',
            '--block-contrast': '1',
            '--backdrop-blur': '12px',
            '--glassmorphism-bg': 'rgba(7, 7, 13, 0.75)',
            '--glassmorphism-border': 'rgba(255, 255, 255, 0.08)',
        },
        xterm: {
            background: '#07070d',
            foreground: '#e8e8f0',
            cursor: '#00e5ff',
            selectionBackground: 'rgba(0, 229, 255, 0.2)',
        },
    },

    // ─── ☀️ DAYLIGHT ──────────────────────────────────────────────────
    // High visibility for bright environments. Reduced glow, high contrast text.
    // When: Café, office with windows, daytime work.
    {
        name: 'daylight',
        label: '☀️ Daylight — High Visibility',
        description: 'Reduced glow, crisp text. For bright environments.',
        css: {
            // Surfaces — warm dark, not pure black (reduces eye strain in light)
            '--bg-primary': '#1a1a24',
            '--bg-secondary': '#22222e',
            '--bg-surface': '#2a2a38',
            '--bg-hover': '#333344',
            // Text — extra bright for readability
            '--text-primary': '#f5f5ff',
            '--text-secondary': '#c8c8e0',
            '--text-muted': '#9898b8',
            // Borders — more visible
            '--border-color': 'rgba(255, 255, 255, 0.12)',
            '--border-active': 'rgba(100, 200, 255, 0.25)',
            // Semantic — slightly muted to reduce dazzle
            '--agent-cyan': '#4fc3f7',
            '--agent-magenta': '#f06292',
            '--agent-amber': '#ffd54f',
            '--agent-green': '#81c784',
            // Operation mode — subdued for daylight
            '--glow-intensity': '0.3',
            '--glow-error': '0 0 4px rgba(240, 98, 146, 0.3)',
            '--glow-success': '0 0 4px rgba(79, 195, 247, 0.2)',
            '--anim-speed': '0.2s',
            '--anim-pulse': '3s',
            '--block-contrast': '1.2',
            '--backdrop-blur': '8px',
            '--glassmorphism-bg': 'rgba(26, 26, 36, 0.9)',
            '--glassmorphism-border': 'rgba(255, 255, 255, 0.15)',
        },
        xterm: {
            background: '#1a1a24',
            foreground: '#f5f5ff',
            cursor: '#4fc3f7',
            selectionBackground: 'rgba(79, 195, 247, 0.25)',
        },
    },

    // ─── 🟣 CYBERPUNK ─────────────────────────────────────────────────
    // Maximum visual intensity. Neon everything. For demos and streaming.
    // When: Screen sharing, video recording, showing off, hack nights.
    {
        name: 'cyberpunk',
        label: '🟣 Cyberpunk — Neon Overdrive',
        description: 'Maximum visual intensity. For demos and streaming.',
        css: {
            // Surfaces — deep purple-black
            '--bg-primary': '#0a0010',
            '--bg-secondary': '#0f0018',
            '--bg-surface': '#150022',
            '--bg-hover': '#1f0033',
            // Text
            '--text-primary': '#f0e0ff',
            '--text-secondary': '#c8a0f0',
            '--text-muted': '#9060c0',
            // Borders — neon glow
            '--border-color': 'rgba(200, 100, 255, 0.12)',
            '--border-active': 'rgba(200, 100, 255, 0.3)',
            // Semantic — oversaturated neon
            '--agent-cyan': '#00ffff',
            '--agent-magenta': '#ff00ff',
            '--agent-amber': '#ffff00',
            '--agent-green': '#00ff88',
            // Operation mode — MAXIMUM INTENSITY
            '--glow-intensity': '1.8',
            '--glow-error': '0 0 20px rgba(255, 0, 255, 0.8), 0 0 40px rgba(255, 0, 110, 0.3)',
            '--glow-success': '0 0 16px rgba(0, 255, 255, 0.6), 0 0 30px rgba(0, 255, 136, 0.2)',
            '--anim-speed': '0.15s',
            '--anim-pulse': '1.2s',
            '--block-contrast': '1.4',
            '--backdrop-blur': '16px',
            '--glassmorphism-bg': 'rgba(10, 0, 16, 0.7)',
            '--glassmorphism-border': 'rgba(200, 100, 255, 0.15)',
        },
        xterm: {
            background: '#0a0010',
            foreground: '#f0e0ff',
            cursor: '#ff00ff',
            selectionBackground: 'rgba(200, 100, 255, 0.3)',
        },
    },

    // ─── 🍃 ZEN ───────────────────────────────────────────────────────
    // Minimal stimulation. Almost no animation. Low contrast, warm tones.
    // When: Long Pomodoro sessions, writing docs, avoiding burnout.
    {
        name: 'zen',
        label: '🍃 Zen — Low Fatigue',
        description: 'Minimal stimulation, warm tones. For long sessions.',
        css: {
            // Surfaces — warm, low-contrast
            '--bg-primary': '#111110',
            '--bg-secondary': '#181816',
            '--bg-surface': '#1f1f1c',
            '--bg-hover': '#282824',
            // Text — warm, easy on eyes
            '--text-primary': '#d8d4c8',
            '--text-secondary': '#a8a498',
            '--text-muted': '#787468',
            // Borders — barely there
            '--border-color': 'rgba(200, 190, 170, 0.06)',
            '--border-active': 'rgba(180, 200, 160, 0.12)',
            // Semantic — desaturated, calming
            '--agent-cyan': '#88c8a0',
            '--agent-magenta': '#c88888',
            '--agent-amber': '#c8b878',
            '--agent-green': '#88b888',
            // Operation mode — MINIMAL stimulation
            '--glow-intensity': '0.15',
            '--glow-error': '0 0 3px rgba(200, 136, 136, 0.2)',
            '--glow-success': 'none',
            '--anim-speed': '0.5s',
            '--anim-pulse': '5s',
            '--block-contrast': '0.8',
            '--backdrop-blur': '6px',
            '--glassmorphism-bg': 'rgba(17, 17, 16, 0.85)',
            '--glassmorphism-border': 'rgba(200, 190, 170, 0.06)',
        },
        xterm: {
            background: '#111110',
            foreground: '#d8d4c8',
            cursor: '#88c8a0',
            selectionBackground: 'rgba(136, 200, 160, 0.15)',
        },
    },
];

export function applyTheme(theme: KaizenTheme) {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.css)) {
        root.style.setProperty(key, value);
    }
    // Set data attribute for CSS selectors that need theme-specific rules
    root.dataset.theme = theme.name;
}

export function getThemeByName(name: string): KaizenTheme {
    return THEMES.find(t => t.name === name) || THEMES[0];
}
