import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	acceptTask,
	addTask,
	archiveTasks,
	cancelTask,
	createDemo,
	rejectTask,
	retryTask,
	runChecks,
	STATUS_LABEL,
} from './actions.ts';
import { buildAdapters, ensureGitOnPath, writePatch } from './agents.ts';
import type { Config } from './config.ts';
import { assertWorkRootSafe, CODE_ROOT, configPath, loadConfig, workPaths } from './config.ts';
import { Store } from './db.ts';
import { resolveClaude } from './adapters/resolve.ts';
import { dispatchState, refreshClaudeQuota } from './quota.ts';
import { tidyEnded } from './cleanup.ts';
import { mergeTask, undoMerge } from './merge.ts';
import { Runner } from './runner.ts';
import { startServer } from './server.ts';

type Args = { _: string[]; opts: Record<string, string[]> };

function parseArgs(argv: string[]): Args {
	const out: Args = { _: [], opts: {} };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			const val = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
			(out.opts[key] ??= []).push(val);
		} else {
			out._.push(a);
		}
	}
	return out;
}

const one = (a: Args, k: string): string | undefined => a.opts[k]?.[0];
const many = (a: Args, k: string): string[] => a.opts[k] ?? [];
const idArg = (a: Args): number => Number(a._[1]);

function openStore(cfg: Config): Store {
	fs.mkdirSync(cfg.workRoot, { recursive: true });
	return new Store(workPaths(cfg).db);
}

// 第一次生成配置：工作目录默认放在程序所在盘的 AgentWork（全英文路径，Rust / MSVC 不出问题；
// 和程序同盘，pnpm 的共享依赖库才能用硬链接），也可以用 --work-root 指定；git 自动找
function cmdInit(a: Args): void {
	const file = configPath();
	if (!fs.existsSync(file)) {
		const cfg = JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'dispatcher.config.example.json'), 'utf8')) as Config;
		cfg.workRoot = path.resolve(one(a, 'work-root') ?? path.join(path.parse(CODE_ROOT).root, 'AgentWork'));
		cfg.git = findGit() ?? cfg.git;
		fs.writeFileSync(file, `${JSON.stringify(cfg, null, '\t')}\n`, 'utf8');
		console.log(`已生成配置 ${file}（工作目录 ${cfg.workRoot}）`);
	}
	const cfg = loadConfig();
	assertWorkRootSafe(cfg);
	const wp = workPaths(cfg);
	for (const d of [wp.root, wp.worktrees, wp.dshHome, wp.logs, wp.secrets, wp.projects]) fs.mkdirSync(d, { recursive: true });
	writePatch(cfg);
	console.log(`工作区目录已就绪：${wp.root}`);
	const keyFile = path.join(cfg.workRoot, cfg.agents.dsh.keyFile);
	if (!fs.existsSync(keyFile)) console.log(`\n还缺 DeepSeek key：请把 key 单独保存到 ${keyFile}（只含 key 本身）`);
	console.log('下一步：dispatch check');
}

function findGit(): string | null {
	const common = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'), path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe')];
	const hit = common.find((p) => fs.existsSync(p));
	if (hit) return hit;
	const r = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
	return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

function cmdCheck(): void {
	const items = runChecks(loadConfig());
	for (const i of items) console.log(`${i.ok ? '✔' : '✘'} ${i.msg}`);
	const bad = items.filter((i) => !i.ok).length;
	console.log(bad ? `\n${bad} 项未通过` : '\n全部通过');
	process.exitCode = bad ? 1 : 0;
}

async function cmdDemo(): Promise<void> {
	console.log(await createDemo(loadConfig()));
	console.log('可以在面板里新建任务，或运行：dispatch add --project demo --title "实现 slugify 和 countWords" --allow "src/**" --readonly "test/**" --spec "按注释实现，让测试通过"');
}

