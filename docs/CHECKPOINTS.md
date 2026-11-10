# 鸿驿 · 检查点记录

每个阶段结束时追加一节。报告同时会输出到对话里，这里留档，便于「回滚到检查点 N-1」时对照。

---

## 检查点 1 — 插件骨架与设置界面（主链路：信箱直连）

**时间**：2026-11-10 12:10 → 13:05
**结论**：✅ 通过。插件在真实 desktop profile 中激活，`/hongyi/*` 全部 200，设置卡片在
`settings.section` 注册为 `{ registrant: "tk", id: "hongyi", order: 36, active: true }`，
ping → 读回 → 验签 → ack 闭环成立。

### 产出文件（绝对路径）

```
D:\hongyi-build\hongyi\
├── package.json                 # 清单：dsh.bundle.patch / dsh.client / exports / files
├── manifest.json                # 社区草案 v0.15 形状 + x-note（DSH 运行时不读它）
├── cordis.patch.yml             # bundle patch：插入 id=hongyi 条目
├── icon.svg                     # 64×64 信封图标，原创
├── index.js                     # Host 半边：/hongyi 前缀路由 + /hongyi 命令
├── client.js                    # 客户端半边：设置卡片（settings.section, order 36）
├── lib\
│   ├── paths.js                 # $DSH_HOME/hongyi 及全部文件路径
│   ├── store.js                 # JSON/文本读写（临时文件 + rename，永不写 BOM）
│   ├── envelope.js              # 信封、HMAC 签名、版本校验、ping/pong
│   ├── config.js                # 配置与凭据（凭据独立于配置，可撤销）
│   ├── doctor.js                # 9 项自检
│   └── mailbox\client.js        # 信箱客户端 + 四种驱动声明 + 错误归一化
├── locale\{zh,en}.json          # meta.title / meta.description
├── mock\server.mjs              # 本地模拟信箱（零网络、零积分）
├── scripts\
│   ├── smoke-phase1.mjs         # 信封/信箱层端到端（mock 子进程）
│   ├── smoke-host.mjs           # Host 半边（桩 ctx + 真实 socket）
│   └── phase1-proof.mjs         # 检查点证据：写→读→验签→ack→幂等
└── docs\
    ├── PROTOCOL.md              # 信封协议与信箱 API（本阶段新增）
    └── CHECKPOINTS.md           # 本文件
```

### 实测结果

**A. 安装（写入 desktop profile）**

`D:\dsh-data\.dsh\profiles\desktop\package.json`：

- `dependencies` 含 `"dsh-hongyi": "link:D:/hongyi-build/hongyi"`
- `dsh.profile.bundles` 17 条，含 `dsh-hongyi`

> 教训：只写 `dependencies` 不够，必须同时在 `dsh.profile.bundles` 里，否则永不被组合。
> 面板安装在本版本会走宿主内 reload（`profile reload requires the root Include entry`）
> 并回滚，因此本插件用「CLI/直改清单 + 重启桌面端」的方式落地。

**B. 激活（真实实例 http://127.0.0.1:57041）**

```
GET  /hongyi/state  -> 200
{
  "plugin": "dsh-hongyi", "version": "0.1.0", "protocol": 1, "phase": 1,
  "home": "D:\\dsh-data\\.dsh\\hongyi",
  "driver": "mock", "tokenSet": false, "secretSet": true
}
GET  /hongyi/doctor -> 200  9/9 通过
```

`GET /hongyi/doctor` 逐项：

```
✔ node       Node 24.21.0
✔ home       D:\dsh-data\.dsh\hongyi
✔ queue      D:\dsh-data\.dsh\hongyi\queue
✔ driver     mock（http://127.0.0.1:7654）
✔ secret     已设置
✔ reachable  HTTP 200 · hongyi-mock-mailbox · 协议 v1
✔ protocol   信箱 v1 / 插件 v1
✔ wecom      未配置：仅影响实时提醒，不影响收发
✔ link       本期未启用
```

**C. ping → pong（插件快捷路径，POST /hongyi/ping）**

```
{
  "ok": true, "stage": "done",
  "pingId": "event_mwa82vtk_a539a89d6ecbfcdc",
  "message": "ping 已写入并成功读回，签名校验通过，已 ack",
  "envelope": {
    "v": 1, "id": "event_mwa82vtk_a539a89d6ecbfcdc", "type": "event",
    "from": "dsh-pc", "to": "phone", "ts": "2026-11-10T05:01:18.104Z", "ttl": 120,
    "payload": { "kind": "ping", "at": "2026-11-10T05:01:18.104Z", "protocol": 1 },
    "sig": "524fa10b181dc2549f83f639be0625e9b4b9bee9fbdba45b6d698abba65ba60a"
  }
}
```

**D. 底层四步（`node scripts\phase1-proof.mjs`，与插件内部同一条 MailboxClient 路径）**

```
信箱 = http://127.0.0.1:7654 / box = dsh-hongyi / token = 未设置

[1] 写入信箱
    put → {"ok":true,"id":"command_mwa844i0_509591b44c3e84c8","receipt":{"box":"dsh-hongyi","at":"2026-11-10T05:02:16.206Z"}}
    信封 id = command_mwa844i0_509591b44c3e84c8  sig = 8be130a91e989a9aa3c306f5…

[2] 从信箱拉取
    pull → 本次拉回 2 条；命中刚写入的 id = true

[3] 校验协议版本与签名（validateEnvelope）
    v = 1 / 插件 v1 | type = command | phone → dsh
    payload = {"cmd":"status","note":"Phase 1 检查点：写入 → 读回 → 验签 → ack"}
    签名校验通过（HMAC-SHA256 比对一致）

[4] ack 出队
    ack → {"ok":true,"acked":["command_mwa844i0_509591b44c3e84c8"]}
    复查 pull → 1 条；该 id 仍在 = false

[5] 幂等：重复写入同一 id 必须被信箱拒绝（409）
    重复 put → http_error: 信箱返回 HTTP 409：duplicate id

✔ Phase 1 主链路验证通过：写入 → 读回 → 验签 → ack → 幂等（0 次模型调用）
```

