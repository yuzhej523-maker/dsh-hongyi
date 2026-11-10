/**
 * 第二探：APPEND 进 Drafts 之后，机器到底能不能把它读回来？
 *
 * 上一探已确认：
 *   - QQ 不允许 CREATE 自定义文件夹（NO [CANNOT] Invalid folder name. Create the parent folder first）
 *   - 但 APPEND 到 Drafts 成功（H0006 OK [APPENDUID 1666236686 2]）
 *   - `UID SEARCH SUBJECT "..."` 在 Drafts 里 0 命中 → 说明 QQ 的 Drafts 不支持按主题搜，
 *     必须换检索策略（按 UID 区间 / SEARCH ALL）。
 *
 * 本探要回答三件事：
 *   1. Drafts 里的邮件能否被 UID SEARCH ALL 枚举出来？
 *   2. BODY.PEEK[] 能否完整读回我们写进去的 JSON 信封？
 *   3. 读完能不能删干净（\Deleted + EXPUNGE），保证不污染用户草稿箱？
 */
import { loadConfig, loadCredentials } from '../lib/config.js'
import { ImapConnection, IMAP_PRESETS } from '../lib/mailbox/imap.js'

const cfg = await loadConfig()
const cred = await loadCredentials()
const preset = IMAP_PRESETS[cfg.imapProvider] ?? IMAP_PRESETS.qq
const log = (s = '') => console.log(s)
const lastLine = (r) => String(r).trim().split('\r\n').pop()

const conn = new ImapConnection({
  host: preset.imapHost, port: 993, user: cfg.imapUser, auth: cred.imapAuth, timeoutMs: 20000,
})
await conn.connect()
await conn.login()

const DRAFTS = 'Drafts'
log('=== 0) SELECT Drafts ===')
log(`  ${lastLine(await conn.command(`SELECT "${DRAFTS}"`))}`)

const before = await conn.command('UID SEARCH ALL')
const beforeUids = (/\* SEARCH ([\d ]*)/u.exec(before)?.[1] ?? '').trim()
log(`  现有草稿 uid: ${beforeUids || '(空)'}`)

const marker = `probe-${Date.now()}`
const envelope = {
  envelope: {
    v: 1, id: `event_${marker}`, type: 'event', from: 'dsh-pc', to: 'phone',
    ts: new Date().toISOString(), ttl: 300,
    payload: { kind: 'quiet-probe', marker }, sig: 'x'.repeat(64),
  },
}
const message = [
  `From: ${cfg.imapUser}`,
  `To: ${cfg.imapUser}`,
  `Subject: [HongyiBox] event ${marker}`,
  `Date: ${new Date().toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: application/json; charset=UTF-8',
  '',
  JSON.stringify(envelope),
].join('\r\n')

log('\n=== 1) APPEND 到 Drafts ===')
const appendResp = await conn.append(DRAFTS, '(\\Draft)', message)
log(`  ${lastLine(appendResp)}`)

log('\n=== 2) UID SEARCH ALL 枚举 ===')
const all = await conn.command('UID SEARCH ALL')
const allUids = (/\* SEARCH ([\d ]*)/u.exec(all)?.[1] ?? '').trim()
log(`  现在草稿 uid: ${allUids || '(空)'}`)
const newest = allUids ? allUids.split(' ').pop() : ''
log(`  最新 uid = ${newest}`)

log('\n=== 3) BODY.PEEK[] 读回 ===')
if (newest) {
  const raw = await conn.command(`UID FETCH ${newest} (BODY.PEEK[])`)
  const ok = raw.includes(marker)
  log(`  FETCH ${raw.length} 字符 / 含标记 ${ok}`)
  if (ok) {
    const bodyStart = raw.indexOf('{')
    log(`  片段: ${raw.slice(0, 200).replace(/\r\n/g, ' | ')}`)
    // 抽出 JSON 正文验证可解析
    const jsonStart = raw.indexOf('{"envelope"')
    if (jsonStart >= 0) {
      const tail = raw.slice(jsonStart)
      const end = tail.lastIndexOf('}')
      const parsed = JSON.parse(tail.slice(0, end + 1))
      log(`  ✔ JSON 可解析: id=${parsed.envelope.id} type=${parsed.envelope.type} marker=${parsed.envelope.payload.marker}`)
    }
  }

  log('\n=== 4) 删除（不污染用户草稿箱） ===')
  log(`  STORE \\Deleted -> ${lastLine(await conn.command(`UID STORE ${newest} +FLAGS.SILENT (\\Deleted)`))}`)
  log(`  EXPUNGE -> ${lastLine(await conn.command('EXPUNGE'))}`)
  const afterDel = await conn.command('UID SEARCH ALL')
  const afterUids = (/\* SEARCH ([\d ]*)/u.exec(afterDel)?.[1] ?? '').trim()
  log(`  删除后草稿 uid: ${afterUids || '(空)'}  ${afterUids === beforeUids ? '✔ 已还原' : '⚠ 与原始不一致'}`)
}

conn.logout()
log('\n=== 结论 ===')
log('若上面 3 能读回、4 能还原：Drafts 就是可用的静默信箱（APPEND 不触发新邮件提醒）。')