function cmdAdd(a: Args): void {
	const cfg = loadConfig();
	const specFile = one(a, 'spec-file');
	const id = addTask(cfg, openStore(cfg), {
		project: one(a, 'project') ?? '',
		title: one(a, 'title') ?? '',
		spec: specFile ? fs.readFileSync(specFile, 'utf8') : (one(a, 'spec') ?? ''),
		allow: many(a, 'allow'),
		readonly: many(a, 'readonly'),
		agent: one(a, 'agent'),
		maxAttempts: one(a, 'max-attempts') ? Number(one(a, 'max-attempts')) : undefined,
		// --subagents N 是 DSH 的简写；Claude / Codex 要单独写 --subagents-claude / --subagents-codex
		subagentLimits: {
			dsh: Number(one(a, 'subagents-dsh') ?? one(a, 'subagents') ?? 0),
			claude: Number(one(a, 'subagents-claude') ?? 0),
			codex: Number(one(a, 'subagents-codex') ?? 0),
		},
	});
	console.log(`已加入队列：#${id}`);
}

function cmdList(): void {
	const store = openStore(loadConfig());
	const tasks = store.listTasks(50);
	if (!tasks.length) return console.log('队列为空');
	for (const t of tasks) {
		console.log(`#${String(t.id).padEnd(4)} ${STATUS_LABEL[t.status].padEnd(6)} ${t.project.padEnd(8)} ${t.agent.padEnd(6)} ${t.stage_attempts}/${t.max_attempts}  ${t.title}`);
		if (t.reason && ['needs_human', 'failed'].includes(t.status)) console.log(`       ↳ ${t.reason}`);
	}
}

function cmdShow(a: Args): void {
	const store = openStore(loadConfig());
	const t = store.getTask(idArg(a));
	if (!t) throw new Error('请给出有效的任务编号');
	console.log(`#${t.id} ${t.title}\n状态：${STATUS_LABEL[t.status]}${t.reason ? `（${t.reason}）` : ''}\n项目：${t.project}  分支：${t.branch ?? '-'}\n工作区：${t.worktree ?? '-'}\n`);
	for (const at of store.attemptsFor(t.id)) {
		console.log(`— 第 ${at.n} 轮 ${at.agent} ${at.outcome ?? '进行中'}${at.error_code ? ` (${at.error_code})` : ''}  输入 ${at.tokens_in} / 输出 ${at.tokens_out} / 缓存 ${at.tokens_cache_read}`);
		console.log(`  日志：${at.log_path}`);
		if (at.final_text) console.log(at.final_text.replace(/^/gm, '  │ '));
	}
	if (t.last_report) console.log(`\n最近一次验收：\n${t.last_report}`);
}

function fileLogger(cfg: Config, alsoConsole: boolean): (msg: string) => void {
	const file = path.join(workPaths(cfg).logs, 'dispatcher.log');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return (msg: string) => {
		if (alsoConsole) console.log(msg);
		fs.appendFileSync(file, `${msg}\n`, 'utf8');
	};
}

