/**
 * 邮箱 IMAP/SMTP 信箱（imap transport）。
 *
 * 设计前提：鸿驿不自建任何云端服务。所谓「真实信箱」就是用户已有的邮箱：
 *   - 下行（电脑 → 手机）：插件把 JSON 信封作为一封邮件发到自己的邮箱
 *     （SMTP 发给自己 = 草稿/收件箱都可见），手机 App 用 IMAP 拉取；
 *   - 上行（手机 → 电脑）：手机 App/任何客户端把指令邮件写进收件箱
 *     （直接发给自己），电脑插件用 IMAP 轮询收件箱并执行。
 *
 * 语义与 mock/folder 信箱完全一致（同一套 Mailbox 接口）：
 *   put(env)   → SMTP 发一封标题 `[鸿驿] <type> <id>` 的自发自收邮件
 *   pull(...)  → IMAP 在 INBOX 里找未处理、未过期的 `[鸿驿]` 邮件，解析 JSON
 *   ack(ids)   → 把已处理邮件移到「鸿驿·已处理」文件夹（IMAP MOVE）
 *   health()   → IMAP 登录 + 列文件夹
 *
 * TTL：邮件按主题里的时间戳判断过期（写进信封 payload），删除动作在 pull 时
 * 顺带执行（IMAP STORE \Deleted + EXPUNGE，限流执行避免触发频控）。
 *
 * 安全：授权码只存 ~/.dsh/hongyi/credentials.json，绝不上传；连接全程 TLS
 * （IMAP 993 / SMTP 465）。
 */
import tls from 'node:tls'
import { PROTOCOL_VERSION, validateEnvelope } from '../envelope.js'

// 注意：QQ IMAP 的 SEARCH SUBJECT 不支持非 ASCII 字面量（搜中文永远 0 命中），
// 但搜 ASCII 子串没问题。鸿驿邮件的 Subject 实际存的是 base64 编码的中文+ASCII id，
// 所以用 ASCII 的 id 前缀 + 标记做检索键。
const SUBJECT_TAG = 'HongyiBox'
const SUBJECT_SEARCH = 'HongyiBox' // SEARCH SUBJECT 用的 ASCII 子串
const HANDLED_FOLDER = '鸿驿·已处理'
const DEFAULT_PORT_IMAP = 993
const DEFAULT_PORT_SMTP = 465