**E. 两套回归脚本**

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `node scripts\smoke-phase1.mjs` | pong 往返、重复 id 409、时钟漂移不误删、`ttl=1` 清理、doctor 9/9、错 token 报 `credential_invalid` | exit 0 |
| `node scripts\smoke-host.mjs` | 桩 ctx 驱动的 apply()、1 条 prefix 路由、1 条命令、2 个 effect、GET /hongyi/ping 必须 405、清理函数释放路由与命令 | exit 0 |

**F. 设置卡片（`settings.section` occupant，order 36）**

分区自上而下：

1. **连接状态灯** —— 绿/黄/红三态，文本来自 `/hongyi/state` 与最近一次 probe。
2. **云端信箱** —— 通道下拉（mock 可用，资料库/腾讯文档/IMAP 标「Phase 3 接入」）、
   信箱地址、信箱名、企微 webhook（可选）；按钮：保存 / 测试连接 / 发 ping / 自检。
3. **API 凭据与设备密钥** —— token 密码框（显示 `host••••en`）、保存、撤销、生成新密钥。
4. **自检结果** —— 9 项逐条 ✔/✘ + 修复提示。
5. **WorkBuddy 本地联动（折叠，本期占位）** —— CDP 端口、CLI 路径，只存不连。

所有按钮走 `fetch('/hongyi/…')`；有副作用的动作一律 POST，GET 调用返回 405 并给出
「必须用 POST 调用」的明确文本。

### 本阶段修掉的真 bug

1. `lib/mailbox/client.js` 的 `from './envelope.js'` 应为 `'../envelope.js'`（文件在 `lib/mailbox/` 下）。
2. `client.js` 里一个 JSX 手感写法 `item.hint || '')）` 用了全角括号，`SyntaxError: Unexpected token ')'`。
3. `call('secret')` / `call('revoke')` 只传一个参数 → 走 GET，而这两个动作只接受 POST → 按钮必然 404。
4. mock 的 `/health` 原本不鉴权 → 「测试连接」证明不了凭据有效；改为同样校验 token。
5. 过期清理测试原本用「ts 慢 1 小时 + ttl 1 秒」期望被删，与设计矛盾；拆成两个断言：
   ts 慢 1 小时**不得**被误删 / `ttl=1` 且服务器侧超时**确需**清理。
6. **Host 半边致命缺陷**：`apply()` 里直接读 `ctx.webServer` / `ctx.commands`，
   Cordis 报 `cannot get property "webServer" without inject` → 条目 `absent` → `/hongyi/*` 全 404。
   正确写法是 `ctx.inject(['webServer'], (webCtx) => webCtx.webServer.register(...))`，
   命令同理。这是本阶段最长的一段排障（详见 CHECKPOINTS 附注）。
7. `ctx.logger` 同样是未注入服务，直接调用会抛；改成 try/catch 包住的局部 `warn()`。
8. 清理函数漏释放：`ctx.effect` 分支只 push 了未执行的 disposer；改为在 effect 内执行注册
   并把 disposer 收进 `loose`，返回的 cleanup 做 `loose.splice(0)` 双重释放。

### 附注：为什么之前「所有插件都启动不了」（与本插件无关，但必须记下来）

时间线还原：

1. 11:33 桌面端发生一次 **web-boot 致命错误**（崩溃日志 `crash-2026-11-10T03-33-37-679Z-web-boot.log`，
   后被重启清掉）。