// 右下角托盘图标是一个独立的 PowerShell 进程：调度器退出时由这里结束它；
// 调度器意外崩溃时它自己连不上服务也会退出
function startTray(cfg: Config, token: string, log: (msg: string) => void): ChildProcess | null {
	if (process.platform !== 'win32') return null;
	const child = spawn(
		'powershell',
		['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(CODE_ROOT, 'ui', 'tray.ps1')],
		{
			env: {
				...process.env,
				DISPATCHER_PORT: String(cfg.dashboard.port),
				DISPATCHER_TOKEN: token,
				DISPATCHER_ICON: path.join(CODE_ROOT, 'ui', 'favicon.ico'),
				DISPATCHER_NODE: process.execPath,
				DISPATCHER_CLI: path.join(CODE_ROOT, 'src', 'cli.ts'),
				DISPATCHER_PID: String(process.pid),
				// 新式通知的图标（png）放在工作目录里
				DISPATCHER_WORK: cfg.workRoot,
			},
			windowsHide: true,
			stdio: 'ignore',
		},
	);
	child.on('error', (e) => log(`[${new Date().toLocaleTimeString()}] 托盘图标启动失败：${e.message}`));
	return child;
}

// Claude 的额度只有调用它时才知道；/usage 是本地命令、不花额度，所以定时查一次，面板也能手动触发。
// 同一时间只跑一个查询
function makeQuotaRefresher(cfg: Config, store: Store, log: (msg: string) => void): () => Promise<string> {
	let running: Promise<string> | null = null;
	return () => {
		running ??= (async () => {
			try {
				if (!cfg.agents.claude?.enabled) return 'Claude 未启用，跳过';
				const exe = resolveClaude(cfg.agents.claude.command);
				if (!exe || !fs.existsSync(exe)) return '找不到 Claude 程序';
				await refreshClaudeQuota(exe, store, workPaths(cfg).root);
				return 'Claude 额度已刷新';
			} catch (e) {
				const msg = `Claude 额度刷新失败：${e instanceof Error ? e.message : String(e)}`;
				log(`[${new Date().toLocaleTimeString()}] ${msg}`);
				return msg;
			} finally {
				running = null;
			}
		})();
		return running;
	};
}

// run 和 app 共用：启动调度循环和本机面板服务
async function startDispatcher(cfg: Config, log: (msg: string) => void, opts: { tray: boolean }) {
	assertWorkRootSafe(cfg);
	const store = openStore(cfg);
	ensureGitOnPath(cfg);
	let status = { available: [] as string[], skipped: [] as string[] };
	const runner = new Runner({
		cfg,
		store,
		adapters: {},
		log,
		quotaBlock: (agent) => dispatchState(cfg, store, agent).block,
		paidMode: (agent) => dispatchState(cfg, store, agent).paidMode,
	});
	const reloadAgents = () => {
		const built = buildAdapters(cfg);
		runner.opts.adapters = built.adapters;
		runner.opts.allowedRead = built.allowedRead;
		status = { available: Object.keys(built.adapters), skipped: built.skipped };
		log(`[${new Date().toLocaleTimeString()}] 可用代理：${status.available.join(' → ')}${status.skipped.length ? `；未启用：${status.skipped.join('，')}` : ''}`);
		return status;
	};
	reloadAgents();
	let server: Awaited<ReturnType<typeof startServer>> | null = null;
	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		log(`[${new Date().toLocaleTimeString()}] 正在退出，运行中的 AI 会被终止`);
		await runner.stop();
		// 不直接结束托盘进程：它每秒检查调度器是否还在，自己收起图标更干净
		server?.close();
		store.close();
		process.exit(0);
	};
	const token = randomBytes(24).toString('hex');
	const refreshQuota = makeQuotaRefresher(cfg, store, log);
	const ctx = {
		cfg,
		store,
		runner,
		token,
		refreshQuota,
		reloadAgents,
		agentStatus: () => status,
		shutdown,
		startedAt: new Date().toISOString(),
	};
	try {
		server = await startServer(ctx, cfg.dashboard.port, cfg.dashboard.host);
	} catch (e) {
		store.close();
		throw new Error(`端口 ${cfg.dashboard.port} 被占用或无法监听：${e instanceof Error ? e.message : e}`);
	}
	// 先刷新一次额度再开始派发，避免拿着过期的数字派活；之后每 5 分钟刷新。
	// 不等它完成就返回，面板窗口不必多等几秒
	void refreshQuota().finally(() => runner.start());
	setInterval(refreshQuota, 5 * 60_000);
	// 已结束的任务每 10 分钟整理一次（日志压缩、删 DSH 会话目录），省磁盘
	const tidy = () =>
		tidyEnded(cfg, store)
			.then((r) => r.tasks && log(`整理了 ${r.tasks} 个已结束的任务，省下约 ${(r.freed / 1048576).toFixed(1)} MB`))
			.catch((e: unknown) => log(`整理已结束任务时出错：${e instanceof Error ? e.message : String(e)}`));
	setTimeout(tidy, 30_000);
	setInterval(tidy, 10 * 60_000);
	if (opts.tray) startTray(cfg, token, log);
	process.on('SIGINT', shutdown);
	return { url: `http://${cfg.dashboard.host}:${cfg.dashboard.port}/`, store, runner };
}

async function cmdRun(a: Args): Promise<void> {
	const cfg = loadConfig();
	// --once：把当前队列（含自动重试）跑完就退出，不开面板，适合测试和脚本
	if (one(a, 'once') === 'true') {
		const store = openStore(cfg);
		ensureGitOnPath(cfg);
		const { adapters, allowedRead, skipped } = buildAdapters(cfg);
		if (skipped.length) console.log(`以下代理未启用：${skipped.join('，')}`);
		console.log(`可用代理：${Object.keys(adapters).join(' → ')}`);
		const runner = new Runner({
			cfg,
			store,
			adapters,
			allowedRead,
			quotaBlock: (agent) => dispatchState(cfg, store, agent).block,
			paidMode: (agent) => dispatchState(cfg, store, agent).paidMode,
		});
		const n = store.recoverInterrupted();
		if (n) console.log(`有 ${n} 个任务在上次退出时被中断，已标为“需要你处理”`);
		console.log(await makeQuotaRefresher(cfg, store, console.log)());
		await runner.drain();
		store.close();
		return;
	}
	const { url } = await startDispatcher(cfg, fileLogger(cfg, true), { tray: one(a, 'no-tray') !== 'true' });
	console.log(`调度器已启动。面板：${url}\n按 Ctrl+C 停止`);
}

