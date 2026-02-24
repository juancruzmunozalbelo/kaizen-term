<p align="center">
  <h1 align="center">⚡ KaizenTerm</h1>
  <p align="center"><strong>The first Terminal Orchestration Cockpit for the Vibe Coding era.</strong></p>
  <p align="center">
    <em>Stop typing commands. Start orchestrating agents.</em>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-macOS-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/AI-BYOLLM%20(Ollama%2FOpenAI%2FAnthropic)-purple?style=flat-square" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" />
  <img src="https://img.shields.io/badge/Version-1.0.0-orange?style=flat-square" />
</p>

---

## 🧠 What is KaizenTerm?

KaizenTerm is **not another terminal emulator**. It's a cockpit where you design work on a Kanban board, delegate it to AI agents running in parallel terminals, and watch them complete tasks autonomously — with zero-click kickoff and auto-close pipelines.

```
📋 Kanban Card → ⚡ Agent Auto-Spawn → 🤖 AI Works → Exit 0 → ✅ Card Done
```

While Warp and Ghostty compete on "who renders text faster", KaizenTerm asks: **"Why are you still typing commands at all?"**

---

## 🔥 The Pipeline (Nobody Else Has This)

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│  📋 Kanban   │────▶│  🤖 Agent Shell  │────▶│   ✅ Auto-Done │
│  Board       │  ⚡  │  (MCP Terminal)  │  E0  │   (Card moves │
│  "Fix API"   │     │  Error Glow ⚡    │     │    to Done)    │
└─────────────┘     │  Status Badges   │     └───────────────┘
                    │  Block Output    │
                    │  Amber Alert ⏳   │
                    └──────────────────┘
                           │
                    ┌──────┴──────┐
                    │  🤖 AI Chat  │
                    │  @agent-1    │
                    │  @agent-2    │
                    │  Multi-ctx   │
                    └─────────────┘
```

---

## ⭐ Features

### 🤖 AI-Native Orchestration
| Feature | Description |
|---------|-------------|
| **Zero-Click Kickoff** | Kanban card → ⚡ → Agent spawns with your configured command |
| **Auto-Close Pipeline** | Exit code 0 → Kanban card moves to "Done" automatically |
| **Multi-Agent @mentions** | `@agent-1 @agent-2 why is the DB crashing?` → combined context |
| **NL → Command** | Type `# start the database` → AI translates to `docker-compose up -d` |
| **AI Error Diagnosis** | Click 🤖 on any error block → AI explains and suggests fix |
| **BYOLLM** | Ollama (auto-setup), OpenAI, or Anthropic. You choose |

### 📋 Kaizen Methodology
| Feature | Description |
|---------|-------------|
| **Kanban Board** | Backlog → Doing → Review → Done, drag & drop |
| **Pomodoro Timer** | Focus cycles with break reminders |
| **Health Alerts** | Stand up, hydrate, stretch — because burnout kills code |
| **Task → Agent Pipeline** | Every card can spawn an agent pre-configured for the task |

### 🖥️ Terminal Power
| Feature | Description |
|---------|-------------|
| **Block-Based Output** | Every command grouped in collapsible blocks (like Warp) |
| **ANSI Error Glow** | Red pulse on tabs with errors — ambient awareness |
| **Last-Line Monitoring** | See what each agent is doing without switching tabs |
| **Amber Alert** | Detects when an agent is blocked waiting for input |
| **Agent Status Badges** | 🔍 Searching, 🧠 Thinking, ✏️ Writing, 📦 Installing, 🧪 Testing |
| **Broadcast** | Type once, send to all terminals |
| **Zen Mode** | Distraction-free single-terminal focus |

### 🔌 Extensible
| Feature | Description |
|---------|-------------|
| **Plugin API** | Extend KaizenTerm without modifying source code |
| **MCP Integration** | Model Context Protocol for agent-to-agent communication |
| **Codebase Indexing** | Auto-indexes your project for AI context |
| **4 Curated Themes** | Glassmorphism Dark, Light, Cyberpunk, Zen |

---

## 🚀 Quick Start

