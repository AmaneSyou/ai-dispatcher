import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { killTree } from '../util.ts';

export type StopReason = 'killed' | 'timeout' | 'cancelled';

export type JsonlRunInput = {
	exe: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin: string;
	logFile: string;
	timeoutMs: number;
	signal: AbortSignal;
	// 返回 'stop' 表示审计要求立即终止进程
	onEvent: (ev: Record<string, any>) => 'stop' | void;
	// 进程启动后拿到终止函数，供事件流以外的监视（例如 DSH 子代理会话文件）使用
	onStart?: (stop: (why: StopReason) => void) => void;
};

export type JsonlRunOutput = {
	exitCode: number | null;
	stopReason: StopReason | null;
	spawnError: string | null;
	stderrTail: string;
};

// 三个代理都输出“一行一个 JSON 事件”，启动、逐行解析、超时、取消、整树结束的逻辑共用
export function runJsonl(input: JsonlRunInput): Promise<JsonlRunOutput> {
	return new Promise((resolve) => {
		const log = fs.createWriteStream(input.logFile, { flags: 'a' });
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(input.exe, input.args, { cwd: input.cwd, env: input.env, windowsHide: true });
		} catch (e) {
			log.end();
			resolve({ exitCode: null, stopReason: null, spawnError: String(e), stderrTail: '' });
			return;
		}

		let settled = false;
		let stopReason: StopReason | null = null;
		let spawnError: string | null = null;
		let buf = '';
		let stderrTail = '';

		const stop = (why: StopReason) => {
			if (stopReason) return;
			stopReason = why;
			killTree(child.pid);
		};
		const timer = setTimeout(() => stop('timeout'), input.timeoutMs);
		input.onStart?.(stop);
		const onAbort = () => stop('cancelled');
		if (input.signal.aborted) onAbort();
		input.signal.addEventListener('abort', onAbort);

		const handle = (line: string) => {
			if (!line.trim()) return;
			log.write(`${line}\n`);
			let ev: Record<string, any>;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (input.onEvent(ev) === 'stop') stop('killed');
		};

		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (d: string) => {
			buf += d;
			let i = buf.indexOf('\n');
			while (i >= 0) {
				handle(buf.slice(0, i));
				buf = buf.slice(i + 1);
				i = buf.indexOf('\n');
			}
		});
		child.stderr!.setEncoding('utf8');
		child.stderr!.on('data', (d: string) => {
			stderrTail = (stderrTail + d).slice(-4000);
		});
		child.stdin!.on('error', () => {});
		child.stdin!.end(input.stdin);

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			input.signal.removeEventListener('abort', onAbort);
			if (buf) handle(buf);
			log.end();
			resolve({ exitCode: code, stopReason, spawnError, stderrTail });
		};
		child.on('error', (e) => {
			spawnError = String(e);
			finish(null);
		});
		child.on('close', (code) => finish(code));
	});
}

// 订阅额度用完、登录失效这类错误各家文案不同，统一归类
export function classifyErrorText(text: string): string | null {
	// 模型改名或下线：要先于其他规则判断（这类报错里常带 400/404 和 “invalid” 字样）
	if (/model[^\n]{0,60}(not found|does not exist|not exist|not supported|unsupported|unknown|invalid|deprecated|no longer|not available)|(unknown|invalid|unsupported) model|model_not_found|issue with the selected model|selected model[^\n]{0,80}may not exist|模型[^\n]{0,10}(不存在|不可用|已下线)/i.test(text)) return 'MODEL_UNAVAILABLE';
	// 续聊时会话找不到或绑定了别的目录（DSH 实测：session "…" was recorded in "<旧目录>", not "<新目录>"）
	if (/was recorded in|no conversation found|session[^\n]{0,60}(not found|does not exist|unknown)|unknown session|no rollout found|thread[^\n]{0,30}not found/i.test(text)) return 'SESSION_INVALID';
	if (/usage limit|limit reached|hit your limit|rate.?limit|quota|too many requests|status(?: code)?:? ?429/i.test(text)) return 'QUOTA_EXHAUSTED';
	if (/not logged in|please run \/login|log ?in again|unauthori[sz]ed|authentication|invalid api key|status(?: code)?:? ?401/i.test(text)) return 'UNAUTHORIZED';
	if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network error|socket hang up|stream disconnected/i.test(text)) return 'NETWORK';
	return null;
}

// 文案里带重置时间时尽量解析出来（Unix 秒、ISO 时间），解析不了就由调用方用默认暂停时长
export function parseResetAt(text: string): string | null {
	const epoch = text.match(/\|(\d{10})\b/) ?? text.match(/reset[^0-9]{0,20}(\d{10})\b/i);
	if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
	const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/);
	if (iso) return new Date(iso[0]).toISOString();
	return null;
}
