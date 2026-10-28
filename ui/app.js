'use strict';

const TOKEN = document.querySelector('meta[name="dispatcher-token"]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

const AGENT_NAME = { dsh: 'DSH', claude: 'Claude', codex: 'Codex', auto: '自动' };
const LABEL = { queued: '排队中', running: '运行中', gating: '验收中', needs_human: '需要你处理', passed: '待你验收', accepted: '已接受', rejected: '已驳回', cancelled: '已取消', failed: '失败', merged: '已合并', planned: '待批准拆分', split: '已拆分', reviewing: '复核中' };
// retry：卡片上直接给“重试”；clear：标题栏给“清除”（只从看板隐藏，记录和分支保留）
const COLS = [
	{ name: '排队中', color: 'var(--queued)', st: ['queued'] },
	{ name: '运行 / 验收中', color: 'var(--accent)', st: ['running', 'gating', 'reviewing', 'split'], pulse: true },
	{ name: '需要你处理', color: 'var(--warn)', st: ['needs_human', 'failed'] },
	{ name: '待你验收', color: 'var(--ok)', st: ['passed', 'planned'] },
	{ name: '已驳回', color: 'var(--bad)', st: ['rejected'], retry: true, clear: true },
	{ name: '已结束', color: 'var(--muted)', st: ['accepted', 'cancelled', 'merged'], limit: 15, clear: true },
];
const WINDOW = { five_hour: '5 小时窗口', seven_day: '每周窗口' };
// 子代理上限的简短说明，例如 "DSH≤4 · Claude≤2"；都没开返回空
const subText = (t) => Object.entries(t.subagent_limits || {}).filter(([, n]) => n > 0).map(([a, n]) => `${AGENT_NAME[a] || a}≤${n}`).join(' · ');

// 大任务：子任务合并进度；子任务：还在等哪几项合并
const kids = (t) => state.tasks.filter((k) => k.parent_id === t.id);
function splitProgress(t) {
	const ks = kids(t).filter((k) => k.status !== 'cancelled');
	return `子任务已合并 ${ks.filter((k) => k.status === 'merged').length}/${ks.length}`;
}
function depWait(t) {
	if (t.status !== 'queued' || !t.depends_on?.length) return '';
	const pending = t.depends_on.map((id) => state.tasks.find((k) => k.id === id) || { id, status: 'unknown' }).filter((k) => k.status !== 'merged');
	if (!pending.length) return '';
	const dead = pending.filter((k) => ['cancelled', 'rejected'].includes(k.status));
	if (dead.length) return `依赖的 ${dead.map((k) => `#${k.id}`).join('、')} 已${LABEL[dead[0].status]}，这一项不会开始`;
	return `等待 ${pending.map((k) => `#${k.id}`).join('、')} 合并进项目后开始`;
}

// 新建任务里三家的子代理选项
for (const s of document.querySelectorAll('.f-sub')) {
	s.innerHTML = [0, 2, 3, 4, 6].map((n) => `<option value="${n}">${n ? `最多 ${n} 个` : '不使用'}</option>`).join('');
}

const UNCOUNTED = {
	SESSION_INVALID: '旧会话接不上，已自动换新会话',
	QUOTA_EXHAUSTED: '额度用完，等恢复后继续',
	MODEL_UNAVAILABLE: '模型不可用',
	INVALID_CREDENTIAL: '登录或密钥问题',
	UNAUTHORIZED: '登录或密钥问题',
	NETWORK: '网络问题',
	SPAWN_FAILED: '程序没能启动',
};
// 已经过了重置时间的窗口，旧数据没意义，按满额显示
const left = (w) => (new Date(w.resetsAt) <= Date.now() ? 100 : Math.max(0, Math.min(100, Math.round((1 - w.utilization) * 100))));

let state = null;
let tab = 'board';

async function api(path, body) {
	const opts = { headers: { 'x-dispatcher-token': TOKEN } };
	if (body !== undefined) {
		opts.method = 'POST';
		opts.headers['content-type'] = 'application/json';
		opts.body = JSON.stringify(body);
	}
	const r = await fetch(path, opts);
	// 调度器重启后口令会变：旧窗口刷新一下就能拿到新口令，不用手动关掉重开
	if (r.status === 401) {
		location.reload();
		throw new Error('调度器已重启，正在刷新面板');
	}
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
	return data;
}

let toastTimer;
// 用 popover 进入顶层，才能显示在详情弹窗上面；每次重新弹出，保证叠在最新打开的弹窗之上
function toast(msg, err = false) {
	const t = $('toast');
	t.textContent = msg;
	t.className = `toast show${err ? ' err' : ''}`;
	if (t.showPopover) {
		if (t.matches(':popover-open')) t.hidePopover();
		t.showPopover();
	}
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		t.className = 'toast';
		if (t.hidePopover && t.matches(':popover-open')) t.hidePopover();
	}, err ? 7000 : 4000);
}

async function act(fn, okMsg) {
	try {
		const r = await fn();
		toast(r?.message || okMsg || '完成');
		await refresh();
		return r;
	} catch (e) {
		toast(e.message, true);
		return null;
	}
}

function until(iso) {
	const ms = new Date(iso) - Date.now();
	if (ms <= 0) return '已重置';
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	if (h >= 48) return `${Math.floor(h / 24)} 天 ${h % 24} 小时后`;
	return h ? `${h} 小时 ${m} 分后` : `${m} 分钟后`;
}
const when = (iso) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function agentStatus(a) {
	if (!a.enabled) return { text: '已停用', cls: 'off' };
	if (a.name !== 'dsh' && !a.available) return { text: a.skipped ? a.skipped.replace(/^\w+（|）$/g, '') : '不可用', cls: 'bad' };
	if (a.pause) return { text: `额度用完，${when(a.pause.until)} 恢复`, cls: 'warn' };
	if (a.block) return { text: '额度保护中，暂停派发', cls: 'warn' };
	if (a.paidMode) return { text: `付费模式（今日 ${a.paid.runsToday}/${a.paid.cap} 轮）`, cls: 'warn' };
	if (a.name === 'dsh' && a.budget && a.usage.tokensIn + a.usage.tokensOut >= a.budget) return { text: '今日预算用完', cls: 'warn' };
	return { text: a.running ? `运行中 ${a.running} 个` : '可用', cls: 'ok' };
}

// ---------- 顶部与状态条 ----------
function renderTop() {
	const live = $('live');
	const busy = state.tasks.filter((t) => t.status === 'running' || t.status === 'gating').length;
	const queued = state.tasks.filter((t) => t.status === 'queued').length;
	live.className = `pill ${busy ? 'busy' : 'ok'}`;
	live.textContent = busy ? `运行中 ${busy} 个 · 排队 ${queued}` : queued ? `排队 ${queued} 个` : '空闲';

	$('agentStrip').innerHTML =
		state.agents
		.map((a) => {
			const s = agentStatus(a);
			let detail;
			if (a.name === 'dsh') detail = `今日剩余 <b>${fmt(Math.max(0, a.budget - a.usage.tokensIn - a.usage.tokensOut))}</b> token`;
			else if (a.quota)
				detail =
					'剩余 ' +
					Object.entries(a.quota.windows)
						.map(([k, w]) => `${k === 'five_hour' ? '5h' : k === 'seven_day' ? '周' : k} <b>${left(w)}%</b>`)
						.join(' · ');
			else detail = '<span class="sub">额度未知（运行一次后显示）</span>';
			return `<div class="chip${s.cls === 'warn' || s.cls === 'bad' ? ' warn' : ''}"><span class="name">${AGENT_NAME[a.name]}</span><span>${detail}</span><span class="${s.cls === 'ok' ? 'sub' : 'w'}">${esc(s.text)}</span></div>`;
		})
		.join('') + '<button type="button" class="btn mini" data-refresh-quota>刷新额度</button>';
}