/** QQ/163/Gmail 等常见服务商的预设（用户也可以手填 host/port）。 */
export const IMAP_PRESETS = {
  qq: { imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', draftsFolder: 'Drafts', trashFolder: 'Deleted Messages', label: 'QQ 邮箱' },
  '163': { imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', draftsFolder: 'Drafts', trashFolder: '已删除', label: '163 邮箱' },
  gmail: { imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', draftsFolder: '[Gmail]/Drafts', trashFolder: '[Gmail]/Trash', label: 'Gmail' },
  outlook: { imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', draftsFolder: 'Drafts', trashFolder: 'Deleted Items', label: 'Outlook' },
}

export class ImapMailboxError extends Error {
  constructor(message, { code = 'imap_error', details = null } = {}) {
    super(message)
    this.name = 'ImapMailboxError'
    this.code = code
    this.details = details
  }
}

/** 极简 IMAP/SMTP 客户端：只实现鸿驿需要的最小命令集，零第三方依赖。 */
export class ImapConnection {
  constructor({ host, port, user, auth, timeoutMs = 10000 }) {
    this.host = host
    this.port = port
    this.user = user
    this.auth = auth
    this.timeoutMs = timeoutMs
    this.socket = null
    this.pending = []
    this.buffer = ''
    this.nextTag = 0
    this.selected = false
    this.capabilities = ''
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: this.host, port: this.port, timeout: this.timeoutMs, servername: this.host },
        () => {
          // 等服务器 greeting 行（* OK ...）到达后再发命令，否则首个命令会被 QQ 服务器吞掉
          const onFirst = (chunk) => {
            const text = chunk.toString()
            if (/^\* (OK|PREAUTH)/u.test(text)) {
              socket.off('data', onFirst)
              resolve()
            }
          }
          socket.on('data', onFirst)
        }
      )
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => this.#onData(chunk))
      socket.on('error', (error) => reject(this.#wrap(error)))
      socket.on('close', () => { this.socket = null })
      this.socket = socket
    })
  }

  #wrap(error) {
    const msg = String(error?.message ?? error)
    if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(msg)) {
      return new ImapMailboxError(`邮箱服务器连接失败：${msg}`, { code: 'unreachable' })
    }
    return new ImapMailboxError(msg, { code: 'imap_error' })
  }

  #onData(chunk) {
    this.buffer += chunk
    // 唤醒等待完整响应的调用方：找到「行首是该 tag 且后跟 OK/NO/BAD」的完成行。
    // 注意不能直接 indexOf("\r\nTAG ")，因为第一次响应的 tag 出现在 buffer 开头（无前置 \r\n）。
    this.pending = this.pending.filter((waiter) => {
      const re = new RegExp(`(?:^|\\r\\n)${waiter.tag} (?:OK|NO|BAD)`, 'i')
      const match = re.exec(this.buffer)
      if (!match) return true
      const end = this.buffer.indexOf('\r\n', match.index + match[0].length)
      const stop = end === -1 ? this.buffer.length : end + 2
      const text = this.buffer.slice(0, stop)
      this.buffer = this.buffer.slice(stop)
      waiter.resolve(text)
      return false
    })
  }

  /** 发送一条命令并等待同名 tag 的完成行。 */
  command(line) {
    if (!this.socket) throw new ImapMailboxError('IMAP 连接未建立', { code: 'unreachable' })
    this.nextTag += 1
    const tag = `H${String(this.nextTag).padStart(4, '0')}`
    const promise = new Promise((resolve, reject) => {
      // 超时必须同时做三件事，否则会埋下两个隐患：
      //   1. 把 waiter 从 pending 里摘掉 —— 否则迟到的响应会去 resolve 一个已经 reject 的 promise，
      //      更糟的是它会把「别人的」响应切成自己的（buffer 被按错误边界消费）。
      //   2. clearTimeout —— 否则每条成功命令都会留下一个 N 秒后才触发的定时器。
      //   3. reject 用 true 标记 —— 让调用方知道连接可能已经半死，值得重连。
      const waiter = { tag, resolve: null, reject: null, timer: null }
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((w) => w !== waiter)
        waiter.reject(new ImapMailboxError('IMAP 响应超时', { code: 'timeout' }))
      }, this.timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      waiter.timer = timer
      waiter.resolve = (text) => { clearTimeout(timer); resolve(text) }
      waiter.reject = (error) => { clearTimeout(timer); reject(error) }
      this.pending.push(waiter)
    })
    this.socket.write(`${tag} ${line}\r\n`)
    // 兜底挂一个空 catch：这条 promise 有可能在没人等的时候被 reject
    // （超时、或 logout() 主动掀桌子），Node 会把它当 unhandledRejection 直接杀进程——
    // 实测就是这么把 phase5 A 组整轮打崩的（ImapMailboxError: IMAP 响应超时）。
    // 挂上 handler 只是让「没人管」不再致命；调用方 await 它时照样拿到 reject。
    promise.catch(() => {})
    return promise
  }

  async login() {
    const auth = Buffer.from(`\u0000${this.user}\u0000${this.auth}`).toString('base64')
    const cap = await this.command('CAPABILITY')
    this.capabilities = cap
    const resp = await this.command(`AUTHENTICATE PLAIN ${auth}`)
    if (/^H\d{4} NO|BAD/i.test(resp.trim().split('\r\n').pop())) {
      throw new ImapMailboxError('凭据无效：邮箱拒绝了当前授权码（IMAP 登录失败）', {
        code: 'credential_invalid',
      })
    }
    return true
  }

  /** 列出全部文件夹，返回 [ {name, flags} ]；QQ 的中文文件夹名是 modified UTF-7，需解码。 */
  async listFolders() {
    const resp = await this.command('LIST "" "*"')
    const folders = []
    for (const line of resp.split('\r\n')) {
      const m = /^\* LIST \(([^)]*)\) "([^"]*)" (.+)$/u.exec(line.trim())
      if (!m) continue
      folders.push({ flags: m[1].split(/\s+/), delimiter: m[2], name: decodeImapUtf7(m[3].replace(/^"|"$/g, '')) })
    }
    return folders
  }

  async ensureFolder(name) {
    const folders = await this.listFolders()
    if (folders.some((f) => f.name === name)) return
    await this.command(`CREATE "${encodeImapUtf7(name)}"`)
  }

  /**
   * 搜索鸿驿邮件（未处理 = 在 INBOX 且带主题标记）。
   * unseenOnly=true 时只搜 UNSEEN（\Seen = 已被 ack 出队）。
   * 返回 [{ uid, subject, internalDate, body }]
   */
  /** SELECT 一个文件夹，后续 UID 命令都作用于它。 */
  async select(folder) {
    const resp = await this.command(`SELECT "${encodeImapUtf7(folder)}"`)
    if (/^\s*\S+ (NO|BAD)/iu.test(resp)) {
      throw new ImapMailboxError(`邮箱没有可用的「${folder}」文件夹`, { code: 'http_error', details: { folder } })
    }
    this.selectedFolder = folder
    return resp
  }

  /**
   * 列出当前选中文件夹里**所有**邮件的 UID（不带 SUBJECT 过滤）。
   *
   * 静默通道要用它：实测 QQ 的草稿箱里 `SEARCH SUBJECT` 不可靠（0 命中），
   * 只能按 UID 区间全量取，再用正文里的信封自己筛。
   */
  async searchAllUids({ limit = 20 } = {}) {
    if (!this.selectedFolder) await this.select('INBOX')
    const resp = await this.command('UID SEARCH ALL')
    const uids = []
    for (const line of resp.split('\r\n')) {
      const m = /^\* SEARCH\s*(.*)$/u.exec(line.trim())
      if (!m) continue
      const body = m[1].trim()
      if (!body) continue
      uids.push(...body.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0))
    }
    return uids.slice(-limit)
  }

  async searchInbox({ sinceUid = 0, limit = 20, unseenOnly = false } = {}) {
    // QQ IMAP 要求先 SELECT INBOX，否则 SEARCH 的搜索范围不是 INBOX
    if (!this.selected) {
      await this.command('SELECT INBOX')
      this.selected = true
    }
    // 关键：QQ IMAP 的 `SEARCH`（不带 UID 前缀）返回的是**消息序号**而非 UID，
    // 但响应格式一模一样（`* SEARCH 176 177`）——当成 UID 去 FETCH 会拿错/拿空。
    // 因此无论 sinceUid 是否为 0，一律发 `UID SEARCH`，保证返回值就是 UID。
    const unseen = unseenOnly ? ' UNSEEN' : ''
    const query = sinceUid > 0
      ? `UID SEARCH UID ${Number(sinceUid) + 1}:* SUBJECT "${SUBJECT_SEARCH}"${unseen}`
      : `UID SEARCH SUBJECT "${SUBJECT_SEARCH}"${unseen} ALL`
    const resp = await this.command(query)
    const uids = []
    for (const line of resp.split('\r\n')) {
      // 响应行形如 `* SEARCH 176 177`（untagged，带 * 前缀）；完成行是 `H0004 OK ...` 要跳过
      const m = /^\* (?:UID )?SEARCH(?: \(UID \d+:\*\))?(?: ALL)? (.+)$/u.exec(line.trim())
      if (!m) continue
      uids.push(...m[1].trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0))
    }
    const picked = uids.slice(-limit)
    const out = []
    for (const uid of picked) {
      const raw = await this.fetchRaw(uid)
      if (raw) out.push(parseMessage(raw, uid))
    }
    return out
  }

  async fetchRaw(uid) {
    const resp = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`)
    // 响应形如 `* N FETCH (BODY[] {2258}\r\n<恰好 2258 字节的原文>\r\n)\r\nH0005 OK ...`。
    // 两个坑：
    // 1) 不能用 indexOf('\r\n\r\n') 切分：邮件头里就有空行，会切在头/正文之间。
    // 2) literal 计数是**字节**，而 resp 是 UTF-8 解码后的字符串——含非 ASCII 时
    //    code-unit 切分会偏移。必须换算字节起点、用 Buffer 按字节切，再转回字符串。
    const lit = /\{(\d+)\}\r\n/u.exec(resp)
    if (!lit) return null
    const cuStart = lit.index + lit[0].length
    const byteStart = Buffer.byteLength(resp.slice(0, cuStart), 'utf8')
    const buf = Buffer.from(resp, 'utf8')
    return buf.slice(byteStart, byteStart + Number(lit[1])).toString('utf8')
  }

  /**
   * ack = 给邮件打 Seen 标记（QQ IMAP 不允许 CREATE/MOVE 文件夹——CREATE 返回 OK
   * 但文件夹永远不出现在 LIST，UID MOVE 报 NONEXISTENT）。
   * pull 只取未读（SEARCH UNSEEN），打过 Seen 的邮件相当于已确认出队。
   * 过期清理走 Deleted + EXPUNGE。
   */  async markSeen(uids) {
    if (!uids.length) return []
    if (!this.selected) { await this.command('SELECT INBOX'); this.selected = true }
    await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Seen)`)
    return uids
  }

  async expungeDeleted(uids) {
    if (!uids.length) return []
    if (!this.selectedFolder) await this.select('INBOX')
    // 提醒：QQ Mail 会「假装」接受 \Deleted —— STORE 返回 OK、EXPUNGE 返回 OK，
    // 但 FLAGS 不变、邮件也不消失（实测 4 种写法全无效）。所以这里保留标准语义给
    // 支持得好的服务器用；QQ 请走 moveToTrash()。
    await this.command(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Deleted)`)
    await this.command('EXPUNGE')
    return uids
  }

  /**
   * 把邮件移到垃圾箱（更通用的删除方式）。
   *
   * QQ Mail 实测：`\Deleted` 标志被完全忽略，只有 `UID MOVE` 真能删掉；
   * 因此草稿箱清理必须走这里而不是 expungeDeleted()。
   * 目标文件夹名按服务商给（QQ 是 "Deleted Messages"，Gmail 是 "[Gmail]/Trash"）。
   */
  async moveToTrash(uids, folder = 'Deleted Messages') {
    if (!uids.length) return []
    if (!this.selectedFolder) await this.select('INBOX')
    const moved = []
    for (const uid of uids) {
      const resp = await this.command(`UID MOVE ${uid} "${folder}"`)
      if (!/\b(?:OK|NO|BAD)\b/i.test(resp) || /\bNO\b/i.test(resp.slice(0, 200))) continue
      moved.push(uid)
    }
    return moved
  }

  /**
   * APPEND 一封邮件到指定文件夹（不需要 SMTP）。
   *
   * 这是「静默通道」的关键：写进草稿箱/自定义文件夹的信封**不会触发新邮件提醒**，
   * 但机器用 IMAP 照样读得到。协议上 APPEND 是双阶段写：
   *   C: H0005 APPEND "Drafts" (\Draft) {1234}
   *   S: + go ahead
   *   C: <恰好 1234 字节的原文>\r\n
   *   S: H0005 OK APPEND completed
   * 所以不能复用 command()（它只写一行），要自己等 `+` 续行。
   */
  append(folder, flags, message) {
    if (!this.socket) throw new ImapMailboxError('IMAP 连接未建立', { code: 'unreachable' })
    this.nextTag += 1
    const tag = `H${String(this.nextTag).padStart(4, '0')}`
    const bytes = Buffer.byteLength(message, 'utf8')
    return new Promise((resolve, reject) => {
      this.pending.push({ tag, resolve, reject })
      const timer = setTimeout(() => reject(new ImapMailboxError('IMAP APPEND 超时', { code: 'timeout' })), this.timeoutMs)
      const realResolve = (v) => { clearTimeout(timer); resolve(v) }
      this.pending[this.pending.length - 1].resolve = realResolve
      this.socket.write(`${tag} APPEND "${folder}" ${flags} {${bytes}}\r\n`)
      // 等服务器的续行提示（`+ go ahead` 或 `+ Ready`），收到后再发正文。
      const waiter = setInterval(() => {
        const current = this.buffer ?? ''
        const plus = /(?:^|\r\n)\+[^\r\n]*\r\n/u.exec(current)
        if (!plus) return
        clearInterval(waiter)
        // 只吃掉那一行续行提示，保留其后的任何数据等 command 的完成行处理。
        const cut = plus.index + plus[0].length
        this.buffer = current.slice(cut)
        this.socket.write(`${message}\r\n`)
      }, 25)
      setTimeout(() => clearInterval(waiter), this.timeoutMs)
    })
  }

  logout() {
    // 主动断开时，所有还在等的命令必须立刻失败，而不是各自熬到超时
    // （否则一次失败的 pull 会把后续几秒的命令都拖成 timeout，看起来像「邮箱很慢」）。
    const waiters = this.pending
    this.pending = []
    for (const waiter of waiters) {
      try { waiter.reject(new ImapMailboxError('IMAP 连接已关闭', { code: 'unreachable' })) } catch {}
    }
    try { this.socket?.write('LOGOUT\r\n') } catch {}
    try { this.socket?.end() } catch {}
    this.socket = null
    this.selectedFolder = ''
  }
}

/** SMTP 一次性连接：发一封自发自收的鸿驿邮件。 */
function smtpSend({ smtpHost, smtpPort, user, auth, mail }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: smtpHost, port: smtpPort, timeout: 10000, servername: smtpHost }, () => {})
    socket.setEncoding('utf8')
    const commands = [
      { expect: /^220/, send: `HELO hongyi.local` },
      { expect: /^250/, send: `AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${auth}`).toString('base64')}` },
      { expect: /^235/, send: `MAIL FROM:<${user}>` },
      { expect: /^250/, send: `RCPT TO:<${user}>` },
      { expect: /^250/, send: 'DATA' },
      { expect: /^354/, send: mail },
      { expect: /^250/, send: 'QUIT' },
    ]
    let step = 0
    socket.on('data', (chunk) => {
      const text = chunk.toString()
      // 逐行状态机：SMTP 服务器经常把多行响应（250-xxx\r\n250-yyy\r\n250 zzz）拆在一次 data 里，
      // 必须等「最后一行是不带 - 的完成码」才能进入下一步。
      for (const line of text.split('\r\n')) {
        if (!line) continue
        const cmd = commands[step]
        if (!cmd) return
        const isFinal = !/^\d{3}-/u.test(line) && /^\d{3}/u.test(line)
        if (!isFinal) continue // 中间行（250-SIZE 之类），继续等
        if (!cmd.expect.test(line)) {
          socket.destroy()
          if (/^5\d\d/u.test(line)) {
            reject(new ImapMailboxError(`凭据无效：邮箱拒绝了当前授权码（SMTP 认证失败）：${line.trim().slice(0, 120)}`, { code: 'credential_invalid' }))
          } else {
            reject(new ImapMailboxError(`SMTP 协议异常：${line.trim().slice(0, 120)}`, { code: 'http_error' }))
          }
          return
        }
        if (process.env.HONGYI_SMTP_DEBUG) console.error('SMTP >', String(cmd.send).slice(0, 60).replace(/\r\n/g, '|'))
        socket.write(cmd.send + '\r\n')
        step += 1
        if (step === commands.length) {
          socket.end()
          resolve()
          return
        }
      }
    })
    socket.on('error', (error) => {
      const msg = String(error?.message ?? error)
      if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(msg)) {
        reject(new ImapMailboxError(`SMTP 服务器连接失败：${msg}`, { code: 'unreachable' }))
      } else reject(new ImapMailboxError(msg, { code: 'smtp_error' }))
    })
  })
}

