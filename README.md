**简体中文** | [English](README.en.md) | [日本語](README.ja.md)

# AI 调度器

本地任务调度器：把低难度、重复性的工作交给便宜的 DSH（DeepSeek Harness），疑难和复核留给 Claude / Codex，最终验收交给人。

当前版本 v0.2：DSH、Claude、Codex 三个代理都已接入；自动判断难度分配、失败自动升级（默认 DSH → Claude → Codex → 人）、验收通过后另一家复核、大任务拆分、一键合并 / 撤销、导出补丁 / 推送到你自己的仓库、项目准备命令、订阅额度保护、托盘通知、图形面板和自定义外观。**面板里的“帮助”页**有上手教程、一次复杂任务的完整流程和常见问题。手机远程还没做。

v0.2 相比 v0.1：新增面板“帮助”页；导出补丁和推送到你的仓库；验收时会被执行的构建配置（`build.rs`、`.cargo`、`.npmrc` 等）默认受保护；修复 pnpm 新版本的依赖缓存位置、删除任务副本时残留 `node_modules` 的问题。

## 给第一次使用的人

**需要准备：**

| 必需 | 说明 |
|---|---|
| Windows 10 / 11 | 托盘、通知、面板窗口都依赖 Windows（面板用系统自带的 Edge 打开） |
| [Node.js](https://nodejs.org/) 24 或更高 | 调度器直接运行 TypeScript，不需要 `npm install` |
| [Git for Windows](https://git-scm.com/download/win) | 每个任务在独立的 git 副本里做 |
| [DeepSeek Harness](https://www.deepseek.com/) 桌面版 + DeepSeek API key | 便宜的主力 AI（DSH）。key 在 DeepSeek 开放平台申请，按用量付费 |

| 可选 | 说明 |
|---|---|
| Claude Code（Claude Pro 等订阅） | 安装 Claude 桌面版或命令行后登录即可，调度器会自动找到 |
| Codex（ChatGPT Plus 等订阅） | 安装 Codex 桌面版后登录即可 |
| pnpm / Rust / Python | 你的项目需要时，用下面的 `安装工具.ps1` 装进程序目录，不改系统设置 |

**安装步骤：**

1. 把压缩包解压到一个固定的位置（例如 `D:\AI调度器`），之后不要再移动。
2. 双击 **`首次安装.cmd`**：检查 Node 和 Git、生成配置、在桌面创建“AI 调度器”快捷方式。工作目录默认是程序所在盘的 `AgentWork`（例如 `D:\AgentWork`），任务副本、日志、数据库都放在那里。
3. 把 DeepSeek API key **单独**保存成文本文件 `工作目录\secrets\deepseek.key`（文件里只放 key 本身）。不要把 key 发给别人或截图。
4. 可选：右键 **`安装工具.ps1`** → “使用 PowerShell 运行”，按提示选择要装的工具（只从官方地址下载，并核对校验值）。
5. 双击桌面上的 **“AI 调度器”**，在“环境检查”页点“开始检查”，全部打勾就可以用了。
6. 第一次可以在“设置 → 项目”里点“创建演示项目”，再新建一个任务试试。

**需要知道的安全事项：**

- AI 在各自的沙盒里干活，调度器还会实时审计每一步，越界就终止。但**验收命令是以你的身份、在沙盒外运行的**（它会执行 AI 改过的代码），所以只把你信得过的项目交给它，难的任务尽量在你在场时跑。
- 合并进项目前会先在临时副本里复检，有冲突或检查没通过就不动你的项目；合并后也能一键撤销。
- 面板只监听本机，每次启动生成随机口令。

## 运行要求

- Windows，Node 24 以上（直接运行 TypeScript，零依赖）
- Git for Windows
- DeepSeek Harness 桌面版（用它自带的 headless 模式）

## 日常使用（面板）

1. 第一次：运行 `.\bin\dispatch.cmd shortcut`，桌面会出现“AI 调度器”。
2. 以后双击它：调度器在后台启动（没有命令行窗口），并打开面板窗口。已经在运行时再双击只会打开窗口。
3. 在面板里新建任务、查看进度和额度、接受或驳回结果、改设置、做环境检查。
4. 关掉面板窗口不会停止调度器（它会继续处理队列），右下角托盘会有它的图标：双击或右键“打开面板”重新打开，右键“彻底退出调度器”停止。面板右上角的“退出调度器”效果相同。
5. 任务变成“待你验收”“需要你处理”、拆分方案待批准、某个 AI 暂停派发时，会弹出 Windows 通知（显示为“AI 调度器”，会留在通知中心）；双击托盘图标打开面板。哪些要通知在“设置 → 通知”里选，托盘右键菜单可以发一条测试通知。
6. 驳回时写的原因会在重试时交给 AI：卡片上的“重试”在原分支、原路径上接着上一版改（会话也能接上）；“从头重来”从原始状态开始，但同样带上意见。按意见修改的一轮如果没有任何新改动，不算通过。
7. “已驳回”“已结束”两栏可以一键清除：只是从看板隐藏，记录、日志和分支都保留（命令行：`dispatch clear`）。

付费额度（设置里每个代理单独开关，默认关闭）：订阅额度到保留线后继续派发。Codex 用充值余额，可设余额下限；Claude 可选“claude.ai 额外用量”或“Console API Key”（后者把 key 存到 `工作目录\secrets\anthropic.key`，每轮用 `--max-budget-usd` 限额，另有每日美元上限）。两者都有每日运行次数上限。Claude 和 Codex 一方接不了活时，排队任务会自动转给另一方（可关闭）。

子代理（新建任务时给 DSH / Claude / Codex 分别选“最多 N 个”，默认都不使用；只在那一家处理这个任务时生效，升级给别家后用别家的设置）：只给这个任务打开子代理，并行改的文件要分开，超过数量或越界就结束整个进程，子代理的用量并进本轮。
- DSH：子代理动作不在事件流里，每秒读 `DSH_HOME\sessions\…\session.v4.jsonl.zstd` 审计；不能再派子代理。
- Claude：放行 Agent 工具；子代理的工具调用在 stream-json 里带 `parent_tool_use_id`，现有审计直接覆盖；用量取 `modelUsage`。
- Codex：去掉 `features.multi_agent=false`；子代理动作不在事件流里，每秒读 `~\.codex\sessions\年\月\日\rollout-*.jsonl`（按 `parent_thread_id` 认领）审计。每个子代理约多 5 万输入 token（多数命中缓存）。
- 默认情况下 Codex 的子代理是关闭的（它自己的默认是开）。

额度刷新：Claude 的额度通过 Claude Code 的本地命令 `/usage` 读取，不调用模型、不消耗额度；调度器启动时和之后每 5 分钟自动刷新一次，面板上也有“刷新额度”按钮。

面板只监听本机，每次启动生成随机口令，其他网页无法冒充你操作；运行日志在 `工作目录\logs\dispatcher.log`。

额度保护：面板一律显示剩余额度。Claude / Codex 的 5 小时或每周额度剩余降到为你保留的比例（默认都是 15%）就不再自动派发。Codex 的额度从 `~\.codex\sessions` 的会话记录读取（含你自己的使用），Claude 的额度来自最近一次 Claude 运行。

## 快速开始（命令行）

```powershell
.\bin\dispatch.cmd init      # 生成 dispatcher.config.json，创建工作目录（默认程序所在盘的 AgentWork，可加 --work-root 指定）
# 把 DeepSeek key 单独保存到 工作目录\secrets\deepseek.key
.\bin\dispatch.cmd check     # 环境自检，不调用模型
.\bin\dispatch.cmd demo      # 创建演示项目（两个待实现的函数 + 测试）
.\bin\dispatch.cmd add --project demo --title "实现 slugify 和 countWords" --allow "src/**" --readonly "test/**" --spec "按注释实现，让测试通过"
.\bin\dispatch.cmd run       # 启动调度器，看板在 http://127.0.0.1:7788/
```

其余命令：`list`、`show <id>`、`accept <id>`、`reject <id>`、`retry <id> [--fresh]`、`cancel <id>`。

## 一个任务的流程

1. 从项目的基线分支拉出独立 worktree 和分支 `task/<id>-<时间>`，放在 `工作目录\wt` 下。
2. 启动 DSH headless worker：当前目录就是 worktree，沙盒为 `workspace-write`，关闭子代理和网页工具，每个任务一个独立的 `DSH_HOME`。
3. 实时审计每个工具调用：写到工作区外、读凭据目录、`git push/commit/config`、申请提权，都会立即终止 worker，任务转为“需要你处理”。
4. 验收关卡：有改动、未碰受保护文件、未碰本任务只读文件（通常是测试）、在允许范围内、规模不超限，最后运行项目配置的命令。
5. 通过 → 调度器以 `dsh worker` 身份提交到任务分支，等你 `accept`；未通过 → 用 session 续聊、带着失败报告重试，用完轮次后保留现场交给你。
6. 验收：面板里点“接受并合并到项目”（或 `merge <id>`）。先在临时副本里合并并重跑验收命令，有冲突或没通过就不动项目；你检出基线分支且有未提交改动时拒绝合并。撤销合并用反向提交。也可以“只接受”，自己合并。

## 大任务拆分

新建任务时勾选“先拆分成小任务”：

1. 负责拆分的 AI（默认 Codex）只读代码，给出小任务清单：每项的说明、允许修改的文件、交给谁、要等哪几项先合并。
2. 你在面板里审阅，可以直接改、删、加，然后“批准并开始”；不满意就写意见“让 AI 重新拆分”。
3. 批准后生成子任务。有先后关系的子任务要等前一项**合并进项目**后才开始，这样它拿得到前一项的代码。
4. 勾了“自动合并”时，每个子任务验收通过后自动合并（同样先复检，合并一次只做一个）；不勾就由你逐个合并。
5. 全部子任务合并后，大任务显示“已合并”。取消大任务会一起取消还没结束的子任务，已合并的保留。

## 三个代理

| 代理 | 启动方式 | 限制 |
|---|---|---|
| DSH | headless `--json`，按 token 计预算 | 自带沙盒 workspace-write，关闭子代理和联网 |
| Claude | `claude -p --output-format stream-json` | `--restricted`、不读用户设置和 MCP、无人审批（一律拒绝）、命令只放行项目的验收/自查命令和只读 git |
| Codex | `codex exec --json` | 忽略用户配置（插件、MCP、记忆），单独开启 Windows 沙盒，workspace-write、禁网、从不请求审批 |

- 某个代理用完轮次仍未通过，调度器保留失败现场并交给升级链上的下一个，新代理第一轮会收到交接说明。
- Claude / Codex 报“额度用完”时：不计轮次，任务放回队列，该代理暂停到恢复时间（解析不出就暂停 `quotaPauseMinutes`）。
- 找不到程序或未登录的代理不会进入升级链，`check` 会提示怎么登录。
- 三家的沙盒都禁止启动带管道的子进程（例如 `node --test` 默认会报 spawn EPERM），所以项目可配置 `selfCheck`：一条在沙盒里也能跑的自查命令。最终验收始终由调度器在沙盒外执行。

## 安全模型与已知缺口

- 工作区目录必须对当前用户有“完全控制”权限（DSH 沙盒要靠它给工作区授权），`check` 会检查并给出修复命令。

- DSH 沙盒拦写不拦读（已实测），读取靠审计兜底，属于尽力而为。
- **验收命令在沙盒外以你的身份运行，执行的是 worker 改过的代码。** 只读测试和路径检查能挡住偷改测试，挡不住恶意代码。无人值守过夜运行前，应把 worker 和验收放进单独的 Windows 账户或容器。
- 环境错误（凭据、余额、网络）不计入重试次数，会直接交给你处理。
- 面板只监听本机；写操作要带每次启动随机生成的口令，并校验 Host / Origin / JSON 类型，防止其他网页跨站冒充操作。

## 目录

| 路径 | 内容 |
|---|---|
| `src/adapters/dsh.ts` | DSH 启动、事件流解析、token 记账、实时审计 |
| `src/audit.ts` | 工具调用审计规则 |
| `src/gates.ts` | 验收关卡 |
| `src/runner.ts` | 调度循环：并发、预算、重试、状态流转 |
| `src/db.ts` | SQLite 存储（`工作目录\dispatcher.db`） |
| `src/server.ts` | 本机面板服务（口令 + Host/Origin 校验） |
| `src/actions.ts` | 命令行和面板共用的操作 |
| `src/quota.ts` | 订阅额度读取与额度保护 |
| `ui/` | 面板页面；图标由 `scripts/make-icon.ts` 生成 |
| `test/` | `npm test`，用假 worker 跑完整流程，不调用模型 |

## 许可证

[MIT](LICENSE) © AmaneSyou
