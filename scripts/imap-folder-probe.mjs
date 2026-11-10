/**
 * 探路：QQ IMAP 到底允许我们把邮件写到哪个文件夹里？
 *
 * 目标（用户 m04398）：邮件别在手机邮箱里弹出来，只给机器读。
 * 如果能把信封直接 APPEND 进一个**非收件箱**的文件夹（草稿箱/自定义），
 * 就不会有任何新邮件提醒 —— 这才是真正的「静默通道」。
 *
 * 复用 lib/mailbox/imap.js 的 ImapConnection（已验证能登录），只做只读探测 +
 * 一次可回滚的 APPEND 试验。
 */
import { loadConfig, loadCredentials } from '../lib/config.js'
import { ImapConnection, IMAP_PRESETS } from '../lib/mailbox/imap.js'

const cfg = await loadConfig()
const cred = await loadCredentials()
const preset = IMAP_PRESETS[cfg.imapProvider] ?? IMAP_PRESETS.qq
const user = cfg.imapUser
const auth = cred.imapAuth

if (!user || !auth) {
  console.error('缺凭据：先跑设置卡片保存邮箱与授权码')
  process.exit(1)
}

const log = (s = '') => console.log(s)
const lastLine = (resp) => String(resp).trim().split('\r\n').pop()

const conn = new ImapConnection({ host: preset.imapHost, port: 993, user, auth, timeoutMs: 20000 })
await conn.connect()
await conn.login()
log(`✔ 已登录 ${user} @ ${preset.imapHost}`)

/* ---------------------------------------------------------------- 1) 文件夹 */
log('\n=== 1) LIST 全部文件夹 ===')
const folders = await conn.listFolders()
for (const f of folders) log(`  ${f.name}   flags=[${f.flags.join(' ')}]`)

log('\n=== 2) 静默候选 ===')
const candidates = folders.filter((f) => /draft|草稿|trash|已删除|junk|垃圾|spam|archive|归档/iu.test(f.name))
log(candidates.length ? candidates.map((c) => `  候选: ${c.name}`).join('\n') : '  （无匹配）')

/* ------------------------------------------------- 3) 自定义文件夹能否存在 */
log('\n=== 3) CREATE 自定义文件夹「鸿驿」 ===')
log(`  CREATE -> ${lastLine(await conn.command('CREATE "鸿驿"'))}`)
const after = await conn.listFolders()
const hasCustom = after.some((f) => f.name.includes('鸿驿'))
log(`  CREATE 后 LIST ${hasCustom ? '有' : '**没有**'}鸿驿 → ${hasCustom ? '自定义文件夹可用' : '确认 QQ 不允许自定义文件夹（与旧注释一致）'}`)

/* --------------------------------------------------- 4) APPEND 到草稿箱试验 */
const draft = folders.find((f) => /draft|草稿/iu.test(f.name))
log('\n=== 4) APPEND 到草稿箱 ===')
if (!draft) {
  log('  找不到草稿箱，跳过')
} else {
  log(`  目标文件夹: ${draft.name}`)
  const subject = 'HongyiBox quiet-probe'
  const body = JSON.stringify({ envelope: { id: 'probe_quiet_1', type: 'event', note: 'quiet-channel-probe' } })
  const message = [
    `From: ${user}`,
    `To: ${user}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: application/json; charset=UTF-8',
    '',
    body,
  ].join('\r\n')
  try {
    const resp = await conn.append(draft.name, '(\\Draft)', message)
    log(`  APPEND -> ${lastLine(resp)}`)

    log('\n=== 5) 在草稿箱里搜回（证明它真存在且可读） ===')
    log(`  SELECT -> ${lastLine(await conn.command(`SELECT "${draft.name}"`))}`)
    const search = await conn.command('UID SEARCH SUBJECT "HongyiBox quiet-probe"')
    const uids = (/\* SEARCH ([\d ]+)/u.exec(search)?.[1] ?? '').trim()
    log(`  SEARCH 命中 uid: ${uids || '(无)'}`)
    if (uids) {
      const uid = uids.split(' ').pop()
      const fetch = await conn.command(`UID FETCH ${uid} (BODY.PEEK[])`)
      log(`  FETCH ${fetch.length} 字符，含探测正文: ${fetch.includes('quiet-channel-probe')}`)
      log(`  清理 STORE -> ${lastLine(await conn.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`))}`)
      log(`  清理 EXPUNGE -> ${lastLine(await conn.command('EXPUNGE'))}`)
    }
  } catch (error) {
    log(`  ✘ APPEND 失败：${error?.message ?? error}`)
  }
}

if (hasCustom) {
  log(`\n  DELETE 鸿驿 -> ${lastLine(await conn.command('DELETE "鸿驿"'))}`)
}

conn.logout()
log('\n=== 结论 ===')
log(`候选静默文件夹: ${candidates.map((c) => c.name).join(' / ') || '无'}`)