/** 构造一封 RFC822 自发自收邮件（鸿驿信封在正文 JSON 里）。 */
function buildRawMessage({ user, envelope }) {
  const subject = `${SUBJECT_TAG} ${envelope.type} ${envelope.id}`
  const body = JSON.stringify({ envelope, receivedAt: new Date().toISOString() }, null, 2)
  return [
    `From: <${user}>`,
    `To: <${user}>`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: application/json; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    'X-Hongyi-Mailbox: dsh',
    '',
    body,
    '',
  ].join('\r\n')
}

function buildMail({ user, envelope }) {
  const raw = buildRawMessage({ user, envelope })
  // dot-stuffing：正文里以 . 开头的行要双写，避免被当成 DATA 终止符
  const stuffed = raw.replace(/(^|\r\n)\./gu, '$1..')
  // SMTP DATA 终止符必须是独立的一行 `.`（缺了它服务器会永远等待 → put 挂死）
  return `${stuffed}\r\n.\r\n`
}

/** IMAP modified UTF-7 ↔ UTF-8（中文文件夹名）。 */
function decodeImapUtf7(str) {
  return str.replace(/&([A-Za-z0-9+,/-]*?)-/gu, (_, b64) => {
    if (b64 === '') return '&'
    const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64')
    return buf.toString('utf8')
  })
}
function encodeImapUtf7(str) {
  if (/^[\x20-\x7e]*$/u.test(str)) return str
  let out = ''
  let pending = ''
  for (const ch of str) {
    if (/[\x20-\x7e]/u.test(ch)) {
      if (pending) { out += `&${Buffer.from(pending, 'utf8').toString('base64').replace(/\//g, ',').replace(/=+$/, '')}-`; pending = '' }
      out += ch === '&' ? '&-' : ch
    } else pending += ch
  }
  if (pending) out += `&${Buffer.from(pending, 'utf8').toString('base64').replace(/\//g, ',').replace(/=+$/, '')}-`
  return out
}