async function alreadyRunning(cfg: Config): Promise<boolean> {
	try {
		const r = await fetch(`http://${cfg.dashboard.host}:${cfg.dashboard.port}/api/ping`, { signal: AbortSignal.timeout(1500) });
		return (await r.json()).app === 'ai-dispatcher';
	} catch {
		return false;
	}
}

// 用 Edge 的应用模式打开：独立窗口、没有地址栏，看起来像普通软件；找不到 Edge 就用默认浏览器
function openWindow(cfg: Config, url: string): void {
	const candidates = [
		path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
		path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
	];
	const edge = candidates.find((p) => fs.existsSync(p));
	if (edge) {
		const profile = path.join(workPaths(cfg).root, 'ui-profile');
		// 面板页面里有操作口令：不加载任何扩展、不同步账号（实测 Edge 会把你平时的扩展同步进来），缓存限 50MB
		spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1360,900', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disk-cache-size=52428800'], {
			detached: true,
			stdio: 'ignore',
		}).unref();
	} else {
		spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
	}
}

async function cmdApp(): Promise<void> {
	const cfg = loadConfig();
	if (await alreadyRunning(cfg)) {
		openWindow(cfg, `http://${cfg.dashboard.host}:${cfg.dashboard.port}/`);
		return;
	}
	const { url } = await startDispatcher(cfg, fileLogger(cfg, false), { tray: true });
	openWindow(cfg, url);
}

// 生成一个隐藏命令行窗口的启动脚本，再在桌面放一个快捷方式指向它
function cmdShortcut(): void {
	const vbs = path.join(CODE_ROOT, 'bin', 'launch.vbs');
	const cli = path.join(CODE_ROOT, 'src', 'cli.ts');
	const q = (s: string) => s.replace(/"/g, '""');
	const script = [
		"' 由 dispatch shortcut 生成：后台启动调度器（不显示命令行窗口）并打开面板",
		'Set sh = CreateObject("WScript.Shell")',
		`sh.CurrentDirectory = "${q(CODE_ROOT)}"`,
		`sh.Run """${q(process.execPath)}"" --disable-warning=ExperimentalWarning ""${q(cli)}"" app", 0, False`,
		'',
	].join('\r\n');
	// WSH 只有在 UTF-16 带 BOM 时才能正确读取中文路径
	fs.writeFileSync(vbs, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]));
	const icon = path.join(CODE_ROOT, 'ui', 'favicon.ico');
	const ps = [
		'[Console]::OutputEncoding = [Text.Encoding]::UTF8',
		'$desk = [Environment]::GetFolderPath("Desktop")',
		'$sc = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk "AI 调度器.lnk"))',
		'$sc.TargetPath = Join-Path $env:SystemRoot "System32\\wscript.exe"',
		`$sc.Arguments = '"${vbs.replace(/'/g, "''")}"'`,
		`$sc.WorkingDirectory = '${CODE_ROOT.replace(/'/g, "''")}'`,
		`$sc.IconLocation = '${icon.replace(/'/g, "''")},0'`,
		'$sc.Description = "AI 任务调度器"',
		'$sc.Save()',
		'Write-Output (Join-Path $desk "AI 调度器.lnk")',
	].join('; ');
	const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
	if (r.status !== 0) throw new Error(`创建快捷方式失败：${r.stderr || r.stdout}`);
	console.log(`已创建桌面快捷方式：${r.stdout.trim()}`);
}

async function cmdAction(a: Args, fn: (cfg: Config, store: Store, id: number) => Promise<string>): Promise<void> {
	const cfg = loadConfig();
	console.log(await fn(cfg, openStore(cfg), idArg(a)));
}

