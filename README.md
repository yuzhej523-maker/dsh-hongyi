# 鸿驿 · Hongyi

> 用一个邮箱，把 DSH 的状态、任务进度、指令和文件送到手机上。
> **不需要公网 IP，不需要端口映射，不需要自建服务器。**

```
手机 APK  ⇄  QQ 邮箱（草稿箱，静默）  ⇄  DSH 电脑端插件
```

## 为什么

家庭宽带几乎都在运营商级 NAT（CGNAT）后面，做不了端口转发；租 VPS 要钱还要运维。
鸿驿绕开这两件事：**拿一个你本来就有的邮箱当中转站**。

- 手机在 4G/5G、公司 WiFi、国外酒店网络都能用——中间是邮箱，网络本身不关心你在哪。
- 邮件写进**草稿箱**而不是收件箱：不弹新邮件提醒、不进收件箱，只有鸿驿自己用 IMAP 读得到。
- 每条消息带 HMAC-SHA256 签名，篡改会被拒收；文件分片收发，收齐后按 sha256 校验。
- **除「自由文本指令」外全程不调用模型**——遥测、文件传输、结构化指令都是本地代码直接读写邮箱。

前提：电脑开着、DSH 在运行。关机期间消息留在信箱（TTL 1 小时），回来开机补收。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 在线状态 | 手机看电脑是否在线、最近遥测时间、PC 快照 |
| 任务监测 | 看电脑上有哪些任务在跑、跑了多久、日志有没有静止（>3 分钟标「疑似卡住」） |
| 指令下发 | `start` / `stop` / `status` / `tasks` / `download <url>` / `help`，本地解析直接执行 |
| 自由文本 | 存进队列等云端解析（**不消耗本地模型**） |
| 双向传文件 | 手机 ⇄ 电脑，分片 + sha256 校验，单文件 ≤200MB |
| 指令流水 | 桌面设置卡片里能看手机发来过什么、执行结果 |

## 快速开始

```powershell
# 1. 装插件（用 CLI，不要用市场面板——当前版本面板安装会被回滚）
& "D:\Software\10_AI_Tools\deepseekharness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "D:\hongyi-build\hongyi"

# 2. 重启 DSH 桌面版

# 3. 打开 设置 → 鸿驿，填：
#    通道 = 邮箱 · 静默通道
#    邮箱地址 = 你的QQ号@qq.com
#    邮箱服务商 = QQ 邮箱
#    IMAP/SMTP 授权码 = 16 位授权码（设置页内置获取指南）
#    静默通道 = ✅

# 4. 点「生成新密钥」→「显示」→ 复制设备密钥

# 5. 手机装 鸿驿.apk，设置页填同样的四项 → 「保存并连接」
```

**获取 QQ 授权码**：浏览器打开 <https://mail.qq.com> → 设置 → 账号 → 「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」→ 开启「IMAP/SMTP 服务」→ 手机发短信验证 → 得到 16 位授权码（只显示一次）。

> 详细步骤、故障排查、安全说明见 **[docs/MANUAL.md](docs/MANUAL.md)**。

## 目录结构

```
hongyi/
├── package.json          # DSH 插件清单（dsh.bundle.patch + dsh.client）
├── index.js              # Host 半边：HTTP 路由 + /hongyi 命令
├── client.js             # 客户端半边：设置卡片（status / 中转 / 任务 / 文件 / 指令流水）
├── cordis.patch.yml      # bundle patch
├── lib/
│   ├── envelope.js       # 信封 v1：签名、校验、TTL
│   ├── config.js         # 配置与凭据（分离存储）
│   ├── doctor.js         # 自检 9 项
│   ├── tasks.js          # 任务采集（/bgjobs/state → 磁盘兜底）
│   ├── transfer.js       # 文件分片协议
│   ├── mailbox/          # 信箱实现：http mock / 云文件夹 / IMAP(SMTP)
│   └── relay/            # 中转引擎：节流、外发队列、指令解析、幂等账本
├── mock/server.mjs       # 本地模拟信箱（零依赖 HTTP）
├── scripts/              # 回归与探针脚本
└── docs/                 # MANUAL / PROTOCOL / CHECKPOINTS
```

## 协议

统一 JSON 信封（详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)）：

```json
{
  "v": 1,
  "id": "telemetry_mwajx...",
  "type": "telemetry | file | command | ack | event",
  "from": "dsh-pc",
  "to": "phone",
  "ts": "2026-11-10T13:00:31.632Z",
  "ttl": 3600,
  "payload": { },
  "sig": "<hex HMAC-SHA256>"
}
```

- `id` 全局唯一，用于**幂等去重**（先记账再执行，崩溃后重放也不会重复干活）。
- `sig` = HMAC-SHA256(设备密钥, `v \u0001 id \u0001 type \u0001 from \u0001 to \u0001 ts \u0001 ttl \u0001 payload`)，两端不一致直接拒收。
- TTL 按**服务器**时钟判定（避免本机时钟漂移误删）。

## 省积分设计

| 操作 | 调模型 |
| --- | --- |
| 遥测上报（变化才报 / 无变化 10 分钟汇总 / 30 秒心跳） | ❌ |
| 结构化指令解析与执行 | ❌ |
| 文件分片传输 | ❌ |
| 自由文本指令 | ✅ 仅此一项 |

## 开发与测试

```bash
npm test          # smoke-host + render-check（离线，不需要真邮箱）
npm run test:all  # 加 smoke-phase1/2/3（需要 mock 信箱）
npm run test:imap # 真实邮箱静默通道探针（需要凭据）
```

回归脚本全绿是发版前的底线。检查点记录见 [docs/CHECKPOINTS.md](docs/CHECKPOINTS.md)。

## 安全边界

- 授权码与设备密钥只存在 `$DSH_HOME/hongyi/credentials.json`，不进 profile 配置、不同步任何地方。
- 消息**经过腾讯邮件服务器**，内容是明文 JSON——**只有签名保证不被篡改，没有加密**。不要用它传敏感文件。
- 设备密钥泄露等于别人能给你的电脑下指令；重新生成后两端都要改。
- 插件只写 `$DSH_HOME/hongyi/`，不碰其它文件；不上报任何遥测到邮箱以外的地址。

## License

MIT