/** 从原始邮件文本里抽出信封（正文 = JSON）。 */
function parseMessage(raw, uid) {
  const headerEnd = raw.indexOf('\r\n\r\n')
  const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd)
  const body = headerEnd === -1 ? '' : raw.slice(headerEnd + 4).trim()
  const subjectLine = header.split('\r\n').find((l) => /^subject:/iu.test(l)) ?? ''
  let subject = subjectLine.replace(/^subject:\s*/iu, '')
  if (/^=\?UTF-8\?B\?(.+?)\?=/iu.test(subject)) {
    try { subject = Buffer.from(RegExp.$1, 'base64').toString('utf8') } catch {}
  }
  let envelope = null
  try { envelope = JSON.parse(body)?.envelope ?? null } catch {}
  return { uid, subject, envelope, receivedAt: new Date().toISOString(), raw: undefined }
}

export class ImapMailbox {
  /**
   * @param {object} options
   * @param {string} options.user    邮箱地址
   * @param {string} options.auth    授权码（不是登录密码）
   * @param {string} [options.provider] qq|163|gmail|outlook（或手填 host）
   * @param {string} [options.imapHost] [options.smtpHost] 手填覆盖 preset
   */
  constructor(options = {}) {
    this.user = String(options.user ?? '').trim()
    this.auth = String(options.auth ?? options.token ?? '').trim()
    this.provider = String(options.provider ?? 'qq').toLowerCase()
    const preset = IMAP_PRESETS[this.provider] ?? IMAP_PRESETS.qq
    this.imapHost = options.imapHost || preset.imapHost
    this.smtpHost = options.smtpHost || preset.smtpHost
    this.imapPort = DEFAULT_PORT_IMAP
    this.smtpPort = DEFAULT_PORT_SMTP
    this.box = options.box ?? 'dsh-hongyi'
    this.secret = options.secret ?? ''
    this.driver = options.driver ?? 'imap'
    /**
     * 静默通道：信封 APPEND 进草稿箱而不是 SMTP 投递到收件箱。
     *
     * 为什么：任务监测会让信封变多（每跳都可能带任务状态），全走 SMTP 就是
     * 一堆「新邮件」弹窗。草稿箱不触发提醒，但 IMAP 照样能读，读完能删干净
     * —— 机器可读、人看不见，正是「只给机器读」的要求。
     * 实测限制（2026-11-10，QQ 邮箱）：Drafts 可 APPEND/UID SEARCH ALL/FETCH/
     * EXPUNGE，但**不允许 CREATE 自定义文件夹**，且草稿箱里 `SEARCH SUBJECT`
     * 不可靠（0 命中）→ 静默模式只能按 UID 全量取。
     */
    this.quiet = options.quiet === true
    this.quietFolder = String(options.quietFolder ?? '').trim() || (IMAP_PRESETS[this.provider] ?? IMAP_PRESETS.qq).draftsFolder
    /**
     * 垃圾箱名：删除只走 `UID MOVE`（QQ 忽略 \Deleted，见 moveToTrash 注释）。
     * 名字取服务商预设；用户可用 imapTrashFolder 覆盖（自定义服务商时有用）。
     */
    this.trashFolder = String(options.trashFolder ?? '').trim() || (IMAP_PRESETS[this.provider] ?? IMAP_PRESETS.qq).trashFolder || 'Deleted Messages'
    this.timeoutMs = 12000
    this._handledReady = false
  }

