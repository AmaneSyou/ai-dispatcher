import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandEnv, isInside } from './util.ts';

export type GateCmd = { name: string; cmd: string; timeoutMinutes?: number };

export type ProjectConfig = {
	repo: string;
	baseBranch: string;
	gates: GateCmd[];
	// 准备命令：每个副本建好后、AI 开始前先跑（例如 pnpm install）；由调度器在沙盒外执行，可以联网。
	// 失败算环境问题，不扣 AI 的轮数
	setup?: GateCmd[];
	// DSH 沙盒里不能启动带管道的子进程（spawn EPERM），有些验收命令在里面跑不通；
	// 这里写一条在沙盒里能跑的自查命令，免得 worker 浪费 token 去摸索
	selfCheck?: string;
	protected?: string[];
	// 同步目标：你自己的仓库（本机路径或远程地址）和要基于的分支；“推送”时改动会推到它的新分支 dispatcher/task-<编号>
	upstream?: { repo: string; branch: string };
	maxFilesChanged?: number;
	maxLinesChanged?: number;
};

export type DshConfig = {
	install: string;
	concurrency: number;
	maxAttempts: number;
	timeoutMinutes: number;
	keyFile: string;
	dailyTokenBudget: number;
	// 留空用 DSH 默认模型
	model?: string;
};

// Claude / Codex 走订阅额度，按“暂停到额度恢复”管理，不按 token 预算
export type CliAgentConfig = {
	enabled: boolean;
	command?: string;
	concurrency: number;
	maxAttempts: number;
	timeoutMinutes: number;
	model?: string;
	effort?: string;
	// 额度用完但解析不出恢复时间时，暂停多久再试
	quotaPauseMinutes?: number;
	// 订阅额度到保留线后继续派发，用完订阅就用付费额度（Codex 充值余额 / Claude 额外用量）。
	// 命令行总是先用订阅额度，所以开启后会先用掉为你保留的那部分
	usePaid?: boolean;
	// 付费模式下每天最多运行几轮，防止花费失控
	paidDailyMaxRuns?: number;
	// 仅 Codex：充值余额低于这个数就停止（单位与 Codex 显示的余额相同）
	paidMinBalance?: number;
	// 仅 Claude：付费方式。extra_usage = claude.ai 的额外用量；api_key = 用 Console 的 API Key 按 token 计费
	paidMethod?: 'extra_usage' | 'api_key';
	// 仅 Claude api_key：每轮最多花多少美元（交给 Claude Code 的 --max-budget-usd）、每天最多花多少美元
	paidMaxUsdPerRun?: number;
	paidDailyMaxUsd?: number;
	// 仅 Claude api_key：key 文件（相对 workRoot），默认 secrets\anthropic.key
	apiKeyFile?: string;
};

export const DEFAULT_CLAUDE_KEY_FILE = 'secrets\\anthropic.key';
export const DEFAULT_PAID_USD_PER_RUN = 2;
export const DEFAULT_PAID_USD_PER_DAY = 20;

export type AgentName = 'dsh' | 'claude' | 'codex';

export type Config = {
	workRoot: string;
	git: string;
	dashboard: { host: string; port: number };
	agents: { dsh: DshConfig; claude?: CliAgentConfig; codex?: CliAgentConfig };
	// 某个代理用完轮次仍未通过时，按这个顺序交给下一个；走到头就交给人
	escalation?: AgentName[];
	// Claude / Codex 的订阅额度剩余降到这个比例时不再自动派发，这部分留给你自己用
	quotaGuard?: { fiveHourReservePercent: number; weeklyReservePercent: number };
	// Claude / Codex 一方额度不足或不可用时，把它排队中的任务交给另一方（默认开启）
	takeover?: boolean;
	// “交给谁”选自动时，先让一个 AI 判断难度再分配
	triage?: TriageConfig;
	// 验收通过后再让另一个 AI 复核一遍
	review?: ReviewConfig;
	// 托盘通知
	notify?: NotifyConfig;
	// 面板外观：背景图、面板不透明度、毛玻璃、背景变暗
	appearance?: AppearanceConfig;
	projects: Record<string, ProjectConfig>;
};

// background 是 workRoot\ui-assets 下的文件名；百分比都是 0~100 的整数，blur 单位是像素
export type AppearanceConfig = { background: string | null; panelOpacity: number; blur: number; dim: number };
export const DEFAULT_APPEARANCE: AppearanceConfig = { background: null, panelOpacity: 82, blur: 8, dim: 25 };
export const appearanceOf = (cfg: Config): AppearanceConfig => ({ ...DEFAULT_APPEARANCE, ...(cfg.appearance ?? {}) });

// 判断难度：agent 没额度就换另一家；两家都没有时 dshFallback 决定是否让 DSH 自己判断
export type TriageConfig = { agent: 'codex' | 'claude'; dshFallback: boolean };
// 复核：scope = dsh 只复核 DSH 做的；all 全部复核（复核者不会复核自己做的）。
// fallback：复核者没额度时换另一家；都没有就不复核，直接交给你并写明
export type ReviewConfig = { enabled: boolean; agent: 'claude' | 'codex'; fallback: boolean; scope: 'dsh' | 'all'; maxFixRounds: number };
export type NotifyConfig = { passed: boolean; needsHuman: boolean; planned: boolean; done: boolean; agentDown: boolean };

