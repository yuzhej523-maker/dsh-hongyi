## 检查点 4.5 · 任务实时监测 + 静默通道（用户 2026-11-10 19:xx 追加需求）

> 用户原话：「如果我之前给电脑布置了一系列任务，我想通过手机端进行监测，看它执行到哪儿，是否有卡壳……并且这个 QQ 邮箱里的实时弹出信息可以表面已读，甚至隐藏掉吗？就是只是针对于机器能识别到。」

### ✅ 本阶段完成

两件独立的事，都在 PC 端做完并实测通过：

#### A. 任务实时监测（手机能看到电脑在跑什么、有没有卡壳）

| 层 | 文件 | 做了什么 |
| --- | --- | --- |
| 采集 | `lib/tasks.js`（新） | `collectTasks({origin, workdirs, …})` 优先走 `GET <webServer origin>/bgjobs/state`（4 秒 AbortController 超时），失败自动退回扫 `<workdir>/.dsh/bgjobs/*/job.json`。每条产出 `{id,name,status,exitCode,engine,ageSec,idleSec,stalled,tail}`。**卡壳判定**：`running && idleSec >= stallAfterSec`（默认 180s），`idleSec` 取 stdout.log 的 mtime —— 任务在跑但日志不动就是卡了。 |
| 指令 | `lib/relay/commands.js` | 本地动作白名单加 `tasks`；自然语言正则覆盖 `tasks / jobs / tasklist / 任务 / 任务列表 / 在跑什么 / 跑到哪 / 卡住了吗`（放在 status 之前，避免「进度」抢词）。 |
| 上报 | `lib/relay/telemetry.js` | `digestOf()` 的 canonical 加入 `tasks.signature`（= 运行中 id 列表 + 失败 id:exitCode + 最新一条 id 的短哈希）。**新任务开跑 / 结束 / 卡住会立刻触发一次上报，但「日志多打一行」不会发信**。 |
| 引擎 | `lib/relay/engine.js` | `snapshot()` 带 `tasks` 字段；`tasks({push, maxAgeMs=10000})` 10 秒缓存避免一跳里重复扫盘，失败只记 `status.tasksError` + journal，**永不抛**。`tasks` 指令走 `describeTasks()` 出中文摘要回执。 |
| 宿主 | `index.js` | 注入 `collectTasks`（origin 从 `webServer.getOrigin()` 取、workdirs 从配置取、空则 `process.cwd()`）；新增 `GET /hongyi/tasks?force=1`；`/hongyi tasks` 命令；version → `0.4.0`、phase → `4`。 |
| 卡片 | `client.js` | 新增「任务监测」分区：三个状态灯（运行中 / 疑似卡住 / 失败）+ 前 5 条任务（`▶ ⏸ ✔ ✘` + 名称 + 已跑/静默秒数 + 日志尾 160 字）+「刷新任务列表」按钮。 |
| 手机 | `apk/lib/main.dart` | 状态页新增任务卡片（同样三色 chip + 前 5 条 + 日志尾）；指令页加「看任务」快捷按钮。 |

#### B. 静默通道（邮件不弹提醒、只给机器读）

**先做了两组可行性实验再动手**（脚本留在 `scripts/imap-folder-probe.mjs`、`scripts/imap-drafts-probe.mjs`）：

- QQ IMAP 的 `LIST "" "*"` 只有 `INBOX / Sent Messages / Drafts / Deleted Messages / Junk`；
- `CREATE "鸿驿"` → **`NO [CANNOT] Invalid folder name. Create the parent folder first…`** —— QQ **不允许自定义文件夹**，「建个专用文件夹然后 MOVE 进去」这条路彻底不通；
- 但 `APPEND` 到 `Drafts` → `OK [APPENDUID …]`，**可写**；`UID SEARCH ALL` 能看到；`UID FETCH (BODY.PEEK[])` 能读回完整 JSON；`UID STORE \Deleted` + `EXPUNGE` 能删干净。

→ **草稿箱就是天然的静默信箱**：APPEND 进去不走 SMTP、不进收件箱、不弹任何新邮件提醒，机器用 IMAP 照样读得到，读完删掉不留痕。比「打 \Seen」彻底得多（打已读邮件还在收件箱、App 里仍看得见）。