const HELP = `用法：dispatch <命令>

  app                  启动调度器并打开面板窗口（已在运行时只打开窗口）
  shortcut             在桌面创建“AI 调度器”快捷方式
  init [--work-root D:\\AgentWork]  生成配置、创建工作区目录（默认放在程序所在盘的 AgentWork）
  notify-off / notify-on            撤销 / 恢复托盘新式通知的登记
  check                检查环境（不调用模型）
  demo                 创建并登记演示项目
  add --project P --title T (--spec S | --spec-file F) [--allow G]... [--readonly G]... [--agent dsh|claude|codex] [--max-attempts N] [--subagents N(DSH)] [--subagents-claude N] [--subagents-codex N]
  list                 查看队列
  show <id>            查看任务详情、每轮结果和验收报告
  run [--once] [--no-tray]  在当前窗口启动调度器和面板；--once 表示跑完当前队列就退出
  accept <id>          接受“待验收”的任务（保留分支，由你合并）
  reject <id> [--reason R]
  retry <id> [--fresh] [--agent A]  重新排队；--fresh 丢弃原工作区从基线重来，--agent 换一个代理接手
  cancel <id>
  merge <id>           把“待验收 / 已接受”的任务合并进项目（先在临时副本里合并并复检）
  unmerge <id>         撤销合并（新增反向提交，历史保留）
  clear [id...]        从看板清除已结束的任务（不给编号就清除全部已结束的；记录和分支保留）`;

async function main(): Promise<void> {
	const a = parseArgs(process.argv.slice(2));
	switch (a._[0]) {
		case 'app':
			return cmdApp();
		case 'shortcut':
			return cmdShortcut();
		case 'init':
			return cmdInit(a);
		case 'check':
			return cmdCheck();
		case 'demo':
			return cmdDemo();
		case 'add':
			return cmdAdd(a);
		case 'list':
			return cmdList();
		case 'show':
			return cmdShow(a);
		case 'accept':
			return cmdAction(a, acceptTask);
		case 'reject':
			return cmdAction(a, (cfg, store, id) => rejectTask(cfg, store, id, one(a, 'reason')));
		case 'retry':
			return cmdAction(a, (cfg, store, id) => retryTask(cfg, store, id, { fresh: one(a, 'fresh') === 'true', agent: one(a, 'agent') }));
		case 'cancel':
			return cmdAction(a, cancelTask);
		case 'merge':
			return cmdAction(a, async (cfg, store, id) => (await mergeTask(cfg, store, id)).message);
		case 'unmerge':
			return cmdAction(a, async (cfg, store, id) => (await undoMerge(cfg, store, id)).message);
		case 'clear': {
			const store = openStore(loadConfig());
			const ids = a._.slice(1).map(Number).filter(Number.isInteger);
			return console.log(archiveTasks(store, { ids: ids.length ? ids : undefined }));
		}
		case 'run':
			return cmdRun(a);
		case 'notify-off': {
			// 撤销托盘为新式通知登记的“AI 调度器”（只删 HKCU 下这一项），并记住不再登记；托盘改回旧式气泡通知
			const wr = loadConfig().workRoot;
			fs.writeFileSync(path.join(wr, 'notify-legacy'), '1');
			const r = spawnSync('reg', ['delete', 'HKCU\\Software\\Classes\\AppUserModelId\\AIDispatcher.Tray', '/f'], { encoding: 'utf8', windowsHide: true });
			return console.log(`${r.status === 0 ? '已删除通知登记' : '注册表里本来就没有这项登记'}；重启调度器后改用旧式通知。恢复用 notify-on`);
		}
		case 'notify-on':
			fs.rmSync(path.join(loadConfig().workRoot, 'notify-legacy'), { force: true });
			return console.log('重启调度器后改用新式通知（会重新登记“AI 调度器”）');
		default:
			console.log(HELP);
	}
}

main().catch((e) => {
	const msg = e instanceof Error ? e.message : String(e);
	console.error(`✘ ${msg}`);
	process.exitCode = 1;
	// 从快捷方式启动时没有命令行窗口，出错要弹窗告诉你，否则看起来像“双击没反应”
	if (process.argv[2] === 'app') {
		const text = `AI 调度器启动失败：\n${msg}`.replace(/'/g, "''");
		spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'AI 调度器') | Out-Null`], { windowsHide: true });
	}
});