2. 桌面宿主自动执行 `sanitizeProfile()`：把 `cordis.patch.yml` 改名成 `.bak-<Date.now()>`
   （即 `cordis.patch.yml.bak-1794281636220`，时间戳解码正是 11:33:56），
   并把 `dsh.profile.bundles` 削成最小集 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`。
3. 于是重启后所有第三方插件都不在 bundles 里 → 不组合 → 「插件全不见了、设置页也没了」。
4. 12:08–12:09 面板批量 enable 把 14 个包补回 bundles，但面板操作在这一版大面积
   `operation-error`（`dsh-our-free-model`、`dsh-plugin-lx-music`、`dsh-tg-bridge`、
   `dsh-voice-scribe` 等），已 applied 的才留下。
5. 本次修复：手工把 17 个包写回 bundles，并从 11/6 的 patch 备份里恢复
   `agent-default-model` / `comfyui` / `ui-theme` 三条配置
   （另 4 条 `speech-to-text`、`speech-to-text-sensevoice`、`dsh-ops-shell`、`dsh-ops-file`
   的 bundle 当前不存在，恢复会报 `patch: entry "…" not found`，故未恢复）。

**结论**：不是「新加插件破坏组合」——隔离环境把 5 个未组合的包单独/一起加进去，
`--dump-config` 全部 exit 0，无 skipping/incompatible/duplicate。真正的原因是
「一次 web-boot 崩溃触发了宿主的最小化恢复」，加上本插件 Host 半边自身的 inject 缺陷。

### 积分消耗

**0 次模型调用。** 本阶段全部动作是本机 HTTP（插件路由、mock 信箱）、文件读写与
`node --check` / `--dump-config` 之类的静态校验。没有任何遥测、文件传输或指令解析经过模型。

### 需要决策的问题

- 见对话中检查点 1 报告（Phase 3 的 WorkBuddy 资料库授权方式、是否保留 mock 切换开关等）。

### 下一阶段预告

Phase 2：`mock/server.mjs` 已就绪，接下来写 relay（遥测节流、结构化指令本地执行、
自由文本标 `needs_model`、离线队列 `~/.dsh/hongyi/queue/` 退避重试），
并端到端跑通「遥测上行 + 指令下行 + 回执」。

---

## 检查点 2 — 云端信箱与模拟联调（遥测上行 + 指令下行 + 离线补跑）

**时间**：2026-11-10 13:07 → 13:25
**结论**：✅ 通过。relay 引擎在真实 desktop profile 中自动运行（`running:true, intervalMs:15000`），
遥测按「变化才报 / 无变化 600s 汇总 / 30s 心跳」节流，手机侧结构化指令 6 秒内被本地执行并回执，
断链期间队列指数退避积压、恢复后自动补发归零。**本阶段模型调用 0 次。**

### 产出文件（增量，绝对路径）

```
D:\hongyi-build\hongyi\
├── index.js                     # 0.2.0 / phase=2：relay 生命周期 + 6 个新操作 + 6 条新路由
├── client.js                    # 设置卡片新增「中转 · 上行/下行」分区（状态灯/统计/队列明细/4 按钮）
├── lib\relay\
│   ├── outbox.js                # 持久化外发队列：指数退避、parked 不删除、只裁 sent
│   ├── commands.js              # 结构化指令解析（省积分铁律的唯一实现处）
│   ├── telemetry.js             # digestOf + decide（first/change/summary/heartbeat/idle）
│   └── engine.js                # Relay：tick 永不抛、幂等账本、ack 回执、离线补跑
├── lib\paths.js                 # 新增 pendingModelFile / inboundLedger / inboxDir
├── lib\config.js                # 新增 telemetry.minGapSec=10 与 relay.intervalMs=15000
└── scripts\
    ├── smoke-phase2.mjs         # 10 组断言，含断链/恢复场景
    ├── render-check.mjs         # 无 React 环境下的卡片渲染断言（3 个场景）
    └── send-command.mjs         # 手机侧模拟器：写指令 → 等 ack
```

### 关键设计

- **节流**：`decide()` 五种 reason —— `first`（首次）/ `change`（状态摘要变化，受 `minGapSec=10` 限制）/
  `summary`（无变化 600s 汇总）/ `heartbeat`（30s 心跳，`lastContact = max(lastSentAt, lastHeartbeatAt)`）/
  `idle`（不发）。摘要覆盖 online / enabled / driver / box / queuePending / queueParked / lastCommand / lastCommandOk。
- **省积分**：`parseCommand()` 是纯函数无 I/O，只认 `start|stop|status|download|help` 白名单 + 中英正则；
  认不出的结构化命令直接标 `needs_model`（并回执「本地不做语义解析」），**永远不会把结构化指令送进模型**。
- **幂等**：入站账本 `$DSH_HOME/hongyi/inbound.json` 存 id（上限 5000），**先记账再执行**，
  崩溃后重放也不会重复执行；信箱侧重复写入返回 409。
- **离线**：`Outbox` 指数退避 `min(2000·2^(n-1), 300000)`，12 次后转 `parked`（不删除，卡片可重试）；
  `MAX_ENTRIES=500` 只裁 `sent`，**永不丢 pending**。

### 实测结果

**A. 单元/集成（`node scripts/smoke-phase2.mjs`，端口 7665）**

```
✔ telemetry decide：first / idle / change / summary / heartbeat 五种 reason 全部符合预期
✔ digestOf 对队列深度敏感（pending 变化即换摘要）
✔ parseCommand：status、download+URL、中文「状态」「停止同步」、download 非 URL→needs_model、
  未知 cmd reboot→needs_model
✔ 首帧遥测写入信箱：v=1、sig 长度 64、payload.snapshot 全字段
✔ 下一跳 must be idle（节流生效）
✔ 手机写 command(status) → tick 拉取执行 → 回 ack{ackOf,ok,result,file} → 原指令出队
✔ 重复 id 不再执行（skippedDuplicate）
✔ 自由文本入 queue/needs-model.json，回执「本地不做语义解析」
✔ 断链：tick 不抛错、pending≥1、记录 lastError、排定 nextAttemptAt
✔ 恢复：retryAll()+flush() → sent≥1、pending 归零
═══ 结果：全部断言通过 ═══
积分消耗：0 次模型调用
```

**B. 回归（5 个脚本一次跑完，`bg-mwa8vbsd-gram`）**

| 脚本 | 结果 |
|---|---|
| smoke-phase1.mjs | ✔（首次 EADDRINUSE 7654，换端口 `HONGYI_MOCK_PORT=7657` 后全通过） |
| smoke-phase2.mjs | ✔ |
| smoke-host.mjs | ✔（state 显示 v0.2.0 / 协议 v1 / Phase 2，doctor 9/9，405 文案已更新） |
| render-check.mjs | ✔（3 个渲染场景 13+ 条文案断言） |
| phase1-proof.mjs | ✔ |

**C. 真实 desktop 实例（GUI http://127.0.0.1:57676）**

```
GET /hongyi/relay  → {ok:true, running:true, paused:false, intervalMs:15000,
                      status:{ticks:1, sent:1, ...}, outbox:{pending:0}}
