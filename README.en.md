[简体中文](README.md) | **English** | [日本語](README.ja.md)

# AI Dispatcher

A local, Windows-based task dispatcher that splits coding work among three AI agents to save money and use your subscription quotas well:

- **DSH** (DeepSeek Harness) — cheap, pay-per-token; handles simple, repetitive work.
- **Claude** (Claude Code) — complex code, debugging, and code review.
- **Codex** — architecture, hard problems, and breaking large tasks into small ones.

Every task runs in its own isolated git worktree. The dispatcher checks the result automatically, can have a second AI review it, and **you** make the final call before anything lands in your project.

## Features

- **Automatic routing** — an AI quickly reads the code, rates the difficulty, and picks the cheapest agent that can do the job.
- **Automatic escalation** — if one agent can't pass the checks, the task moves on (by default DSH → Claude → Codex → you), with a hand-off note and the previous agent's report.
- **Acceptance gates** — changed-file scope, protected files, size limits, a suspicious-change scan, then your project's own commands (tests, lint, build).
- **Cross review** — after the gates pass, a different AI reviews the diff; important issues are sent back for one more round.
- **Large-task splitting** — Codex drafts a plan of small tasks with dependencies; you edit and approve it; dependent tasks wait until earlier ones are merged.
- **One-click merge / undo** — merges are re-checked in a temporary copy first and never overwrite your uncommitted work; undo creates a revert commit.
- **Export patch / push to your repo** — bring changes back to your real repository as a `git am` patch, or push them to a new `dispatcher/task-N` branch.
- **Quota guard** — stops dispatching to Claude / Codex when the remaining 5-hour or weekly quota drops to the share you reserve for yourself; optional paid mode with daily caps.
- **Live safety audit** — every tool call is checked; writing outside the worktree, reading credentials, `git push`, privilege escalation, etc. stop the agent immediately.
- **GUI** — a local web panel (opened as an Edge app window), tray icon, Windows notifications, custom background and transparency, and a built-in **Help** page with tutorials and an FAQ.

## Requirements

| Required | Notes |
|---|---|
| Windows 10 / 11 | Tray, notifications and the panel window rely on Windows |
| [Node.js](https://nodejs.org/) 24+ | Runs TypeScript directly; no `npm install` needed |
| [Git for Windows](https://git-scm.com/download/win) | Each task works in its own git worktree |
| DeepSeek Harness desktop app + a DeepSeek API key | The cheap main worker |

Optional: Claude Code (Claude subscription), Codex (ChatGPT subscription), and pnpm / Rust / Python if your projects need them (installed into the program folder by `安装工具.ps1`, without touching system settings).

## Quick start

1. Extract the archive to a permanent folder (e.g. `D:\AI-Dispatcher`).
2. Double-click **`首次安装.cmd`** (first-time setup): checks Node and Git, creates the config, and adds an “AI 调度器” shortcut to your desktop. The work folder defaults to `AgentWork` on the same drive.
3. Save your DeepSeek API key, alone, as `<work folder>\secrets\deepseek.key`.
4. Optional: right-click **`安装工具.ps1`** → *Run with PowerShell* to install pnpm / Rust / Python (official sources, checksums verified).
5. Open the desktop shortcut, go to **环境检查** (environment check) and click **开始检查**. When everything is ticked, try **设置 → 项目 → 创建演示项目** (create a demo project) and add a task.

The interface is currently in Simplified Chinese. The **帮助** (Help) tab explains every screen and walks through a complete complex task.

## Safety notes

- Agents work inside their own sandboxes and are audited live, but **acceptance commands run outside the sandbox as you** (they execute the code the AI changed). Only register projects you trust, and run hard tasks while you are around.
- Build configuration that gets executed during checks (`build.rs`, `.cargo`, `.npmrc`, `package.json`, `vite.config.*` …) should be protected; the common ones are protected by default.
- The panel listens on `127.0.0.1` only and uses a new random token on every start.
- Keep API keys in the `secrets` folder only — never in project code or task descriptions.

## Status

v0.2. Windows only. Phone remote control is not implemented yet.

## License

[MIT](LICENSE) © AmaneSyou
