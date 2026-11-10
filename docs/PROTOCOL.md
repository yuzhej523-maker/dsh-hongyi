# 鸿驿 · 信封协议与信箱 API（v1）

本文是两端（PC 插件 / 手机 APK）唯一的契约来源。任何一端改动字段、签名或信箱调用，
都必须先改这份文档并升 `v`。

---

## 1. 为什么是「信箱」而不是「服务器」

本项目不新建任何常驻服务：中转面 100% 借用你自己已有的设施（WorkBuddy 资料库 /
腾讯文档 / 邮箱）。它们都是「能存一段文本、能取回一段文本」的键值/文档空间，
因此协议只需定义三件事：

1. 一个信封长什么样（一条消息 = 一个信封）；
2. 收发调用的形状（写、拉、ack、健康检查）；
3. 谁在什么时候可以删掉它（TTL 与 ack）。

传输层完全可换（mock → 资料库 → 腾讯文档 → IMAP），信封本身不变。

---

## 2. 信封（Envelope）

```json
{
  "v": 1,
  "id": "telemetry_mwa844i0_509591b44c3e84c8",
  "type": "telemetry",
  "from": "dsh-pc",
  "to": "phone",
  "ts": "2026-11-10T05:02:16.206Z",
  "ttl": 300,
  "payload": { "kind": "state", "online": true },
  "sig": "8be130a91e989a9aa3c306f5…"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `v` | number | 协议版本，**必填**。当前 `1`。缺 `v` 或版本不符 → 明确报错，不静默丢弃。 |
| `id` | string | 全局唯一，**唯一的幂等键**。任何消费者遇到重复 `id` 必须当作「已处理」。生成格式 `<type>_<base36 毫秒>_<16 位 hex>`。 |
| `type` | string | `telemetry` / `file` / `command` / `ack` / `event` 五选一。 |
| `from` | string | 发送方标识（`dsh-pc` / `phone`）。 |
| `to` | string | 接收方标识。 |
| `ts` | string | ISO-8601 UTC 时间戳，发送方时钟。**不用于 TTL 判定**（理由见 §5）。 |
| `ttl` | number | 存活秒数。`0` 或负数 = 永不过期。 |
| `payload` | object | 业务负载，随 `type` 变化。 |
| `sig` | string | HMAC-SHA256 十六进制；未配置设备密钥时为 `""`。 |

### 各 type 的 payload 约定

| type | 方向 | payload |
| --- | --- | --- |
| `telemetry` | PC → 手机 | `{ kind: 'state' \| 'summary', online: bool, heartbeatAt, ... }` |
| `file` | 双向 | `{ name, size, sha256, chunk: n, total: m, data }` |
| `command` | 手机 → PC | `{ cmd: 'start' \| 'stop' \| 'status' \| 'download', arg?, text?, needs_model?: bool }` |
| `ack` | 双向 | `{ ackOf: '<envelope id>', ok: bool, result?, error? }` |
| `event` | 双向 | `{ kind: 'ping' \| 'pong' \| 'log', ... }` |

---

## 3. 签名

签名覆盖**固定顺序的 8 个字段**，用 `\u0001` 连接，保证两端读到同一串字节
（JSON 键顺序无关）：

```
v \u0001 id \u0001 type \u0001 from \u0001 to \u0001 ts \u0001 ttl \u0001 JSON(payload)
```

```
sig = hex(HMAC-SHA256(deviceSecret, signingBase))
```

- 校验用**定时安全比较**（`crypto.timingSafeEqual`），不做字符串 `===`。
- 未配置密钥时 `sig` 为空串，校验放行——这是 Phase 1/2 的本地 mock 期便利；
  Phase 3 真机联调必须配置密钥，否则 doctor 报红。
- 密钥只存在 `$DSH_HOME/hongyi/credentials.json`（POSIX 下 0600），
  **不写进** `config.json`、**不写进** profile 的 `cordis.patch.yml`、**不打印**到日志。

---

## 4. 幂等与去重

- 写：同一 `id` 二次写入，信箱返回 **HTTP 409 `duplicate id`**，客户端视为「已经写过了」而非错误。
- 读：消费者在本地维护已处理 `id` 集合（插件用 `$DSH_HOME/hongyi/journal.jsonl`），
  命中即跳过，**不重复执行指令、不重复回执**。
- ack：幂等，重复 ack 同一 `id` 无害。

D 组「误操作：连点 10 次」与 B 组「补跑时幂等跳过」都只依赖这一条。

---

## 5. TTL：按**服务器**时钟，不按信封自己的 `ts`

规则：`expired = (serverNow - receivedAt) > ttl * 1000`。

- `receivedAt` 是信箱收到信封的时刻（服务器侧），不看信封里的 `ts`；
- 因此本机时钟快/慢 1 小时，**不会**导致好数据被误删，**也不会**让过期数据赖着不走
  （C 组「时钟漂移」项的设计依据）；
- `ttl ≤ 0` 表示永久保留，只靠 ack 出队。

`pull` 只返回**未 ack 且未过期**的信封；acked 的条目只是被隐藏，不参与 `pull`。

---

## 6. 信箱 HTTP 契约

所有驱动（mock / 资料库 / 腾讯文档 / IMAP）对插件暴露同一组语义：

```
POST {base}/mailbox/{box}              body { envelope }        -> { ok, id, receipt }
GET  {base}/mailbox/{box}?since=&limit=                          -> { items: [...] }
POST {base}/mailbox/{box}/ack          body { ids: [...] }       -> { ok, acked: [...] }
GET  {base}/health                                               -> { ok, service, protocol, ... }
```

- `since` 为 ISO 时间或省略（省略 = 从最早未 ack 的取起）。
- `limit` 缺省 20。
- **`/health` 也必须鉴权**：设置卡片的「测试连接」要证明凭据有效，而不是证明端口开着。
- 认证：`Authorization: Bearer <token>`。

### 错误码（客户端归一化后的 `MailboxError.code`）

| code | 触发 | UI 表现 |
| --- | --- | --- |
| `no_base_url` | 未填信箱地址 | 卡片红：「信箱地址未配置」 |
| `unreachable` | 连接失败/DNS/拒连 | 卡片黄：「信箱不可达」+ 自动退避重试 |
| `timeout` | 超过 8s 未响应 | 同上，日志标 `timeout` |
| `credential_invalid` | HTTP 401/403 | 卡片红：「凭据无效」**明确报错，不静默**（C 组凭据项） |
| `http_error` | 其它 4xx/5xx | 保留服务端 `error` 文本 |

---

## 7. 版本兼容

- 收端遇到 `v` 缺失 → `envelope has no protocol version field (v); this build speaks v1`
- 收端遇到 `v ≠ 1` → `incompatible protocol version v2; this build speaks v1`

两条都带 `got` / `expected`，APK 可直接把这句话显示给用户，而不是「请求失败」。