  get configured() {
    return this.user.length > 0 && this.auth.length > 0
  }

  unsupported() {
    if (!this.user) return '邮箱地址为空：请在设置卡片填写邮箱账号与授权码。'
    if (!this.auth) return '授权码为空：请先在邮箱设置里开启 IMAP/SMTP 服务并生成授权码。'
    return ''
  }

  #connection() {
    return new ImapConnection({ host: this.imapHost, port: this.imapPort, user: this.user, auth: this.auth, timeoutMs: this.timeoutMs })
  }

  async #withConnection(fn) {
    const conn = this.#connection()
    try {
      await conn.connect()
      await conn.login()
      return await fn(conn)
    } finally {
      conn.logout()
    }
  }

  async put(env) {
    const check = this.unsupported()
    if (check) throw new ImapMailboxError(check, { code: 'no_base_url' })
    if (this.quiet) {
      // 静默通道：APPEND 进草稿箱，不经过 SMTP → 不进收件箱、不弹新邮件提醒。
      // 走 APPEND 还有个好处：没有 SMTP 投递延迟，写完立刻就能读到（probe 更快）。
      try {
        return await this.#withConnection(async (conn) => {
          await conn.select(this.quietFolder)
          await conn.append(this.quietFolder, '(\\Draft)', buildRawMessage({ user: this.user, envelope: env }))
          return { ok: true, id: env.id, box: this.box, quiet: true, folder: this.quietFolder }
        })
      } catch (error) {
        if (error instanceof ImapMailboxError) throw error
        throw new ImapMailboxError(String(error?.message ?? error), { code: 'http_error' })
      }
    }
    try {
      await smtpSend({ smtpHost: this.smtpHost, smtpPort: this.smtpPort, user: this.user, auth: this.auth, mail: buildMail({ user: this.user, envelope: env }) })
    } catch (error) {
      if (error instanceof ImapMailboxError) throw error
      throw new ImapMailboxError(String(error?.message ?? error), { code: 'http_error' })
    }
    return { ok: true, id: env.id, box: this.box }
  }

  /** 把一批原始邮件解析成信封并剔除过期的，返回 `{items, expiredUids}`。 */
  #collect(messages) {
    const items = []
    const expiredUids = []
    for (const msg of messages) {
      if (!msg.envelope || typeof msg.envelope !== 'object') continue
      const env = msg.envelope
      // TTL：按信封 ts + ttl 判断（邮件投递延迟会让 mtime 不可靠，用信封自身时间）
      const tsMs = Date.parse(env.ts ?? '')
      const ttlSec = Number(env.ttl ?? 3600)
      if (Number.isFinite(tsMs) && Date.now() - tsMs > ttlSec * 1000) {
        expiredUids.push(msg.uid)
        continue
      }
      items.push({ envelope: env, receivedAt: msg.receivedAt })
    }
    return { items, expiredUids }
  }

  async pull({ since = null, limit = 20 } = {}) {
    const check = this.unsupported()
    if (check) throw new ImapMailboxError(check, { code: 'no_base_url' })
    return this.#withConnection(async (conn) => {
      if (this.quiet) {
        // 草稿箱里 `SEARCH SUBJECT` 不可靠（实测 0 命中），只能全量按 UID 取，
        // 再用正文里的信封自己筛。取最新的 limit 封即可（旧的过期会被清理）。
        await conn.select(this.quietFolder)
        const uids = await conn.searchAllUids({ limit })
        const messages = []
        for (const uid of uids) {
          const raw = await conn.fetchRaw(uid)
          if (raw) messages.push(parseMessage(raw, uid))
        }
        const { items, expiredUids } = this.#collect(messages)
        // 静默模式下过期邮件直接删掉，别让草稿箱越堆越乱。
        // 注意：必须用 moveToTrash —— QQ 对 \Deleted 完全无反应（见该方法注释）。
        if (expiredUids.length) await conn.moveToTrash(expiredUids, this.trashFolder)
        return items
      }
      // 只取未读：打过 \Seen 的邮件 = 已被 ack，直接跳过（省 SEARCH 流量也天然幂等）
      const messages = await conn.searchInbox({ sinceUid: since ?? 0, limit, unseenOnly: true })
      const { items, expiredUids } = this.#collect(messages)
      if (expiredUids.length) await conn.moveToTrash(expiredUids, this.trashFolder)
      return items
    })
  }

  async ack(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { acked: [] }
    const check = this.unsupported()
    if (check) throw new ImapMailboxError(check, { code: 'no_base_url' })
    return this.#withConnection(async (conn) => {
      const wanted = new Set(ids.map(String))
      if (this.quiet) {
        // 静默模式的 ack = 把草稿挪进垃圾箱。打 \Seen 对草稿没有意义（本来也不弹提醒），
        // 而移走才能让用户的草稿箱保持干净。
        // **必须用 UID MOVE**：QQ 会接受 \Deleted 却完全不生效（实测 4 种写法全失败），
        // 这是本插件最容易踩的坑 —— 换回 expungeDeleted 会让草稿箱无限膨胀。
        await conn.select(this.quietFolder)
        const uids = await conn.searchAllUids({ limit: 100 })
        const doomed = []
        for (const uid of uids) {
          const raw = await conn.fetchRaw(uid)
          if (!raw) continue
          const parsed = parseMessage(raw, uid)
          if (parsed.envelope && wanted.has(String(parsed.envelope.id))) doomed.push(uid)
        }
        const removed = await conn.moveToTrash(doomed, this.trashFolder)
        return { acked: (removed ?? doomed).map((uid) => `uid:${uid}`) }
      }
      const messages = await conn.searchInbox({ limit: 100 })
      const uids = messages.filter((m) => m.envelope && wanted.has(String(m.envelope.id))).map((m) => m.uid)
      const seen = await conn.markSeen(uids)
      return { acked: seen.map((uid) => `uid:${uid}`) }
    })
  }

  async health() {
    const check = this.unsupported()
    if (check) throw new ImapMailboxError(check, { code: 'no_base_url' })
    return this.#withConnection(async (conn) => {
      const folders = await conn.listFolders()
      return {
        ok: true,
        name: 'hongyi-imap-mailbox',
        protocol: PROTOCOL_VERSION,
        user: this.user,
        host: this.imapHost,
        folders: folders.map((f) => f.name),
        authRequired: true,
      }
    })
  }

  /** 设置卡片 [测试连接]：发 ping → IMAP 读回 → 验签 → ack。 */
  async probe(sendPing) {
    const started = Date.now()
    const check = this.unsupported()
    if (check) {
      return { ok: false, stage: 'config', message: check, mailbox: this.describe(), latencyMs: 0 }
    }
    let ping = null
    try {
      ping = sendPing ? await sendPing() : null
    } catch (error) {
      return { ok: false, stage: 'sign', message: String(error?.message ?? error), mailbox: this.describe(), latencyMs: Date.now() - started }
    }
    let health = null
    try {
      health = await this.health()
    } catch (error) {
      return { ok: false, stage: 'health', message: String(error?.message ?? error), mailbox: this.describe(), latencyMs: Date.now() - started }
    }
    try {
      if (ping) await this.put(ping)
      // QQ 的 SEARCH 索引延迟实测 10~40 秒：轮询重试，最长约 60 秒
      let envelopes = []
      let found = null
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const items = await this.pull({ limit: 50 })
        envelopes = items.map((item) => item.envelope ?? item)
        found = ping ? envelopes.find((env) => env?.id === ping.id) : null
        if (found || !ping) break
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      if (ping && !found) {
        return { ok: false, stage: 'readback', message: '写入成功但读回时未找到该 ping（邮件投递延迟或搜索异常）', mailbox: this.describe(), latencyMs: Date.now() - started, health }
      }
      if (found) {
        validateEnvelope(found, { secret: this.secret })
        await this.ack([found.id])
      }
      return {
        ok: true,
        stage: 'done',
        message: ping ? `写入并读回成功，签名校验通过（${Date.now() - started}ms）` : `信箱可达（${Date.now() - started}ms）`,
        mailbox: this.describe(),
        latencyMs: Date.now() - started,
        health,
        pingId: ping?.id ?? null,
      }
    } catch (error) {
      return { ok: false, stage: 'io', message: String(error?.message ?? error), mailbox: this.describe(), latencyMs: Date.now() - started, health }
    }
  }

  describe() {
    return {
      driver: this.driver,
      label: this.quiet ? '邮箱 · 静默通道（草稿箱，不弹提醒）' : '邮箱 IMAP/SMTP（QQ/163/Gmail 均可）',
      baseUrl: this.imapHost,
      box: this.user || '(未填邮箱)',
      tokenSet: this.auth.length > 0,
      secretSet: Boolean(this.secret),
      protocol: PROTOCOL_VERSION,
      configured: this.configured,
      quiet: this.quiet,
      quietFolder: this.quiet ? this.quietFolder : '',
    }
  }
}