export const DEFAULT_TRIAGE: TriageConfig = { agent: 'codex', dshFallback: true };
export const DEFAULT_REVIEW: ReviewConfig = { enabled: true, agent: 'claude', fallback: true, scope: 'dsh', maxFixRounds: 1 };
export const DEFAULT_NOTIFY: NotifyConfig = { passed: true, needsHuman: true, planned: true, done: true, agentDown: true };

export const triageOf = (cfg: Config): TriageConfig => ({ ...DEFAULT_TRIAGE, ...(cfg.triage ?? {}) });
export const reviewOf = (cfg: Config): ReviewConfig => ({ ...DEFAULT_REVIEW, ...(cfg.review ?? {}) });
export const notifyOf = (cfg: Config): NotifyConfig => ({ ...DEFAULT_NOTIFY, ...(cfg.notify ?? {}) });

export const DEFAULT_ESCALATION: AgentName[] = ['dsh', 'claude', 'codex'];

export function agentLimits(cfg: Config, agent: string): { concurrency: number; maxAttempts: number; timeoutMinutes: number } {
	const a = (cfg.agents as Record<string, { concurrency: number; maxAttempts: number; timeoutMinutes: number } | undefined>)[agent];
	return { concurrency: a?.concurrency ?? 1, maxAttempts: a?.maxAttempts ?? 1, timeoutMinutes: a?.timeoutMinutes ?? 20 };
}

export const CODE_ROOT = path.resolve(import.meta.dirname, '..');

// 所有项目共用的受保护路径：凭据、CI、锁文件，以及“验收时会被执行、改了就能在沙盒外跑任意代码”的构建配置。
// 任务里的改动碰到就直接判不通过
export const DEFAULT_PROTECTED = [
	'**/.env',
	'**/.env.*',
	'.github/**',
	'**/*.lock',
	'**/pnpm-lock.yaml',
	'**/package-lock.json',
	'**/.dsh/**',
	'**/.codex/**',
	'**/.claude/**',
	// Rust：构建脚本在编译时执行；.cargo 里能设 rustc 包装程序；工具链文件能指向任意程序
	'**/build.rs',
	'**/.cargo/**',
	'**/rust-toolchain',
	'**/rust-toolchain.toml',
	// 包管理器配置：能改依赖来源、开启安装脚本
	'**/.npmrc',
	'**/.yarnrc',
	'**/.yarnrc.yml',
	'**/pnpm-workspace.yaml',
];

export function configPath(): string {
	return process.env.DISPATCHER_CONFIG ?? path.join(CODE_ROOT, 'dispatcher.config.json');
}

export function loadConfig(): Config {
	const file = configPath();
	if (!fs.existsSync(file)) {
		throw new Error(`找不到配置文件 ${file}，请先运行 init`);
	}
	const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Config;
	cfg.agents.dsh.install = expandEnv(cfg.agents.dsh.install);
	// 旧版配置写的是“用到多少停”，换算成“保留多少”
	const g = cfg.quotaGuard as Record<string, number> | undefined;
	if (g && 'weeklyStopPercent' in g) {
		cfg.quotaGuard = { fiveHourReservePercent: 100 - g.fiveHourStopPercent, weeklyReservePercent: 100 - g.weeklyStopPercent };
	}
	return cfg;
}

export function saveConfig(cfg: Config): void {
	fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, '\t')}\n`, 'utf8');
}

export function workPaths(cfg: Config) {
	const r = cfg.workRoot;
	return {
		root: r,
		db: path.join(r, 'dispatcher.db'),
		worktrees: path.join(r, 'wt'),
		dshHome: path.join(r, 'dsh-home'),
		logs: path.join(r, 'logs'),
		secrets: path.join(r, 'secrets'),
		projects: path.join(r, 'projects'),
		dshPatch: path.join(r, 'dsh-worker.patch.yml'),
		uiAssets: path.join(r, 'ui-assets'),
		// 验收时各副本共用的 Rust 编译缓存
		cargoTarget: path.join(r, 'cargo-target'),
	};
}

// DSH 沙盒默认放行系统临时目录，工作区放在那里等于让各 worker 互相可写
export function assertWorkRootSafe(cfg: Config): void {
	const temps = [os.tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean) as string[];
	for (const t of temps) {
		if (isInside(cfg.workRoot, t)) {
			throw new Error(`workRoot 不能放在临时目录 ${t} 内`);
		}
	}
}

// 读文件不受 DSH 沙盒限制，所以审计时把这些目录当成禁区（含面板窗口的浏览器配置目录）
export function sensitiveDirs(cfg: Config): string[] {
	const home = os.homedir();
	const p = workPaths(cfg);
	return [
		path.join(home, '.codex'),
		path.join(home, '.claude'),
		path.join(home, '.dsh'),
		path.join(home, '.ssh'),
		path.join(home, '.aws'),
		path.join(home, '.git-credentials'),
		path.join(home, 'AppData', 'Roaming', 'Claude'),
		path.join(home, 'AppData', 'Local', 'OpenAI'),
		p.secrets,
		p.dshHome,
		path.join(p.root, 'ui-profile'),
		CODE_ROOT,
	];
}