// ---------- 看板 ----------
function renderBoard() {
	// 一个任务都没有（包括已清除的也只剩空看板）时，提示新手先看帮助
	$('firstHint').hidden = state.tasks.length > 0;
	$('board').innerHTML = COLS.map((c) => {
		let items = state.tasks.filter((t) => c.st.includes(t.status));
		const total = items.length;
		if (c.limit) items = items.slice(0, c.limit);
		const body = items.length
			? items
					.map((t) => {
						// 排队中的任务如果它的 AI 被额度挡住了，直接写明在等什么，免得以为卡死了
						const ag = state.agents.find((a) => a.name === t.agent);
						const waiting =
							t.status === 'queued' && ag
								? ag.pause
									? `等待 ${AGENT_NAME[t.agent]} 额度恢复（约 ${when(ag.pause.until)}）`
									: ag.block
										? `等待 ${AGENT_NAME[t.agent]} 额度：${ag.block}`
										: ag.name !== 'dsh' && !ag.available
											? `${AGENT_NAME[t.agent]} 当前不可用（${ag.skipped || '未启用'}），任务会一直排队`
											: ''
								: '';
						const note =
							depWait(t) ||
							waiting ||
							(t.status === 'split' ? splitProgress(t) : t.status === 'planned' ? '拆分方案已出，等你批准' : t.status === 'reviewing' ? (t.live ? '另一个 AI 正在复核' : '验收通过，排队等复核') : t.agent === 'auto' ? (t.status === 'running' ? '正在判断难度' : '等待判断难度') : '') ||
							(t.status === 'rejected' ? (t.feedback ? `你的意见：${t.feedback}` : '没有写驳回原因') : t.status !== 'accepted' ? t.reason : '');
						return `<div class="card" data-id="${t.id}">
					<div class="t">#${t.id} ${esc(t.title)}</div>
					<div class="m">${t.kind === 'plan' ? '<span class="tag">大任务</span> ' : ''}${esc(t.project)} · ${AGENT_NAME[t.agent] || esc(t.agent)}${t.kind === 'plan' ? ' 拆分' : ''} · 第 ${t.stage_attempts}/${t.max_attempts} 轮${subText(t) ? ` · 子代理 ${subText(t)}` : ''}${t.handoff_from ? ` · 由 ${AGENT_NAME[t.handoff_from] || esc(t.handoff_from)} 升级` : ''}${t.parent_id ? ` · 属于 #${t.parent_id}` : ''}${t.auto_merge && t.kind !== 'plan' ? ' · 自动合并' : ''}</div>
					${note ? `<div class="r">${esc(note)}</div>` : ''}
					${c.retry ? `<div class="cardact"><button type="button" class="btn mini primary" data-retry="${t.id}">重试</button></div>` : ''}
				</div>`;
					})
					.join('')
			: '<div class="empty">暂无</div>';
		const clear = c.clear && total ? `<button type="button" class="btn mini ghost" data-clear="${c.st.join(',')}">清除</button>` : '';
		return `<div class="col"><h3><span><span class="dot${c.pulse && total ? ' pulse' : ''}" style="background:${c.color}"></span>${c.name}</span><span class="hacts">${clear}<span class="tag">${total}</span></span></h3>${body}</div>`;
	}).join('');
}

$('agentStrip').addEventListener('click', (e) => {
	const b = e.target.closest('[data-refresh-quota]');
	if (b) refreshQuota(b);
});
$('quotaRefresh').addEventListener('click', (e) => refreshQuota(e.currentTarget));

$('board').addEventListener('click', (e) => {
	const retry = e.target.closest('[data-retry]');
	if (retry) {
		retry.disabled = true;
		act(() => api(`/api/task/${retry.dataset.retry}/retry`, {}));
		return;
	}
	const clear = e.target.closest('[data-clear]');
	if (clear) {
		const statuses = clear.dataset.clear.split(',');
		const n = state.tasks.filter((t) => statuses.includes(t.status)).length;
		if (confirm(`从看板清除这 ${n} 个任务吗？\n只是不再显示，任务记录、日志和代码分支都会保留。`)) act(() => api('/api/tasks/archive', { statuses }));
		return;
	}
	const card = e.target.closest('.card');
	if (card) openTask(Number(card.dataset.id));
});

// ---------- 任务详情 ----------
async function openTask(id) {
	let d;
	try {
		d = await api(`/api/task/${id}`);
	} catch (e) {
		return toast(e.message, true);
	}
	const t = d.task;
	const agents = state.agents.filter((a) => a.enabled && (a.name === 'dsh' || a.available)).map((a) => a.name);
	const agentSelect = `<select id="dlgAgent" style="display:inline-block;width:auto">${agents.map((a) => `<option value="${a}"${a === t.agent ? ' selected' : ''}>${AGENT_NAME[a]}</option>`).join('')}</select>`;
	const btn = (action, label, cls = '') => `<button type="button" class="btn ${cls}" data-act="${action}">${label}</button>`;
	let actions = '';
	// 上次合并失败（冲突或合并后检查没过）时，多给一个“在最新代码上重做”
	const mergeFailed = ['passed', 'accepted'].includes(t.status) && /冲突|合并后|合并失败/.test(t.reason || '');
	const redo = mergeFailed ? btn('redo_latest', '让 AI 在最新代码上重做') : '';
	// 大任务在拆分之后有自己的一套按钮；拆分本身排队、运行、失败时和普通任务一样
	if (t.kind === 'plan' && ['planned', 'split', 'merged'].includes(t.status)) {
		if (t.status === 'planned') actions = btn('approve_plan', '批准并开始', 'primary') + btn('replan', '让 AI 重新拆分') + agentSelect + btn('cancel', '取消', 'danger');
		else if (t.status === 'split') actions = btn('cancel', '取消剩下的子任务', 'danger');
		else actions = btn('archive', '从看板清除', 'ghost');
	} else if (t.status === 'passed') actions = btn('merge', '接受并合并到项目', 'primary') + btn('accept', '只接受（我自己合并）') + btn('reject', '驳回') + agentSelect + btn('handoff', '交给它重做') + redo;
	else if (['needs_human', 'failed', 'rejected', 'cancelled'].includes(t.status))
		actions =
			btn('retry', t.status === 'rejected' ? '按意见在这一版上修改' : '在原基础上重试', 'primary') +
			agentSelect +
			btn('handoff', '换它接手') +
			btn('fresh', '从头重来') +
			(t.status === 'needs_human' || t.status === 'failed' ? btn('reject', '放弃') : btn('archive', '从看板清除', 'ghost'));
	else if (['queued', 'running', 'gating', 'reviewing'].includes(t.status)) actions = btn('cancel', '取消任务', 'danger');
	else if (t.status === 'accepted') actions = btn('merge', '合并到项目', 'primary') + redo + btn('archive', '从看板清除', 'ghost');
	else if (t.status === 'merged') actions = btn('unmerge', '撤销合并') + btn('archive', '从看板清除', 'ghost');

	// 把改动带回你自己的仓库：导出补丁；设了同步目标的项目还可以直接推到你仓库的新分支
	if (t.kind !== 'plan' && ['passed', 'accepted', 'merged'].includes(t.status)) {
		actions += btn('export', '导出补丁', 'ghost') + (state.upstreams?.[t.project] ? btn('push', '推送到你的仓库', 'ghost') : '');
	}
	if (t.kind === 'plan' && ['split', 'merged'].includes(t.status)) actions += btn('export_plan', '导出全部子任务补丁', 'ghost');
	const ex = parseJson(t.export_info) || {};
	const exportNote = [ex.patch ? `补丁：<code>${esc(ex.patch)}</code>（在你的仓库里运行 <code>git am</code> 应用）` : '', ex.pushed ? `已推送到 <code>${esc(ex.pushed.repo)}</code> 的新分支 <code>${esc(ex.pushed.branch)}</code>（基于 ${esc(ex.pushed.base)}），检查后在你的仓库里合并` : ''].filter(Boolean).map((s) => `<p class="hint">${s}</p>`).join('');
	const merge = t.status === 'merged' && t.merge_sha ? `<p class="hint">已合并进项目（合并提交 <code>${esc(t.merge_sha.slice(0, 8))}</code>）。撤销会新增一个反向提交，历史不会丢。</p>` : t.status === 'accepted' && t.branch ? `<p class="hint">分支 <code>${esc(t.branch)}</code> 已保留，可以点“合并到项目”，也可以自己合并。</p>` : '';
	// 按实际运行顺序编号；会话失效、额度用完等环境问题不算 AI 的轮数，单独标出来
	const attempts = d.attempts
		.map((a, i) => {
			const free = UNCOUNTED[a.error_code];
			const outcome = a.outcome === 'completed' ? '正常完成' : a.outcome ? `出错（${esc(a.error_code || a.outcome)}）` : '进行中';
			return `<details${i === d.attempts.length - 1 ? ' open' : ''}><summary>第 ${i + 1} 次运行 · ${AGENT_NAME[a.agent] || esc(a.agent)} · ${outcome}${free ? ` · <span class="reason">${free}，不计入轮数</span>` : ''} · 输入 ${fmt(a.tokens_in)} / 输出 ${fmt(a.tokens_out)} / 缓存 ${fmt(a.tokens_cache_read)}</summary>
			${a.final_text ? `<pre>${esc(a.final_text)}</pre>` : '<p class="hint">没有汇报内容</p>'}
			<div class="meta">日志：${esc(a.log_path)}</div></details>`;
		})
		.join('');
	$('dlgBody').innerHTML = `
		<div class="dlghead"><h2>#${t.id} ${esc(t.title)}</h2><button type="button" class="btn ghost" data-act="close">关闭</button></div>
		<div class="statusline"><span class="tag">${LABEL[t.status]}</span> ${t.reason ? `<span class="reason">${esc(t.reason)}</span>` : ''}</div>
		${t.feedback ? `<p class="hint">${t.feedback_by ? `${AGENT_NAME[t.feedback_by] || esc(t.feedback_by)} 的复核意见` : '你的意见'}（下一轮会交给 AI）：<b style="white-space:pre-wrap">${esc(t.feedback)}</b></p>` : ''}
		<div class="meta">项目 ${esc(t.project)} · 当前代理 ${AGENT_NAME[t.agent] || esc(t.agent)} · 分支 ${esc(t.branch || '-')}${subText(t) ? ` · 允许子代理：${subText(t)}` : ''}<br>工作区 ${esc(t.worktree || '-')}</div>
		<div class="actions" style="margin:12px 0">${actions}</div>
		${merge}${exportNote}
		${triageBox(t)}${reviewBox(t)}
		${t.status === 'planned' ? `<h3>拆分方案</h3><p class="hint">可以直接改：标题、说明、允许修改的文件、交给谁、要等哪几项。改完点“批准并开始”。不满意也可以写意见让 AI 重新拆分。</p><div id="planEdit"></div>` : ''}
		${d.children?.length ? `<h3>子任务</h3><div class="kids">${d.children.map((k) => `<div class="kid" data-open="${k.id}"><span class="tag">${LABEL[k.status] || k.status}</span> #${k.id} ${esc(k.title)} <span class="meta">${AGENT_NAME[k.agent] || esc(k.agent)}${k.depends_on.length ? ` · 等 ${k.depends_on.map((x) => `#${x}`).join('、')}` : ''}</span></div>`).join('')}</div>` : ''}
		<details ${t.kind === 'plan' ? '' : 'open'}><summary>${t.kind === 'plan' ? '大任务说明' : '任务说明'}</summary><pre>${esc(t.spec)}</pre>
			<div class="meta">允许修改：${esc(t.allow.join('、') || '不限')} · 禁止修改：${esc(t.readonly.join('、') || '无')}</div></details>
		${t.last_report ? `<details open><summary>最近一次验收结果</summary><pre>${esc(t.last_report)}</pre></details>` : ''}
		<h3 style="margin-top:14px">每一轮</h3>${attempts || '<p class="hint">还没有开始</p>'}
		<details><summary>事件（${d.events.length}）</summary><div class="log">${d.events.map((e) => `<div class="ev ${e.level}">${new Date(e.ts).toLocaleTimeString()} [${esc(e.kind)}] ${esc(e.message)}</div>`).join('')}</div></details>`;
	if (t.status === 'planned') {
		try {
			renderPlanEditor(JSON.parse(t.plan_json), t);
		} catch {
			$('planEdit').innerHTML = '<p class="warnbox">方案读取失败，请让 AI 重新拆分</p>';
		}
	}
	$('dlgBody').onclick = async (e) => {
		const k = e.target.closest('[data-open]');
		if (k) return openTask(Number(k.dataset.open));
		if (e.target.closest('[data-pi-add]')) {
			const p = planFromEditor();
			p.items.push({ title: '', spec: '', allow: [], agent: null, depends_on: [] });
			return renderPlanEditor(p, t);
		}
		const del = e.target.closest('[data-pi-del]');
		if (del) {
			// 删掉一项后，后面的序号往前挪，依赖跟着改
			const p = planFromEditor();
			const no = Number(del.dataset.piDel);
			p.items.splice(no - 1, 1);
			for (const it of p.items) it.depends_on = it.depends_on.filter((d) => d !== no).map((d) => (d > no ? d - 1 : d));
			return renderPlanEditor(p, t);
		}
		const b = e.target.closest('[data-act]');
		if (!b) return;
		const a = b.dataset.act;
		if (a === 'close') return $('dlg').close();
		const agent = $('dlgAgent')?.value;
		let r = null;
		if (a === 'approve_plan') {
			const plan = planFromEditor();
			if (!confirm(`按这个方案生成 ${plan.items.length} 个小任务并开始吗？${t.auto_merge ? '\n每个小任务验收通过后会自动合并进项目。' : ''}`)) return;
			r = await act(() => api(`/api/task/${id}/approve_plan`, { plan }));
		}
		if (a === 'export') r = await act(() => api(`/api/task/${id}/export`, {}));
		if (a === 'export_plan') r = await act(() => api(`/api/task/${id}/export_plan`, {}));
		if (a === 'push') {
			if (!confirm(`把这个任务的改动推送到你的仓库：${state.upstreams[t.project]}？\n会先取你仓库的最新代码，在临时副本里应用改动，再推到一个新分支 dispatcher/task-${id}。不会改你已有的分支，也不会碰你的工作目录；有冲突就不推。`)) return;
			b.disabled = true;
			b.textContent = '推送中…';
			await act(() => api(`/api/task/${id}/push`, {}));
			return openTask(id);
		}
		if (a === 'replan') {
			const reason = prompt('希望怎么改（会和上一版方案一起交给 AI）：', '');
			if (reason === null) return;
			r = await act(() => api(`/api/task/${id}/replan`, { reason, agent }));
		}
		if (a === 'accept') r = await act(() => api(`/api/task/${id}/accept`, {}));
		if (a === 'merge') {
			if (!confirm('合并会把这个任务的改动放进你的项目。会先在临时副本里合并并重新跑一遍检查，有冲突或检查没过就什么都不改；你的项目里有未提交改动时也不会动。继续吗？')) return;
			b.disabled = true;
			b.textContent = '合并中…';
			await act(() => api(`/api/task/${id}/merge`, {}));
			// 成功或失败都刷新弹窗：失败时要显示原因和“在最新代码上重做”
			return openTask(id);
		}
		if (a === 'unmerge') {
			if (!confirm('撤销会在项目里新增一个反向提交，抵消这次合并（历史会保留）。继续吗？')) return;
			r = await act(() => api(`/api/task/${id}/unmerge`, {}));
		}
		if (a === 'redo_latest') r = await act(() => api(`/api/task/${id}/redo_latest`, { agent }));
		if (a === 'reject') {
			const reason = prompt('驳回的原因（会在重试时交给 AI，写得越具体越好；也可以不填）：', '');
			if (reason === null) return;
			r = await act(() => api(`/api/task/${id}/reject`, { reason }));
		}
		if (a === 'retry') r = await act(() => api(`/api/task/${id}/retry`, {}));
		if (a === 'handoff') r = await act(() => api(`/api/task/${id}/retry`, { agent }));
		if (a === 'fresh') {
			if (!confirm('从头重来会丢弃当前工作区里的改动（分支保留），确定吗？')) return;
			r = await act(() => api(`/api/task/${id}/retry`, { fresh: true, agent }));
		}
		if (a === 'cancel') {
			if (!confirm('确定取消这个任务吗？正在运行的 AI 会被停止。')) return;
			r = await act(() => api(`/api/task/${id}/cancel`, {}));
		}
		if (a === 'archive') {
			r = await act(() => api('/api/tasks/archive', { ids: [id] }));
			if (r) return $('dlg').close();
		}
		if (r) openTask(id);
	};
	if (!$('dlg').open) $('dlg').showModal();
}

const parseJson = (s) => {
	try {
		return s ? JSON.parse(s) : null;
	} catch {
		return null;
	}
};

function triageBox(t) {
	const v = parseJson(t.triage);
	if (!v) return '';
	return `<p class="hint">难度判断（${AGENT_NAME[v.by] || esc(v.by)}）：<b>${esc(v.difficulty)}</b>，交给 ${AGENT_NAME[v.agent] || esc(v.agent)}${v.reason ? `。${esc(v.reason)}` : ''}</p>`;
}

function reviewBox(t) {
	const v = parseJson(t.review);
	if (!v) return '';
	const head = v.verdict === 'approve' ? `<b style="color:var(--ok)">复核通过</b>` : `<b style="color:var(--warn)">复核发现 ${v.issues.length} 个问题</b>`;
	const rounds = t.review_rounds ? `（已按复核意见返工 ${t.review_rounds} 次）` : '';
	return `<div class="reviewbox">${head} · ${AGENT_NAME[v.by] || esc(v.by)}${rounds}${v.summary ? `<div>${esc(v.summary)}</div>` : ''}${v.issues.length ? `<ol>${v.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</div>`;
}

// 拆分方案编辑：每项一块，序号从 1 开始；依赖写排在前面的序号
function renderPlanEditor(plan, t) {
	const agents = state.agents.filter((a) => a.enabled && (a.name === 'dsh' || a.available)).map((a) => a.name);
	const def = AGENT_NAME[t.child_agent] || t.child_agent || 'DSH';
	const items = plan.items
		.map((it, i) => {
			const opts = [`<option value="">默认（${esc(def)}）</option>`, ...agents.map((a) => `<option value="${a}"${a === it.agent ? ' selected' : ''}>${AGENT_NAME[a]}</option>`)].join('');
			return `<div class="planitem">
				<div class="pihead"><b>第 ${i + 1} 项</b><button type="button" class="btn mini ghost danger" data-pi-del="${i + 1}">删除这一项</button></div>
				<label>标题<input class="pi-title" maxlength="120" value="${esc(it.title)}"></label>
				<label>说明<textarea class="pi-spec" rows="4">${esc(it.spec)}</textarea></label>
				<div class="row three">
					<label>允许修改 <span class="opt">每行一个，留空沿用大任务的</span><textarea class="pi-allow" rows="2">${esc(it.allow.join('\n'))}</textarea></label>
					<label>交给谁<select class="pi-agent">${opts}</select></label>
					<label>等哪几项合并后再开始 <span class="opt">写序号，如 1,2</span><input class="pi-deps" value="${esc(it.depends_on.join(','))}"${i === 0 ? ' disabled placeholder="第 1 项不用等"' : ''}></label>
				</div>
			</div>`;
		})
		.join('');
	$('planEdit').innerHTML = `${plan.summary ? `<p class="hint">整体思路：${esc(plan.summary)}</p>` : ''}<div class="form planform">${items}</div>
		<button type="button" class="btn mini" data-pi-add>添加一项</button>`;
	$('planEdit').dataset.summary = plan.summary || '';
}

function planFromEditor() {
	return {
		summary: $('planEdit').dataset.summary || '',
		items: [...document.querySelectorAll('#planEdit .planitem')].map((el) => ({
			title: el.querySelector('.pi-title').value,
			spec: el.querySelector('.pi-spec').value,
			allow: lines(el.querySelector('.pi-allow').value),
			agent: el.querySelector('.pi-agent').value || null,
			depends_on: el
				.querySelector('.pi-deps')
				.value.split(/[,，、\s]+/)
				.filter(Boolean)
				.map(Number),
		})),
	};
}

// ---------- 新建任务 ----------
$('f-split').addEventListener('change', () => {
	$('splitOpts').hidden = !$('f-split').checked;
});

function renderProjects() {
	const sel = $('f-project');
	const cur = sel.value;
	sel.innerHTML = state.projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
	if (state.projects.includes(cur)) sel.value = cur;
	$('noProject').hidden = state.projects.length > 0;
}

$('newTask').addEventListener('submit', async (e) => {
	e.preventDefault();
	const max = $('f-max').value;
	const split = $('f-split').checked;
	const r = await act(() =>
		api('/api/tasks', {
			project: $('f-project').value,
			title: $('f-title').value,
			spec: $('f-spec').value,
			// 大任务：先交给负责拆分的 AI；“交给谁”变成小任务的默认代理
			agent: split ? $('f-planner').value : $('f-agent').value,
			split: split ? { childAgent: $('f-agent').value, autoMerge: $('f-automerge').checked } : undefined,
			allow: lines($('f-allow').value),
			readonly: lines($('f-readonly').value),
			maxAttempts: max ? Number(max) : undefined,
			subagents: Object.fromEntries([...document.querySelectorAll('.f-sub')].map((s) => [s.dataset.agent, Number(s.value)])),
		}),
	);
	if (r) {
		$('f-title').value = '';
		$('f-spec').value = '';
		switchTab('board');
	}
});
$('makeDemo').addEventListener('click', () => act(() => api('/api/demo', {})));

// ---------- 额度 ----------
// 一律显示“还剩多少”：进度条越短越紧张；降到保留线以内变红，接近时变橙
function meter(label, leftPct, sub, reserve) {
	const cls = leftPct <= reserve ? 'bad' : leftPct <= reserve + 10 ? 'warn' : '';
	return `<div class="meter"><div class="lbl"><span>${label}</span><b>剩余 ${leftPct}%</b></div><div class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, leftPct))}%"></i></div><div class="sub">${sub}</div></div>`;
}

async function refreshQuota(btn) {
	if (btn) {
		btn.disabled = true;
		btn.textContent = '刷新中…';
	}
	await act(() => api('/api/quota/refresh', {}));
	if (btn) {
		btn.disabled = false;
		btn.textContent = '刷新额度';
	}
}

function renderQuota() {
	const guard = state.guard;
	$('quotaCards').innerHTML = state.agents
		.map((a) => {
			const s = agentStatus(a);
			const used = a.usage.tokensIn + a.usage.tokensOut;
			let body = '';
			if (a.name === 'dsh') {
				const rest = Math.max(0, a.budget - used);
				const pct = a.budget ? Math.round((rest / a.budget) * 100) : 0;
				body = meter('今日 token 预算', pct, `还剩 ${fmt(rest)} / ${fmt(a.budget)}（另有 ${fmt(a.usage.tokensCacheRead)} 命中缓存，按低价计）`, 0);
			} else if (a.quota) {
				body = Object.entries(a.quota.windows)
					.map(([k, w]) => {
						const reserve = k === 'five_hour' ? guard?.fiveHourReservePercent : guard?.weeklyReservePercent;
						return meter(WINDOW[k] || k, left(w), `${when(w.resetsAt)} 重置（${until(w.resetsAt)}）${reserve !== undefined ? ` · 为你保留 ${reserve}%` : ''}`, reserve ?? 0);
					})
					.join('');
				body += `<div class="sub">数据来源：${esc(a.quota.source)} · 更新于 ${when(a.quota.at)}</div>`;
			} else {
				body = '<p class="sub">还没有额度数据。调度器第一次调用它之后就会显示。</p>';
			}
			body += `<div class="sub" style="margin-top:8px">调度器今日调用 ${a.usage.attempts} 轮 · ${fmt(used)} token（缓存 ${fmt(a.usage.tokensCacheRead)}）</div>`;
			if (a.paid) {
				const viaKey = a.paid.method === 'api_key';
				const info = viaKey ? 'Console API Key 按 token 计费' : (a.quota?.paid?.note ?? (a.name === 'claude' ? '额外用量状态未知（运行一次 Claude 后显示）' : '充值余额未知'));
				const spend = viaKey ? `，今日花费 $${a.paid.costToday.toFixed(2)} / $${a.paid.dailyUsd}` : '';
				body += `<div class="sub">付费额度：${esc(info)} · 使用付费额度：${a.paid.enabled ? `已开启（今日 ${a.paid.runsToday}/${a.paid.cap} 轮${spend}）` : '未开启'}</div>`;
			}
			if (a.block) body += `<div class="note">${esc(a.block)}</div>`;
			if (a.pause) body += `<div class="note">${esc(a.pause.reason)}</div>`;
			return `<div class="qcard"><header><span class="big">${AGENT_NAME[a.name]}</span><span class="badge ${s.cls}">${esc(s.text)}</span></header>${body}</div>`;
		})
		.join('');
}

// ---------- 日志 ----------
function renderLog() {
	$('log').innerHTML = state.events.map((e) => `<div class="ev ${e.level}">${new Date(e.ts).toLocaleString()} ${e.task_id ? `#${e.task_id} ` : ''}[${esc(e.kind)}] ${esc(e.message)}</div>`).join('') || '<p class="hint">暂无</p>';
}

// ---------- 设置 ----------
const num = (id, v, min, max, label) => `<label>${label}<input id="${id}" type="number" min="${min}" max="${max}" value="${esc(v)}"></label>`;

// 模型下拉：列表来自会自动更新的来源；已保存但不在列表里的模型单独标出来（可能已下线），也可以自定义输入
const CUSTOM = '__custom';
const EFFORT_LABEL = { low: 'low（快、省）', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max（最慢、最耗额度）', ultra: 'ultra', minimal: 'minimal' };
let modelLists = null;

function modelPicker(name, current, list) {
	const opts = list?.options ?? [];
	const known = !current || opts.some((o) => o.value === current);
	const items = [
		`<option value="">默认（由 ${AGENT_NAME[name]} 自己决定）</option>`,
		...opts.map((o) => `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}${o.label === o.value ? '' : ` · ${esc(o.value)}`}</option>`),
		known ? '' : `<option value="${esc(current)}" selected>⚠ ${esc(current)}（已不在列表中，可能已下线）</option>`,
		`<option value="${CUSTOM}">自定义…</option>`,
	].join('');
	const meta = [list?.source, list?.updatedAt ? `更新于 ${when(list.updatedAt)}` : '', list?.error].filter(Boolean).join(' · ');
	return `<label>模型 <span class="opt">${esc(meta)}</span>
		<select id="s-${name}-model" data-agent="${name}">${items}</select>
		<input id="s-${name}-model-custom" hidden placeholder="输入模型名，例如 claude-opus-5-5">
		<span class="opt" id="s-${name}-model-desc"></span></label>`;
}

function effortOptions(name, model, current) {
	const list = modelLists?.[name]?.options ?? [];
	const fromModel = list.find((o) => o.value === model)?.efforts;
	const efforts = fromModel?.length ? fromModel : ['low', 'medium', 'high', 'xhigh', 'max'];
	const keep = current && !efforts.includes(current) ? [current] : [];
	return ['', ...efforts, ...keep].map((x) => `<option value="${x}"${x === current ? ' selected' : ''}>${x ? EFFORT_LABEL[x] || x : '默认'}</option>`).join('');
}

function wireModelPicker(name) {
	const sel = $(`s-${name}-model`);
	const custom = $(`s-${name}-model-custom`);
	const desc = $(`s-${name}-model-desc`);
	const update = () => {
		custom.hidden = sel.value !== CUSTOM;
		const o = (modelLists?.[name]?.options ?? []).find((x) => x.value === sel.value);
		desc.textContent = sel.value === CUSTOM ? '填写代理支持的完整模型名，保存后会原样传给它' : (o?.description ?? '');
		const eff = $(`s-${name}-effort`);
		if (eff) eff.innerHTML = effortOptions(name, sel.value, eff.value);
	};
	sel.onchange = update;
	update();
}

const modelValue = (name) => {
	const sel = $(`s-${name}-model`);
	return sel.value === CUSTOM ? $(`s-${name}-model-custom`).value.trim() : sel.value;
};

// Claude 的两种付费方式：claude.ai 的额外用量，或 Console 的 API Key（按 token 计费，需要单独充值）
function claudePaidFields(v) {
	const opt = (val, label) => `<option value="${val}"${v.paidMethod === val ? ' selected' : ''}>${label}</option>`;
	return `<div class="row three">
		<label>付费方式<select id="s-claude-paidMethod">${opt('extra_usage', 'Claude 额外用量（在 claude.ai 开启）')}${opt('api_key', 'Console API Key（按 token 计费）')}</select></label>
		<label>每轮最多花费（美元）<span class="opt">仅 API Key 方式</span><input id="s-claude-paidMaxUsdPerRun" type="number" min="0.1" max="100" step="0.1" value="${esc(v.paidMaxUsdPerRun)}"></label>
		<label>每天最多花费（美元）<span class="opt">仅 API Key 方式</span><input id="s-claude-paidDailyMaxUsd" type="number" min="0.5" max="10000" step="0.5" value="${esc(v.paidDailyMaxUsd)}"></label>
	</div>
	<p class="hint">API Key：${v.keyPresent ? '<b>已放好</b>' : '<b>还没有</b>'}（文件位置 <code>${esc(v.keyFile)}</code>，只放 key 本身；调度器只在付费模式下才使用它）</p>`;
}

async function renderSettings() {
	let c;
	try {
		[c, modelLists] = await Promise.all([api('/api/config'), api('/api/models')]);
	} catch (e) {
		return toast(e.message, true);
	}
	const ag = c.agents;
	const cli = (name, v) => `
		<div class="agentset"><h3><label style="margin:0;font-weight:700"><input type="checkbox" id="s-${name}-enabled"${v.enabled ? ' checked' : ''}>启用 ${AGENT_NAME[name]}</label></h3>
		<div class="row four">
			${num(`s-${name}-concurrency`, v.concurrency, 1, 4, '同时运行几个')}
			${num(`s-${name}-maxAttempts`, v.maxAttempts, 1, 5, '每个任务最多几轮')}
			${num(`s-${name}-timeoutMinutes`, v.timeoutMinutes, 1, 240, '单轮超时（分钟）')}
			${num(`s-${name}-quotaPauseMinutes`, v.quotaPauseMinutes, 5, 600, '额度用完后暂停（分钟）')}
		</div>
		<div class="row two">
			${modelPicker(name, v.model, modelLists[name])}
			<label>思考强度 <span class="opt">选项随模型变化；留空用默认</span><select id="s-${name}-effort">${effortOptions(name, v.model, v.effort)}</select></label>
		</div>
		<div class="paidset">
			<label class="inline"><input type="checkbox" id="s-${name}-usePaid"${v.usePaid ? ' checked' : ''}>免费额度用到保留线后，继续使用付费额度（${name === 'codex' ? 'Codex 充值余额' : '方式在下面选'}）</label>
			<p class="hint">命令行总是先用订阅额度再用付费额度，所以开启后会先用掉为你保留的那部分。</p>
			<div class="row two">
				${num(`s-${name}-paidDailyMaxRuns`, v.paidDailyMaxRuns, 1, 200, '付费模式下每天最多运行几轮')}
				${name === 'codex' ? `<label>余额低于多少时停止<input id="s-codex-paidMinBalance" type="number" min="0" step="any" value="${esc(v.paidMinBalance)}"></label>` : '<div></div>'}
			</div>
			${name === 'claude' ? claudePaidFields(v) : ''}
		</div></div>`;
	const step = (i) => `<label>第 ${i + 1} 步<select id="s-esc-${i}"><option value="">不使用</option>${['dsh', 'claude', 'codex'].map((a) => `<option value="${a}"${c.escalation[i] === a ? ' selected' : ''}>${AGENT_NAME[a]}</option>`).join('')}</select></label>`;
	const status = c.status ? `<p class="hint">当前可用：${c.status.available.map((a) => AGENT_NAME[a]).join(' → ') || '无'}${c.status.skipped.length ? `；未启用：${esc(c.status.skipped.join('，'))}` : ''}</p>` : '';
	$('settings').innerHTML = `
	${lookSection()}
	<div class="panel form">
		<div class="dlghead"><h2>AI 代理</h2><button type="button" class="btn" id="refreshModels">刷新模型列表</button></div>${status}
		<div class="agentset"><h3>DSH <span class="tag">始终启用</span></h3><div class="row four">
			${num('s-dsh-concurrency', ag.dsh.concurrency, 1, 8, '同时运行几个')}
			${num('s-dsh-maxAttempts', ag.dsh.maxAttempts, 1, 5, '每个任务最多几轮')}
			${num('s-dsh-timeoutMinutes', ag.dsh.timeoutMinutes, 1, 240, '单轮超时（分钟）')}
			${num('s-dsh-dailyTokenBudget', ag.dsh.dailyTokenBudget, 0, 1000000000, '每日 token 预算')}
		</div>
		<div class="row two">${modelPicker('dsh', ag.dsh.model, modelLists.dsh)}</div></div>
		${cli('claude', ag.claude)}${cli('codex', ag.codex)}
		<h2>升级顺序</h2><p class="hint">一个 AI 用完轮数仍没通过验收，就交给下一个；最后一个也没通过，就交给你。</p>
		<div class="row three">${step(0)}${step(1)}${step(2)}</div>
		<label class="inline"><input type="checkbox" id="s-takeover"${c.takeover ? ' checked' : ''}>Claude 和 Codex 互相接管：一方额度不足或不可用、另一方还有余量时，把排队中的任务交给另一方</label>
		<h2>额度保护</h2><p class="hint">Claude / Codex 的订阅额度剩余降到这个比例时，就不再自动派任务给它，这部分留给你自己聊天用。填 0 表示不保留。</p>
		<div class="row two">
			${num('s-g-five', c.quotaGuard.fiveHourReservePercent, 0, 90, '5 小时窗口给你保留（%）')}
			${num('s-g-week', c.quotaGuard.weeklyReservePercent, 0, 90, '每周窗口给你保留（%）')}
		</div>
		<h2>自动分配（判断难度）</h2><p class="hint">新建任务时“交给谁”选“自动”，就先让一个 AI 快速看一下代码、判断难度，再交给最合适又最省钱的 AI。每次判断会用掉一点额度。选的那家没额度时先换另一家。</p>
		<div class="row two">
			<label>由谁判断<select id="s-tr-agent">${['codex', 'claude'].map((a) => `<option value="${a}"${c.triage.agent === a ? ' selected' : ''}>${AGENT_NAME[a]}</option>`).join('')}</select></label>
			<label class="inline"><input type="checkbox" id="s-tr-dsh"${c.triage.dshFallback ? ' checked' : ''}>Codex 和 Claude 都没有额度时，让 DSH 自己判断</label>
		</div>
		<h2>复核</h2><p class="hint">验收通过后，先让另一个 AI 看一遍改动；有重要问题就交回原来的 AI 修改，再交给你。复核者不会复核自己做的。复核的 AI 都没有额度时不会等，直接交给你，并在任务上写明“没有复核”。</p>
		<label class="inline"><input type="checkbox" id="s-rv-on"${c.review.enabled ? ' checked' : ''}>开启复核</label>
		<div class="row four">
			<label>由谁复核<select id="s-rv-agent">${['claude', 'codex'].map((a) => `<option value="${a}"${c.review.agent === a ? ' selected' : ''}>${AGENT_NAME[a]}</option>`).join('')}</select></label>
			<label>复核哪些任务<select id="s-rv-scope"><option value="dsh"${c.review.scope === 'dsh' ? ' selected' : ''}>只复核 DSH 做的</option><option value="all"${c.review.scope === 'all' ? ' selected' : ''}>全部</option></select></label>
			${num('s-rv-rounds', c.review.maxFixRounds, 0, 3, '发现问题最多返工几次')}
			<label class="inline"><input type="checkbox" id="s-rv-fb"${c.review.fallback ? ' checked' : ''}>没额度时换另一家复核</label>
		</div>
		<h2>通知</h2><p class="hint">在任务栏右下角弹出提醒（托盘图标运行时）。</p>
		<div class="row three">
			${[
				['passed', '任务待你验收'],
				['needsHuman', '任务需要你处理'],
				['planned', '拆分方案待你批准'],
				['done', '大任务全部完成'],
				['agentDown', 'AI 暂停或恢复派发'],
			]
				.map(([k, label]) => `<label class="inline"><input type="checkbox" class="s-notify" data-k="${k}"${c.notify[k] ? ' checked' : ''}>${label}</label>`)
				.join('')}
		</div>
		<div class="actions end"><button type="button" class="btn primary" id="saveSettings">保存设置</button></div>
	</div>
	<div class="panel form">
		<h2>项目</h2><p class="hint">登记一个已有的 git 仓库。调度器只会在它的副本里干活，不会改动你正在使用的目录。</p>
		<table><thead><tr><th>名称</th><th>仓库</th><th>基线分支</th><th>准备命令</th><th>验收命令</th><th></th></tr></thead><tbody>
		${c.projects.map((p, i) => `<tr><td>${esc(p.name)}</td><td class="mono">${esc(p.repo)}</td><td>${esc(p.baseBranch)}</td><td class="mono">${p.setup.map((g) => `${esc(g.name)}：${esc(g.cmd)}`).join('<br>') || '无'}</td><td class="mono">${p.gates.map((g) => `${esc(g.name)}：${esc(g.cmd)}`).join('<br>') || '仅检查改动范围'}</td><td><button type="button" class="btn" data-edit="${i}">编辑</button></td></tr>`).join('') || '<tr><td colspan="6" class="hint">还没有项目</td></tr>'}
		</tbody></table>
		<h3 style="margin-top:16px">添加 / 修改项目</h3>
		<div class="row three">
			<label>名称 <span class="opt">英文、数字、横线</span><input id="p-name" placeholder="my-project"></label>
			<label>仓库路径<input id="p-repo" placeholder="D:\\code\\my-project"></label>
			<label>基线分支<input id="p-branch" placeholder="main"></label>
		</div>
		<label>准备命令 <span class="opt">每行一条，格式同下；每个副本建好后、AI 开始前先跑，通常用来装依赖。失败算环境问题，不扣 AI 的轮数</span><textarea id="p-setup" rows="2" placeholder="装依赖 | pnpm install --frozen-lockfile --prefer-offline"></textarea></label>
		<label>验收命令 <span class="opt">每行一条，格式“名称 | 命令”，全部通过才算完成</span><textarea id="p-gates" rows="3" placeholder="单元测试 | node --test"></textarea></label>
		<div class="row two">
			<label>沙盒内自查命令 <span class="opt">可选；AI 在沙盒里跑不了上面的命令时用</span><input id="p-self" placeholder="node --test --experimental-test-isolation=none"></label>
			<label>额外受保护文件 <span class="opt">每行一个，${esc(c.defaultProtected.length)} 条默认规则之外。验收时会被执行的配置（如 package.json、vite.config.*）建议都加上</span><textarea id="p-prot" rows="2" placeholder="package.json"></textarea></label>
		</div>
		<div class="row two">
			<label>同步目标：你自己的仓库 <span class="opt">可选；本机路径或远程地址。设了以后任务详情里可以“推送到你的仓库”（推到新分支 dispatcher/task-编号，不碰已有分支）</span><input id="p-up-repo" placeholder="D:\\code\\my-project 或 https://github.com/你/仓库.git"></label>
			<label>基于你仓库的哪个分支<input id="p-up-branch" placeholder="main"></label>
		</div>
		<div class="actions end"><button type="button" class="btn" id="makeDemo2">创建演示项目</button><button type="button" class="btn primary" id="saveProject">保存项目</button></div>
	</div>`;

	for (const n of ['dsh', 'claude', 'codex']) wireModelPicker(n);
	wireLook();
	$('refreshModels').onclick = () => act(() => api('/api/models/refresh', {})).then(() => renderSettings());

	$('saveSettings').onclick = () => {
		const v = (id) => $(id).value;
		for (const n of ['dsh', 'claude', 'codex']) {
			if ($(`s-${n}-model`).value === CUSTOM && !modelValue(n)) return toast(`${AGENT_NAME[n]} 选了“自定义”，请填写模型名`, true);
		}
		const cliVals = (n) => ({
			enabled: $(`s-${n}-enabled`).checked,
			concurrency: Number(v(`s-${n}-concurrency`)),
			maxAttempts: Number(v(`s-${n}-maxAttempts`)),
			timeoutMinutes: Number(v(`s-${n}-timeoutMinutes`)),
			quotaPauseMinutes: Number(v(`s-${n}-quotaPauseMinutes`)),
			model: modelValue(n),
			effort: v(`s-${n}-effort`),
			usePaid: $(`s-${n}-usePaid`).checked,
			paidDailyMaxRuns: Number(v(`s-${n}-paidDailyMaxRuns`)),
			...(n === 'codex' ? { paidMinBalance: Number(v('s-codex-paidMinBalance') || 0) } : {}),
			...(n === 'claude'
				? {
						paidMethod: v('s-claude-paidMethod'),
						paidMaxUsdPerRun: Number(v('s-claude-paidMaxUsdPerRun')),
						paidDailyMaxUsd: Number(v('s-claude-paidDailyMaxUsd')),
					}
				: {}),
		});
		for (const n of ['claude', 'codex']) {
			if ($(`s-${n}-usePaid`).checked && !c.agents[n].usePaid && !confirm(`开启 ${AGENT_NAME[n]} 的付费额度后，调度器会先用完为你保留的订阅额度，再开始花付费额度（每天最多 ${v(`s-${n}-paidDailyMaxRuns`)} 轮）。确定开启吗？`)) return;
		}
		const escalation = [0, 1, 2].map((i) => v(`s-esc-${i}`)).filter(Boolean);
		act(async () => {
			const r = await api('/api/settings', {
				agents: {
					dsh: {
						concurrency: Number(v('s-dsh-concurrency')),
						maxAttempts: Number(v('s-dsh-maxAttempts')),
						timeoutMinutes: Number(v('s-dsh-timeoutMinutes')),
						dailyTokenBudget: Number(v('s-dsh-dailyTokenBudget')),
						model: modelValue('dsh'),
					},
					claude: cliVals('claude'),
					codex: cliVals('codex'),
				},
				escalation,
				takeover: $('s-takeover').checked,
				quotaGuard: { fiveHourReservePercent: Number(v('s-g-five')), weeklyReservePercent: Number(v('s-g-week')) },
				triage: { agent: v('s-tr-agent'), dshFallback: $('s-tr-dsh').checked },
				review: { enabled: $('s-rv-on').checked, agent: v('s-rv-agent'), scope: v('s-rv-scope'), maxFixRounds: Number(v('s-rv-rounds')), fallback: $('s-rv-fb').checked },
				notify: Object.fromEntries([...document.querySelectorAll('.s-notify')].map((x) => [x.dataset.k, x.checked])),
			});
			renderSettings();
			return r;
		});
	};
	$('settings').querySelectorAll('[data-edit]').forEach((b) => {
		b.onclick = () => {
			const p = c.projects[Number(b.dataset.edit)];
			$('p-name').value = p.name;
			$('p-repo').value = p.repo;
			$('p-branch').value = p.baseBranch;
			$('p-gates').value = p.gates.map((g) => `${g.name} | ${g.cmd}`).join('\n');
			$('p-setup').value = p.setup.map((g) => `${g.name} | ${g.cmd}`).join('\n');
			$('p-up-repo').value = p.upstream?.repo ?? '';
			$('p-up-branch').value = p.upstream?.branch ?? '';
			$('p-self').value = p.selfCheck;
			$('p-prot').value = p.protected.join('\n');
			$('p-name').focus();
		};
	});
	$('saveProject').onclick = () =>
		act(async () => {
			const cmds = (id) =>
				lines($(id).value).map((l) => {
					const i = l.indexOf('|');
					return i < 0 ? { name: l, cmd: l } : { name: l.slice(0, i).trim(), cmd: l.slice(i + 1).trim() };
				});
			const r = await api('/api/projects', {
				name: $('p-name').value,
				repo: $('p-repo').value,
				baseBranch: $('p-branch').value,
				gates: cmds('p-gates'),
				setup: cmds('p-setup'),
				upstream: { repo: $('p-up-repo').value, branch: $('p-up-branch').value },
				selfCheck: $('p-self').value,
				protected: lines($('p-prot').value),
			});
			renderSettings();
			return r;
		});
	$('makeDemo2').onclick = () => act(() => api('/api/demo', {})).then(() => renderSettings());
}

// ---------- 环境检查 ----------
$('runCheck').addEventListener('click', async () => {
	const b = $('runCheck');
	b.disabled = true;
	b.textContent = '检查中…';
	try {
		const r = await api('/api/check', {});
		const bad = r.items.filter((i) => !i.ok).length;
		$('checkList').innerHTML = r.items.map((i) => `<li><span class="${i.ok ? 'y' : 'n'}">${i.ok ? '✔' : '✘'}</span>${esc(i.msg)}</li>`).join('') + `<li><b>${bad ? `${bad} 项未通过` : '全部通过'}</b></li>`;
	} catch (e) {
		toast(e.message, true);
	} finally {
		b.disabled = false;
		b.textContent = '重新检查';
	}
});

// ---------- 页面切换与刷新 ----------
// ---------- 帮助 ----------
// 内容在 help.html；第一次打开时读进来，按 h2 生成目录，搜索只筛“常见问题”
let helpLoaded = null;
function loadHelp() {
	helpLoaded ??= fetch('/help.html')
		.then((r) => r.text())
		.then((html) => {
			$('helpBody').innerHTML = html;
			$('helpToc').innerHTML = `<b>目录</b>${[...$('helpBody').querySelectorAll('section')].map((s) => `<a href="#${s.id}" data-goto-help="${s.id}">${esc(s.querySelector('h2')?.textContent)}</a>`).join('')}`;
			$('faqSearch').addEventListener('input', () => {
				const q = $('faqSearch').value.trim().toLowerCase();
				let shown = 0;
				for (const d of document.querySelectorAll('#helpBody details.faq')) {
					const hit = !q || d.textContent.toLowerCase().includes(q);
					d.hidden = !hit;
					// 搜索时把命中的条目展开，省得再点
					d.open = Boolean(q) && hit;
					if (hit) shown++;
				}
				$('faqEmpty').hidden = shown > 0;
			});
		})
		.catch(() => {
			helpLoaded = null;
			$('helpBody').textContent = '帮助加载失败，请刷新面板再试';
		});
	return helpLoaded;
}

async function gotoHelp(id) {
	switchTab('help');
	await loadHelp();
	document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('click', (e) => {
	const g = e.target.closest('[data-goto-help]');
	if (!g) return;
	e.preventDefault();
	gotoHelp(g.dataset.gotoHelp);
});

function switchTab(name) {
	// 离开设置页时，没保存的外观预览作废
	if (tab === 'settings' && name !== 'settings' && lookDraft) {
		lookDraft = null;
		applyLook(state?.appearance);
	}
	tab = name;
	document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
	document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === `tab-${name}`));
	if (name === 'settings') renderSettings();
	if (name === 'help') loadHelp();
	if (state) render();
}
$('tabs').addEventListener('click', (e) => {
	const b = e.target.closest('button[data-tab]');
	if (b) switchTab(b.dataset.tab);
});

function render() {
	renderTop();
	renderProjects();
	if (tab === 'board') renderBoard();
	if (tab === 'quota') renderQuota();
	if (tab === 'log') renderLog();
}

// ---------- 外观 ----------
// lookDraft：正在设置页里拖滑块预览、还没保存的值；有它时定时刷新不覆盖预览
let lookDraft = null;
function applyLook(a) {
	if (!a) return;
	const b = document.body;
	b.classList.toggle('has-bg', Boolean(a.hasBackground));
	b.style.setProperty('--ui-bg', a.hasBackground ? `url("/background?v=${encodeURIComponent(a.background)}")` : 'none');
	b.style.setProperty('--ui-alpha', `${a.panelOpacity}%`);
	b.style.setProperty('--ui-blur', `${a.blur}px`);
	b.style.setProperty('--ui-dim', String(a.dim / 100));
}

const LOOK_SLIDERS = [
	['panelOpacity', '面板不透明度', 30, 100, '%'],
	['blur', '毛玻璃模糊', 0, 30, ' px'],
	['dim', '背景变暗', 0, 90, '%'],
];

function lookSection() {
	const a = lookDraft ?? state.appearance;
	const sliders = LOOK_SLIDERS.map(([k, label, min, max, unit]) => `<label>${label}<div class="range"><input type="range" class="s-look" data-k="${k}" min="${min}" max="${max}" value="${a[k]}"><output>${a[k]}${unit}</output></div></label>`).join('');
	return `<div class="panel form">
		<h2>外观</h2><p class="hint">选一张图片做背景，再调面板的透明度，让背景透出来。拖动滑块会立即预览，满意后点“保存外观”。</p>
		<div class="row two">
			<div>
				<div class="bgthumb" id="bgThumb" style="${state.appearance.hasBackground ? `background-image:url('/background?v=${encodeURIComponent(state.appearance.background)}')` : ''}">${state.appearance.hasBackground ? '' : '还没有背景图'}</div>
				<div class="actions" style="margin-top:8px"><button type="button" class="btn" id="bgPick">选择图片</button>${state.appearance.hasBackground ? '<button type="button" class="btn ghost danger" id="bgRemove">移除背景</button>' : ''}<input type="file" id="bgFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div>
				<p class="hint">支持 PNG / JPG / WebP / GIF，最大 15 MB。图片只保存在你的电脑上（工作目录的 ui-assets 文件夹）。</p>
			</div>
			<div>${sliders}<p class="hint">没有背景图时，面板保持不透明，这几项不起作用。</p></div>
		</div>
		<div class="actions end"><button type="button" class="btn" id="lookReset">恢复默认</button><button type="button" class="btn primary" id="lookSave">保存外观</button></div>
	</div>`;
}

function wireLook() {
	const cur = () => lookDraft ?? { ...state.appearance };
	document.querySelectorAll('.s-look').forEach((el) => {
		el.oninput = () => {
			lookDraft = { ...cur(), [el.dataset.k]: Number(el.value) };
			const unit = LOOK_SLIDERS.find((s) => s[0] === el.dataset.k)[4];
			el.nextElementSibling.textContent = `${el.value}${unit}`;
			applyLook(lookDraft);
		};
	});
	$('lookSave').onclick = async () => {
		const a = cur();
		const r = await act(() => api('/api/appearance', { panelOpacity: a.panelOpacity, blur: a.blur, dim: a.dim }));
		if (r) lookDraft = null;
	};
	$('lookReset').onclick = () => {
		lookDraft = { ...cur(), panelOpacity: 82, blur: 8, dim: 25 };
		applyLook(lookDraft);
		renderSettings();
	};
	$('bgPick').onclick = () => $('bgFile').click();
	$('bgFile').onchange = () => {
		const f = $('bgFile').files[0];
		if (!f) return;
		if (f.size > 15 * 1024 * 1024) return toast(`图片太大（${(f.size / 1048576).toFixed(1)} MB），最大 15 MB`, true);
		const reader = new FileReader();
		reader.onload = async () => {
			toast('正在上传背景图…');
			const r = await act(() => api('/api/appearance/background', { data: reader.result }), '背景图已设置');
			if (r) renderSettings();
		};
		reader.readAsDataURL(f);
	};
	const rm = $('bgRemove');
	if (rm)
		rm.onclick = async () => {
			if (!confirm('移除背景图吗？图片文件会被删除。')) return;
			const r = await act(() => api('/api/appearance/background/remove', {}));
			if (r) renderSettings();
		};
}

async function refresh() {
	try {
		state = await api('/api/state');
		applyLook(lookDraft ?? state.appearance);
		render();
	} catch (e) {
		$('live').className = 'pill bad';
		$('live').textContent = '连不上调度器';
	}
}

$('quit').addEventListener('click', async () => {
	const busy = state?.tasks.some((t) => t.status === 'running' || t.status === 'gating');
	if (!confirm(busy ? '还有任务在运行，退出会停止它们（下次启动时会标为“需要你处理”）。确定退出吗？' : '确定退出调度器吗？退出后不会再自动处理任务。')) return;
	try {
		await api('/api/shutdown', {});
	} catch {}
	clearInterval(timer);
	$('stopped').hidden = false;
	setTimeout(() => window.close(), 800);
});

refresh();
const timer = setInterval(refresh, 3000);