实现：
- `lib/mailbox/imap.js`：`ImapMailbox` 新增 `quiet`（默认 true）/ `quietFolder`（preset 里的 `draftsFolder`：qq/163/outlook=`Drafts`、gmail=`[Gmail]/Drafts`）。`put()` 走 `select(草稿箱)` + `append()`；`pull()` 走 `searchAllUids()`（草稿箱里 `SEARCH SUBJECT` 实测 0 命中，不可靠）后自筛；`ack()` = 删草稿。`ImapConnection` 新增 `select()` / `searchAllUids()` / `append()`（两阶段写：`APPEND … {N}` → 等 `+` 续行 → 正文 → 标签 OK）。
- `lib/config.js`：`imapQuiet: true`、`imapQuietFolder: ''`（空=用服务商默认草稿箱名）。
- `client.js`：imap 模式下多一个「静默通道」复选框。
- `apk/lib/mailbox.dart`：Dart 侧同样实现 `quiet`（`MailPreset.draftsFolder`、`select/searchAllUids/append/deleteUids`），设置页加「静默通道（推荐）」开关。

### 🧪 实测结果

**静默通道**（`scripts/imap-quiet-probe.mjs`，job `bg-mwalz4wu-8d3y`，exit 0）：

```
═══ 静默通道实测（qq / 草稿箱 Drafts） ═══
起点：收件箱未读 1 / 共 487 · 草稿箱 2 封
✔ put 走静默通道（草稿箱 APPEND） — folder=Drafts
✔ 草稿箱多了一封 — 2 → 3
✔ 收件箱未读没有变化（不会弹新邮件提醒） — UNSEEN 1 → 1
✔ 从草稿箱读回了该信封 — 2 封里命中
✔ 读回的信封签名有效（机器可读且可信）
✔ ack 执行完成 — uid:5
✔ 草稿箱回到原来数量（没污染用户草稿） — 2 → 2
✔ describe 正确区分静默/普通模式 — 邮箱 · 静默通道（草稿箱，不弹提醒）
结果：8 通过 / 0 失败（耗时 8s） · 积分消耗：0 次模型调用
```

**设置卡片渲染**（`scripts/render-check.mjs`，三场景）：新增断言「任务监测 / 运行中 2 / 疑似卡住 1 / 失败 1 / hongyi-apk-build / sdk-download / regress-all / 刷新任务列表」全部出现；降级场景断言「采集失败：/bgjobs/state 不可达」正常显示 —— 全绿。

**Host 回归**（4 脚本）：smoke-host / smoke-phase2（含断链补发）/ smoke-phase3（44 通过 0 失败）/ render-check 全 exit 0。

### 🐞 本阶段修掉的真 bug

1. **`expungeDeleted()` 在错误的文件夹里执行**：原判断 `if (!this.selected)` 就 `SELECT INBOX`，而 `ack()` 已经 SELECT 了 Drafts，`this.selected` 早已是 true → \Deleted/EXPUNGE 打到了**收件箱**上，草稿永远删不掉（表现为「草稿箱 2→3，删完仍 3」）。改为判 `if (!this.selectedFolder)`。这个 bug 只有在静默模式下才会暴露，普通模式看不出来。
2. **任务签名把「日志多一行」也算变化**：初版 digest 直接拿 `tail` 入哈希 → 每个 tick 都想发信。改为只哈希「运行中 id 列表 + 失败 id:exitCode + 最新任务 id」。
3. **`stats()` 里 `nextAt=null` 被当成 0**（上一阶段遗留，本阶段复查确认已修）：新入队条目 `nextAt` 为 null，`Math.min(…, 0)` 会让"下次重试"永远显示过去时间。现只统计 `Number(nextAt) > 0` 的 pending 条目。

### 💰 积分消耗

**0 次模型调用**。所有新能力都是本机文件/HTTP 扫描 + IMAP 协议操作；`tasks` 指令的解析走本地正则白名单，不经过任何模型。

### ❓ 需要决策的问题

- **APK 是否需要一并重装**：v9 已包含任务卡片与静默开关，旧包（v8 及更早）看不到这两项新功能。
- **卡壳阈值**（当前 180 秒）是否合适：长任务里打印很慢的（例如挂着等网络）会一直显示「疑似卡住」。可在 `/hongyi/tasks` 的配置里调，需要的话我加个设置项。

### ⏭ 下一阶段预告

Phase 5：A/B/C/D 四组场景测试 + 补齐项（通知分级、指令流水记录页、协议 `v` 不兼容提示）。