### Prerequisites
- macOS 12+
- [Ollama](https://ollama.ai) (optional — KaizenTerm auto-installs the AI model)

### Install & Run

```bash
# Clone
git clone https://github.com/yourusername/kaizen-term.git
cd kaizen-term

# Install dependencies
npm install

# Run development mode
npm run dev
```

### Build `.dmg` Installer

```bash
npm run build
# Output: release/KaizenTerm-1.0.0.dmg
```

### First Launch
1. KaizenTerm auto-detects Ollama and downloads `deepseek-coder-v2:16b` (~8.9GB, first run only)
2. The onboarding guide shows you the pipeline
3. Create your first Kanban card → ⚡ Spawn an agent → Watch it work

---

## 🗣️ Natural Language Commands

Type `#` followed by plain English in any terminal:

```
# find all TODO comments in the project
→ grep -rn "TODO" --include="*.ts" .

# show disk usage sorted by size
→ du -sh * | sort -rh

# start the dev server on port 3000
→ npm run dev -- --port 3000
```

---

## 📡 Multi-Agent Chat

In the Omni Drawer, mention agents by name:

```
@frontend @backend Why are there CORS errors between the API and the React app?
```

KaizenTerm pulls the last 30 lines from **both** terminals and sends them to the AI for a combined diagnosis.

---

## 🏆 vs The Competition

| | KaizenTerm | Warp | Ghostty | Wave |
|---|:---:|:---:|:---:|:---:|
| Auto-Close Pipeline | ✅⭐ | ❌ | ❌ | ❌ |
| Multi-Agent @mentions | ✅⭐ | ❌ | ❌ | ❌ |
| Zero-Click Kickoff | ✅⭐ | ❌ | ❌ | ❌ |
| Kanban + Pomodoro | ✅⭐ | ❌ | ❌ | ❌ |
| BYOLLM (free AI) | ✅⭐ | ❌ $22/mo | ❌ | ❌ |
| Block Output | ✅ | ✅ | ❌ | ❌ |
| NL → Command | ✅ | ✅ | ❌ | ✅ |
| GPU Rendering | ⚡ WebGL | ✅ Metal | ✅ Metal | ❌ |
| **Score** | **43/50** | **32/50** | **24/50** | **27/50** |

---

## 🛠️ Tech Stack

- **Electron** — Cross-platform shell
- **xterm.js** — Terminal emulator (WebGL accelerated)
- **Split.js** — Resizable split panes
- **Vite** — Build tooling
- **Ollama** — Local AI inference (auto-configured)
- **TypeScript** — Zero `any` in core modules

---

## 📐 Architecture

```
┌─────────────────────────────────────────┐
│               Electron Main             │
│  ┌─────────┐  ┌────────┐  ┌──────────┐ │
│  │ node-pty │  │ Ollama │  │ MCP Disc │ │
│  │ (shells) │  │ Setup  │  │ (tools)  │ │
│  └─────────┘  └────────┘  └──────────┘ │
├─────────────────────────────────────────┤
│             Renderer (Vite)             │
│  ┌─────────────────────────────────┐    │
│  │         KaizenApp (main.ts)     │    │
│  │  ┌───────┐ ┌──────┐ ┌────────┐ │    │
│  │  │Kanban │ │Timer │ │Palette │ │    │
│  │  └───────┘ └──────┘ └────────┘ │    │
│  │  ┌────────────────────────────┐ │    │
│  │  │   TerminalManager         │ │    │
│  │  │  ┌──────┐ ┌──────┐       │ │    │
│  │  │  │Agent1│ │Agent2│ ...   │ │    │
│  │  │  └──────┘ └──────┘       │ │    │
│  │  └────────────────────────────┘ │    │
│  │  ┌──────────────────────────┐   │    │
│  │  │    Omni Drawer (AI)      │   │    │
│  │  │  BYOLLM + @mentions      │   │    │
│  │  └──────────────────────────┘   │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

---

## 🤝 Contributing

KaizenTerm is open-source. Contributions welcome!

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit: `git commit -m 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## 📄 License

MIT © 2026 KaizenTerm

---

<p align="center">
  <strong>Stop typing. Start orchestrating.</strong><br>
  <em>KaizenTerm — The Cockpit for Vibe Coding</em>
</p>
