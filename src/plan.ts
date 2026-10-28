// 拆分任务：AI 先给出小任务清单，人看过（可以改）并批准后，才按清单生成子任务
import { addTask } from './actions.ts';
import { agentEnabled } from './agents.ts';
import type { Config } from './config.ts';
import type { Store, Task } from './db.ts';

export const MAX_PLAN_ITEMS = 12;

export type PlanItem = {
	title: string;
	spec: string;
	allow: string[];
	// null 表示用拆分任务里设的默认代理
	agent: string | null;
	// 要等哪几项合并后才开始，写的是清单里的序号（从 1 开始）
	depends_on: number[];
};

export type Plan = {
	summary: string;
	items: PlanItem[];
	// 批准后生成的子任务编号，和 items 一一对应
	created?: number[];
};

// 从 AI 的回复里取出 json：优先取最后一个 json 代码块，没有就取最外层的大括号
export function extractJson(text: string, what = '方案'): unknown {
	const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
	const raw = blocks.length ? blocks[blocks.length - 1][1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
	if (!raw.trim()) throw new Error(`回复里没有找到 json 格式的${what}`);
	try {
		return JSON.parse(raw);
	} catch (e) {
		throw new Error(`${what}不是合法的 json：${e instanceof Error ? e.message : String(e)}`);
	}
}

export const extractPlan = (text: string): unknown => extractJson(text, '方案');

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// 检查并整理方案。AI 给的和人在面板里改过的都走这里，出错时说清楚是第几项
export function normalizePlan(raw: unknown, agents: string[]): Plan {
	const p = raw as { summary?: unknown; items?: unknown } | null;
	if (!p || typeof p !== 'object' || !Array.isArray(p.items)) throw new Error('方案里缺少 items 列表');
	if (p.items.length === 0) throw new Error('方案里一项小任务都没有');
	if (p.items.length > MAX_PLAN_ITEMS) throw new Error(`方案有 ${p.items.length} 项，最多 ${MAX_PLAN_ITEMS} 项`);
	const items = p.items.map((x, i): PlanItem => {
		const it = (x ?? {}) as Record<string, unknown>;
		const no = i + 1;
		const title = str(it.title);
		const spec = str(it.spec);
		if (!title) throw new Error(`第 ${no} 项没有标题`);
		if (title.length > 120) throw new Error(`第 ${no} 项的标题太长（最多 120 字）`);
		if (!spec) throw new Error(`第 ${no} 项没有说明`);
		const allow = (Array.isArray(it.allow) ? it.allow : []).map(str).filter(Boolean);
		const agent = str(it.agent) || null;
		if (agent && !agents.includes(agent)) throw new Error(`第 ${no} 项的代理“${agent}”不可用（可用：${agents.join('、')}）`);
		const deps = Array.isArray(it.depends_on) ? it.depends_on.map(Number) : [];
		for (const d of deps) {
			// 只能依赖排在前面的项：这样不可能出现互相等待
			if (!Number.isInteger(d) || d < 1 || d >= no) throw new Error(`第 ${no} 项的依赖“${d}”无效：只能写排在它前面的项的序号`);
		}
		return { title, spec, allow, agent, depends_on: [...new Set(deps)].sort((a, b) => a - b) };
	});
	return { summary: str(p.summary), items };
}

export function enabledAgents(cfg: Config): string[] {
	return ['dsh', 'claude', 'codex'].filter((a) => agentEnabled(cfg, a));
}

export function readPlan(t: Task): Plan | null {
	return t.plan_json ? (JSON.parse(t.plan_json) as Plan) : null;
}

// 批准方案：按清单生成子任务（依赖换成真实的任务编号），拆分任务变成“已拆分”
export function approvePlan(cfg: Config, store: Store, id: number, edited?: unknown): string {
	const t = store.getTask(id);
	if (!t) throw new Error(`找不到任务 #${id}`);
	if (t.kind !== 'plan' || t.status !== 'planned') throw new Error('只有“待批准拆分”的任务可以批准');
	const plan = normalizePlan(edited ?? readPlan(t), enabledAgents(cfg));
	const n = plan.items.length;
	const ids: number[] = [];
	// 一次性生成：中途出错就一个都不建，免得留下半套子任务
	store.db.exec('begin');
	try {
		plan.items.forEach((item, i) => {
			const background = `（背景：这是大任务 #${t.id}「${t.title}」拆出的第 ${i + 1}/${n} 项。${plan.summary ? `整体思路：${plan.summary}` : ''}）`;
			const cid = addTask(cfg, store, {
				project: t.project,
				title: item.title,
				spec: `${item.spec}\n\n${background}`,
				allow: item.allow.length ? item.allow : t.allow,
				readonly: t.readonly,
				agent: item.agent ?? t.child_agent ?? 'dsh',
				subagentLimits: t.child_subagent_limits,
			});
			store.updateTask(cid, { parent_id: t.id, depends_on: item.depends_on.map((d) => ids[d - 1]), auto_merge: t.auto_merge });
			ids.push(cid);
		});
		store.updateTask(t.id, { status: 'split', plan_json: JSON.stringify({ ...plan, created: ids }), reason: null });
		store.addEvent(t.id, null, 'info', 'split', `你批准了拆分方案，生成 ${n} 个子任务：${ids.map((x) => `#${x}`).join('、')}`);
		store.db.exec('commit');
	} catch (e) {
		store.db.exec('rollback');
		throw e;
	}
	return `已生成 ${n} 个子任务（#${ids[0]}${n > 1 ? ` ～ #${ids[n - 1]}` : ''}）${t.auto_merge ? '，每个验收通过后会自动合并' : '，有先后关系的要等前一项合并后才开始'}`;
}

// 子任务合并或撤销合并后，更新拆分任务：全部合并就算完成
export function syncParent(store: Store, parentId: number | null): void {
	if (!parentId) return;
	const parent = store.getTask(parentId);
	if (!parent || !['split', 'merged'].includes(parent.status)) return;
	const kids = store.childrenOf(parentId).filter((k) => k.status !== 'cancelled');
	const all = kids.length > 0 && kids.every((k) => k.status === 'merged');
	if (all && parent.status !== 'merged') {
		store.updateTask(parentId, { status: 'merged', reason: null });
		store.addEvent(parentId, null, 'info', 'merged', `全部 ${kids.length} 个子任务都已合并进项目`);
	} else if (!all && parent.status === 'merged') {
		store.updateTask(parentId, { status: 'split', reason: '有子任务的合并被撤销了' });
	}
}