GET /hongyi/state  → v0.2.0 · 协议 v1 · phase 2
GET /hongyi/doctor → 9/9
```
发指令：`DSH_HOME=D:/dsh-data/.dsh node scripts/send-command.mjs --cmd status`
```
→ 写入 command_mwa8q2g1_4242d4a2ea9ac3fd
← 6.0s 后收到 ack_mwa8q5bh_bc1aa924d5f89a0b
  payload = {ackOf:"command_mwa8q2g1_…", ok:true,
             result:"在线；driver=mock；信箱=http://127.0.0.1:7654/dsh-hongyi；
                     节流：变化即报 / 汇总 600s", file:null}
```

节流实测（连查三次）：`sent=4 ticks=6` → `sent=4 ticks=7`（一跳被节流）→ `sent=5 ticks=8`。

**D. 离线补跑实测**

```
① 杀掉 mock 信箱 → 45s 后 GET /hongyi/relay
   lastTickError:"信箱不可达：fetch failed"  ticks:10（循环没崩）
   outbox:{pending:2, lastError:"信箱不可达：fetch failed"}
   /hongyi/outbox 两条 telemetry：attempts:2 nextAt:2026-11-10T05:21:42.539Z / attempts:0
② 重启信箱 → 40s 后
   outbox:{pending:0, parked:0, total:0, lastError:null}
   sent 6 → 11，ticks:13，lastTickError:null
```
→ **离线积压自动补发成功，无重复、无丢失。**

### 本阶段修掉的真 bug

1. `telemetry.js` 心跳判断只比 `lastHeartbeatAt` → 「刚发完状态变化 10 秒后又补一条 heartbeat」；
   改为 `lastContact = max(lastSentAt, lastHeartbeatAt)`，成功发送本身也算活着。
2. `outbox.js` `stats()` 的 `nextAt` 用 `Number(entry.nextAt ?? 0)`，新入队条目 `nextAt=null`
   被当成 0 → 永远显示「无重试计划」；改为只统计 `Number(entry.nextAt) > 0` 的 pending 条目。
3. `render-check.mjs` 的 flatten 不渲染函数组件（StatusLight/Field 的文本在子树里）
   → 断言永远缺标签，等于「卡片坏了也报通过」；补 `typeof node.type === 'function'` 分支。
   同时初版立刻执行 effect cleanup（置 `aliveRef=false` 让 setState 全成 no-op、卡片永久停在加载中）
   → 改为渲染循环结束后才 cleanup。

### 环境坑（记下来省下一次排查）

- `smoke-phase1.mjs` 硬编码 bind 7654，离线实验留下的 mock 进程会占端口 → 用
  `HONGYI_MOCK_PORT=<空闲端口>` 覆盖。
- `bgjob_submit_pwsh` 里 `node ... 2>&1` 的日志会被按 UTF-16 解码成 `\u0000` 夹缝乱码，
  读日志用 `Get-Content -Encoding UTF8`；`$LASTEXITCODE` 仍然准确。

### 积分消耗

**0 次模型调用。** 遥测上报、指令解析、文件传输全部由插件脚本直连信箱完成；
`needs_model` 分支只落盘排队，本阶段没有任何代码路径会调用模型。

### 下一阶段预告

Phase 3：把信箱从 mock 切到 **WorkBuddy 资料库**（首选，零注册）——下行写「鸿驿·状态」文档、
上行读「鸿驿·指令」文档；同时保留腾讯文档 API（备选）与 IMAP/SMTP（降级）通道，
`doctor` 增加真实通道的连通性与凭据校验，mock 切换开关保留。


---

## 检查点 3 · 真实信箱接入（QQ 邮箱 IMAP/SMTP 通道）

**时间**：2026-11-10 15:29 → 16:45　**结论**：✅ 真实云端信箱打通，真实实例收发闭环成立，积分 0

### 通道决策过程（为什么最终是邮箱）

| 候选通道 | 勘察结果 | 判定 |
| --- | --- | --- |
| WorkBuddy 资料库 | 本机版本无公开 API：18488 任意路径 Not Found；56257 全部 401 AUTH_REQUIRED；wbipc ticket 三种喂法均无效；39099 editor_sdk MCP 只能建本地临时 xlsx；连接器 connector-states 为空（从未授权过） | ❌ 不可直连 |
| 腾讯文档 API | 需扫码建应用拿凭据（备选通道，暂不动） | ⏸ 备选 |
| tdrive 腾讯网盘同步文件夹 | CLI 已装（1.1.1-beta），`cp`/`ls` 可当双向信箱，但授权链接 5 分钟过期两轮未完成 | ⏸ 待授权（通道代码已就绪） |
| 云文件夹（OneDrive/坚果云） | 本机无任何云盘客户端在真实同步（OneDrive 是 2024 年空壳） | ⏸ 待用户提供目录（通道代码已就绪） |
| **邮箱 IMAP/SMTP** | QQ 邮箱授权码登录即用，手机端可直连同一邮箱，无需任何中间服务 | ✅ **采用** |

插件现在支持 6 条驱动：`mock` / `folder` / `tdrive` / **`imap`（ready）** / `workbuddy-library` / `tencent-docs`（占位），由 `lib/mailbox/factory.js` 统一分派。

### 新增/改动文件

- `lib/mailbox/imap.js`（约 470 行）：`ImapMailbox` + `ImapMailboxError` + `IMAP_PRESETS`（qq/163/gmail/outlook）。put=SMTP 自发自收（标题 `[HongyiBox] <type> <id>`，正文 JSON `{envelope,receivedAt}`）；pull=IMAP `UID SEARCH SUBJECT "HongyiBox" UNSEEN`；ack=`UID STORE +FLAGS.SILENT (\Seen)`（QQ 不允许 CREATE/MOVE 自定义文件夹，改用已读标记）；TTL 按信封 ts+ttl 判；过期清理=STORE \Deleted + EXPUNGE。零第三方依赖，纯 `node:tls`。
- `lib/mailbox/factory.js`：三通道分派 folder/tdrive→FolderMailbox、imap→ImapMailbox、其余→MailboxClient。
- `lib/mailbox/client.js`：驱动表 imap ready:true。
- `lib/config.js`：`imapUser`/`imapProvider` 配置项；凭据文件新增 `imapAuth`（授权码存 `~/.dsh/hongyi/credentials.json`，卡片显示掩码）。
- `index.js`：save 白名单 + `imapUser`/`imapProvider`；新操作/路由 `POST /hongyi/imap-auth`；version 0.3.0 / phase 3。
- `client.js`：imap 模式表单（邮箱地址 / 服务商下拉 / 授权码密码框 / 独立保存按钮；保存时随主表单一并提交）。
- `scripts/smoke-imap.mjs`（6 组 10 断言）、`scripts/send-command.mjs`、`scripts/phase1-proof.mjs` 均改走 factory。

### 本阶段修掉的真 bug（15 条中第 6~15 条，全部手动协议走查证实）

1. SMTP DATA 挂死：buildMail 缺终止符 `\r\n.\r\n`（服务器永远等点号独立行）；加 dot-stuffing。→ put 2.8s OK。
2. QQ SEARCH 中文 0 命中：主题标签改 ASCII `HongyiBox` + RFC2047 base64。
3. searchInbox 不 SELECT INBOX。
4. SEARCH untagged 响应正则匹配不到（`* SEARCH 176`）。
5. fetchRaw `indexOf('\r\n\r\n')` 切在头内部 → 改 literal 语法解析。
6. **QQ 无 UID 前缀的 SEARCH 返回消息序号而非 UID** → 一律 `UID SEARCH`。
7. **literal 按 code-unit 切而长度按字节计**（非 ASCII 邮件 JSON 解析炸）→ Buffer.byteLength + Buffer.slice。
8. QQ IMAP `CREATE` 中文/新建文件夹 NO [CANNOT]，MOVE → NO [NONEXISTENT] → ack 改 \Seen 方案，pull 只搜 UNSEEN。
9. `loadCredentials` 白名单漏 `imapAuth`。
10. probe/QQ 索引延迟 10~40 秒 → 轮询 20 次×3 秒。

### 实测结果（真实 QQ 邮箱 + 真实 DSH 实例，GUI http://127.0.0.1:49897）

- `GET /hongyi/state`：driver=imap、imapUser=1309427334@qq.com、imapAuthSet=true、secretSet=true。
- `GET /hongyi/relay`：running:true、ticks 3→6、sent 2→4、lastTickError:null、outbox 全 0。
- **QQ 邮箱实收**：UNSEEN HongyiBox 6 封，含 uid196/197 `HongyiBox telemetry … payload.kind:state` —— 真实实例遥测已写入真实邮箱。
- **手机→PC 指令闭环**（`node scripts/send-command.mjs --cmd status`）：写入 `command_mwag3wc3_b5f903e1191ccedf` → **66.5 秒**收到回执 `ack_mwag4hrp_62d82ee8af1f25f9`，`payload.ok=true`，result=「在线；driver=imap；信箱=…；节流：变化即报 / 汇总 600s」，原指令已出队。（66.5s = relay 15s 轮询 + QQ 索引延迟 10~40s 叠加，属邮箱通道固有延迟。）
- 全量回归 7 脚本全 exit 0（bg-mwafrl28-719m）：smoke-imap / smoke-phase1（换端口 7664）/ smoke-phase2 / smoke-phase3 / smoke-host / render-check / phase1-proof。

### 💰 积分消耗

本阶段全程 0 次模型调用（所有收发由 Node 脚本直连 IMAP/SMTP 完成）。

### ⏭ 下一阶段预告

Phase 4：手机 APK（Flutter）。SDK 已下载未解压（`D:\hongyi-build\tools\flutter_windows_3.47.9-stable.zip` 1849.6MB、`commandlinetools-win.zip` 146.5MB），需先装 JDK21（winget Microsoft.OpenJDK.21）；若 Android 构建链受阻，按任务书许可先出 Flutter Web 预览版。

---

## 检查点 4 — 手机 APK（Flutter）构建成功

**时间**：2026-11-10 17:00 → 18:15
**结论**：release APK 构建成功，可装真机；4 页面齐全；演示模式无网可用。

### 📁 产出

| 文件 | 说明 |
| --- | --- |
| `D:\hongyi-build\鸿驿.apk` | **最终交付包**，49,518,760 字节（47.2 MB），SHA-256 `c05d9e3925382877aa0cfcac2c3399cfb2a31825b80f85e2961bf0c2cc97d811` |
| `D:\hongyi-build\apk\` | Flutter 工程根 |
| `D:\hongyi-build\apk\lib\protocol.dart` | 信封协议 v1（与 PC 端 `lib/envelope.js` 逐字段对齐） |
| `D:\hongyi-build\apk\lib\mailbox.dart` | 纯 Dart IMAP/SMTP（SecureSocket，零第三方） |
| `D:\hongyi-build\apk\lib\main.dart` | 4 页面 UI + AppModel + 演示后端 |

### 🔧 构建工具链（本机从零搭建）

| 组件 | 版本 / 路径 |
| --- | --- |
| JDK | 21.0.13 LTS · `C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot` |
| Flutter | 3.47.9 stable · `D:\hongyi-build\tools\flutter`（镜像 pub.flutter-io.cn / storage.flutter-io.cn） |
| Android SDK | `D:\hongyi-build\tools\android-sdk`（platform-tools 37.0.1、build-tools 34/36、platforms 34/36、cmdline-tools 23.0.0） |
| NDK | r28c（28.2.13676358）· 手动铺设到 `<sdk>\ndk\28.2.13676358` |

### 🧪 实测

- `flutter analyze`：**0 error**（9 条 info/warning）。
- `flutter build apk --release`：**exit 0**，耗时 7.7 分钟（首次冷构建）。
- `aapt2 dump badging`：`package: com.hongyi.hongyi_mobile`、`versionName 1.0.0`、`minSdk 24`、`targetSdk 36`、`application-label: 鸿驿`。
- `aapt2 dump permissions`：含 `android.permission.INTERNET`、`ACCESS_NETWORK_STATE`。
- `apksigner verify --print-certs`：签名有效（Android Debug 证书，SHA-256 `2ef8b8f6…`）。

### 🩹 本阶段修掉的 4 个真 bug

1. **gradle 分发包下载失败**：`services.gradle.org` 的 gradle-9.3.1-all.zip（234 MB）在国内直连被断。改为腾讯镜像 `mirrors.cloud.tencent.com/gradle/`。注意 `sed` 改不动含 `\:` 的行，用 node 做字符串替换。
2. **Flutter gradle 插件强制装 NDK**：`FlutterPlugin.kt:230` 无条件调用 `forceNdkDownload`，`FlutterPluginUtils.kt:879` 在 `ndkVersion` 非空且未安装时执行 `sdkmanager --install ndk;28.2.13676358` 并校验 `source.properties`，缺失就抛 GradleException。而本版 sdkmanager（23.0.0）对 `ndk;<ver>` 报 `Package ndk not found` —— 包在 `--list` 里明明白白列着，就是装不上（CLI 已弃用转向 Android CLI）。**解法**：直接下官方 `android-ndk-r28c-windows.zip`（748 MB）解压铺到 `<sdk>\ndk\28.2.13676358`。
3. **`stripReleaseDebugSymbols` 失败**：AGP 会用 NDK 的 `llvm-strip` 剥离 `.so` 符号。本工程无原生代码，`libapp.so`/`libflutter.so` 都是预编译产物，剥离无意义。在 `app/build.gradle.kts` 的 release 块加 `ndk { debugSymbolLevel = "none" }` 跳过整个任务。
4. **release 包缺 INTERNET 权限（致命）**：Flutter 模板只在 `src/debug/AndroidManifest.xml` 里声明 INTERNET，release 合并后不带 —— 装到手机上根本连不上邮箱。已在 `src/main/AndroidManifest.xml` 显式加上 `INTERNET` + `ACCESS_NETWORK_STATE`，并把 `android:label` 从 `hongyi_mobile` 改成 **鸿驿**。

### 📱 APK 四页面

1. **状态页**：在线灯（`offlineAfterSec=180`，基于 `pcLastSeenAt` 判活）+ PC 快照（driver / 信箱 / 队列积压 / 最近指令）+ 最近拉取时间 + 指令流水（最近 8 条，等待回执 / 成功 / 失败三态）。
2. **指令页**：`start` / `stop` / `status` / `help` 快捷按钮 + `download <url>` 输入框（校验 http(s) 前缀）+ 自然语言输入框（界面标注「可能消耗积分」）。
3. **传输页**：附件通道占位卡（下一版本），当前引导用 `download` 取文件。
4. **设置页**：演示模式开关 + 邮箱服务商下拉（QQ / 163 / Gmail / Outlook）+ 邮箱地址 + 授权码（密码框）+ 设备密钥 + 保存并连接。

### 📦 安装方式

1. 把 `D:\hongyi-build\鸿驿.apk` 传到手机（微信文件传输助手 / QQ / 数据线均可）。
2. 手机上点开安装，允许「安装未知来源应用」。
3. 打开「鸿驿」→ 设置页 → 关掉演示模式 → 填邮箱 `1309427334@qq.com`、授权码、设备密钥（与电脑端 `~/.dsh/hongyi/credentials.json` 里的 `deviceSecret` 一致）→ 保存并连接。
4. 用 `adb install -r D:\hongyi-build\鸿驿.apk` 也可（需开 USB 调试）。

### 💰 积分消耗

0 次模型调用（构建全程为本地编译）。

### ❓ 待确认

- APK 目前用 **Android Debug 证书**签名（Flutter 模板默认），可正常安装与使用；若要发布到应用商店需另建 release keystore。
- 传输页的文件双向传输尚未实现（任务书 Phase 4 要求「发文件到信箱/取文件」，当前只有 `download` 单向下行）。

### ⏭ 下一阶段预告

Phase 5：A/B/C/D 四组场景测试 + 补齐项（通知分级、指令流水记录页、协议 `v` 字段不兼容提示）。

---

## 检查点 4.6 · 手机指令流水 + 时间字段修复（2026-11-10 20:40）

### 背景
用户 m05191：手机只看到自己发出的东西，看不到「是否发成功 / 回复是什么」；并问手机指令会不会在 DSH 桌面界面产生对话。

### 实测结论
- **PC 端零故障**：`node scripts/send-command.mjs --cmd status` → 8.8s 收到 ack，`result="在线；driver=imap；信箱=1309427334@qq.com/草稿箱（qq · 静默通道）；节流：变化即报 / 汇总 600s"`。
- **手机端同构逻辑零故障**：`apk/tool/app_sim.dart` 复刻 pullOnce/sendCommand → 21s 内 `=== ACK SEEN ackOf=command_mwao1jae_00irpa`。
- **模拟器实测**：v11 装机后点「查状态」，状态页「指令流水」出现 `status · command_mwaofy8e_0056wn` 且带绿色 ✓ 与完整回执文本（`shot-tap1.png`）。

### 本轮修掉的三个真 bug
1. `lib/relay/engine.js` 的 `snapshot()` 里 `recent.map` 漏透传 `ageSec` → 手机「已完成」任务显示「退出 0 · —前」。已补 `ageSec: t.ageSec`。
2. `mailboxWhere(config)` 只有 folder/tdrive 两支，imap 模式下回执仍写 `http://127.0.0.1:7654/dsh-hongyi`（mock 地址）→ 已扩成三支，imap 显示「用户/草稿箱（服务商 · 静默通道）」。
3. `lib/tasks.js` 用 `Date.parse(number)` 得到 NaN → 「已跑 nulls」。已加 `toMs()` 兼容毫秒数字，APK 侧再补 `_dur()` 兜底「—」。

### 新增功能
- `GET /hongyi/commands?limit=` + `/hongyi commands` 子命令 + 设置卡片「手机指令流水」分区：读 `journal.ndjson` 的 `command-executed / command-rejected / command-needs-model`，一份真相两个出口（手机看 ack 邮件、桌面看这张卡）。
- 卡片文案明确：「手机经邮箱发来的指令不会在 DSH 聊天会话里产生对话 —— 中转是插件自己的定时器在跑」。

### 验证
- 离线回归 `bg-mwaobhhe-asiw`：render-check / smoke-host / smoke-phase2 / smoke-phase3 全 exit 0。
- 重启后真实实例（GUI 64317）：`/hongyi/commands?limit=5` → 200，5 条真实条目；`/hongyi/tasks?force=1` → 200，`recent[0]` 含 `ageSec:92845`。
- 重启后 status 回执文案已变成「草稿箱（qq · 静默通道）」—— 误导性的 mock 地址消失。

### 积分消耗
0 次模型调用（全部本机文件 + IMAP 协议往返）。


---

## 检查点 4.7 — 双向文件传输（手机 ⇄ 电脑）

时间：2026-11-10 20:40 – 21:03
结论：**双向文件传输已在真实 QQ 邮箱通道上跑通，两个方向都实测通过，sha256 完全一致。**

### 设计（为什么不用邮件附件）

| 方案 | 问题 |
| --- | --- |
| 把文件当 MIME 附件发 | QQ 草稿箱的附件体积上限未验证；附件要走 multipart 编码，收发两端都要实现 MIME 解析；单封体积增长后 IMAP FETCH 变慢 |
| **切成 N 条 `type=file` 信封**（采用） | 复用已有的幂等 id / TTL / ack / HMAC 签名 / 静默通道；分片天然可续传；单封体积可控 |

信封 payload：

```json
{ "kind": "file", "tid": "file_<base36>_<hex>", "name": "a.txt",
  "size": 105, "sha256": "…", "idx": 0, "total": 1, "data": "<base64>" }
```

- `tid` 标识一次传输，同一次传输的所有分片共用。
- 分片大小：PC 端 256KB / APK 端 128KB（base64 后约 1.37 倍）。
- 单文件上限 200MB。
- 分片落地 `$DSH_HOME/hongyi/inbox/.partial/<tid>/NNNNNN.bin` + `meta.json`；收齐后 `Buffer.concat` → 校验 size 与 sha256 → 落到 `inbox/<name>`（重名加 `-<tid 后 6 位>`），然后删分片。
- 分片有 TTL（默认 1 小时），过期自动清理，不会撑爆信箱。

### 产出文件

| 文件 | 作用 |
| --- | --- |
| `hongyi/lib/transfer.js` | PC 端分片协议：`buildFileEnvelopes` / `sendFile` / `receiveChunk` / `listInbox` / `listPartial` / `prunePartials` / `sha256Hex` / `safeName` |
| `hongyi/lib/relay/engine.js` | `handleOne` 新增 `env.type === 'file'` 分支（收片 → ack 该片 → 永不回 ack 邮件）；status 增 `filesReceived/fileChunks/lastFile` |
| `hongyi/index.js` | `POST /hongyi/send-file`（body.path）、`GET /hongyi/inbox`、操作 `sendFile()`/`inbox()` |
| `hongyi/client.js` | 桌面「文件传输」卡：发送路径 + 「发送到手机」/「刷新收件箱」 + 文件列表 |
| `apk/lib/transfer.dart` | Dart 端同一套分片协议（`buildFileEnvelopes` / `sendFile` / `receiveChunk` / `listInboxFiles`） |
| `apk/lib/main.dart` | 传输页重写为 `TransferPage`：选文件上传（进度条）+ 收件箱列表；`pullOnce` 增 `type=='file'` 分支 |
| `hongyi/scripts/probe-file.mjs` | PC 端往返探针（`--size/--chunk/--keep`） |

### 实测 A — PC 端自身往返（`probe-file.mjs`）

```
通道 imap → 1309427334@qq.com/草稿箱（qq）
分片 256KB，文件 293KB
源文件 样例文件.bin  300000B  sha256 d93bc921f749225c…
切出 2 片，tid=file_mwaoo4w1_0bd94f0f7b
  ✔ 片 0/1  342KB  1802ms
  ✔ 片 1/1   50KB  1287ms
写入 2/2 片，共 3.1s
✔ 拼回 样例文件.bin  300000B  sha256 d93bc921f749225c…  完全一致
— inbox [{"name":"样例文件.bin","size":300000,...}]
已清理 2 条信封；过期分片清理 0
```

### 实测 B — 手机 → 电脑（模拟器真机链路）

1. 造测试文件 `phone-test.txt`（105B，sha256 `d1f9e83e1e22baaaea10cab36ba4f0b509c9f371eea95967beab19fa17854cdc`），`adb push` 到 `/sdcard/Download/`。
2. 模拟器（BlueStacks Pie64 / Android 9）里打开鸿驿 → 传输页 → 「选择文件并发送」→ 系统文件选择器 → 下载 → 选 `phone-test.txt`。
3. App 分片写入 QQ 草稿箱；电脑端 relay 15 秒一轮拉取、收片、拼接、校验、落盘。
4. PC 侧 `GET /hongyi/inbox`：

```json
{"ok":true,"dir":"D:\\dsh-data\\.dsh\\hongyi\\inbox",
 "files":[{"name":"phone-test.txt","size":105,"mtime":"2026-11-10T13:01:50.869Z"}],
 "partial":[]}
```

5. 校验：

```
source 105 d1f9e83e1e22baaaea10cab36ba4f0b509c9f371eea95967beab19fa17854cdc
inbox  105 d1f9e83e1e22baaaea10cab36ba4f0b509c9f371eea95967beab19fa17854cdc
IDENTICAL: true
--- content ---
鸿驿文件传输测试
时间：2026-11-10T13:00:31.632Z
这是一条从手机发往电脑的文件。
```

→ **手机 → 电脑：内容与 sha256 完全一致，全链路约 60 秒（含人工点选与 15s 轮询）。**

### 实测 C — 电脑 → 手机

1. PC 侧造 `pc-to-phone.txt`（89B）。
2. `POST /hongyi/send-file` body `{"path":"D:/hongyi-build/pc-to-phone.txt"}`：

```json
{"ok":true,"tid":"file_mwap9sxd_490511c8c1","name":"pc-to-phone.txt","size":89,
 "sha256":"cec8b469e05811c840617481af2f18dbb3406357237a224c83608fb56d329827",
 "total":1,"sent":1,"reason":null}
```

3. 手机传输页点刷新 → 「已收到 pc-to-phone.txt」+ 列表项 `pc-to-phone.txt / 89 B / 2026-11-10 21:02:37`。

→ **电脑 → 手机：App 收件箱正常展示，分片拼回成功。**

### 本阶段修掉的 3 个真 bug

1. `lib/transfer.js` 的 import 写成 `'../envelope.js'` / `'../store.js'` —— 该文件在 `lib/` 下，同级引用应为 `'./envelope.js'` / `'./store.js'`。报错：`ERR_MODULE_NOT_FOUND: Cannot find module 'D:\hongyi-build\hongyi\envelope.js'`。
2. `sendFile()` 里 `outbox.enqueue / markSent / markFailed` 没做空判 —— relay 未启动时（例如只跑探针脚本）直接崩。改为可选链 `outbox?.enqueue` 等，并只在 `if (outbox?.enqueue)` 里 `await outbox.load?.()`。
3. APK `restore()` 有语法错误：`quiet = p.getBool('quiet') ?? quiet` **缺分号**，且 `}` 后多一个 `;` → `flutter analyze` 报 `error - Expected to find ';' - lib\main.dart:109:37`。

### 环境坑（供后续复用）

- **构建 APK 的 bgjob 里必须自己设环境变量**：`$env:ANDROID_HOME` / `$env:ANDROID_SDK_ROOT`（`D:\hongyi-build\tools\android-sdk`）、`$env:JAVA_HOME`（`C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot`）。不设会报 `[!] No Android SDK found`。
- **Windows 上 Kotlin 增量缓存会锁死**：`shared_preferences_android` / `file_picker` 编译时报 `Could not close incremental caches … class-fq-name-to-source.tab`，清 build 目录也不管用。解法：`apk/android/gradle.properties` 追加 `kotlin.incremental=false` 与 `kotlin.incremental.useClasspathSnapshot=false`。
- **ADB 设备名会变**：先后出现过 `127.0.0.1:5555` 与 `emulator-5554`，脚本里不要写死，用 `adb devices` 取。
- **BlueStacks 未 root**：`adb shell run-as com.hongyi.hongyi_mobile` 报 `setegid(AID_PACKAGE_INFO) failed: Operation not permitted`，读不到 `shared_prefs`；验证 App 内部状态只能靠截图 + 后端接口。
- **模拟器文件选择器入口**：FILE 类型的 file_picker 会拉起系统「打开文档」，默认停在「最近」；要先点左上角三条杠 → 下载，才能看到 `adb push` 进去的文件。

### 产物

- `D:\hongyi-build\鸿驿.apk` — 51,747,916 字节，sha256 `4fbdb79f84405309dc9394a50a366d84da938a5e2daa2cb995c45ef5eb5e95e6`（v13，含文件传输）
- 已装进模拟器 `emulator-5554`（`lastUpdateTime=2026-11-10 20:59:17`）
- PC 端 GUI：`http://127.0.0.1:59859`（`/hongyi/state` → v0.4.0 / phase 4 / driver imap / imapQuiet true）

### 积分消耗

**0 次模型调用。** 分片、base64、HMAC、sha256、IMAP 读写全部是插件与 App 的本地代码，没有一处经过模型。
