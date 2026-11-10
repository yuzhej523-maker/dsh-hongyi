/**
 * 诊断用：列出邮箱里当前所有「鸿驿」信封（收件箱未读 + 草稿箱），
 * 打印 type / from / to / id / ts，用来判断指令到底有没有送达。
 *
 * 用法：node scripts/imap-inspect.mjs [--box drafts|inbox|both]
 */
import { loadConfig, loadCredentials } from '../lib/config.js'
import { ImapConnection, IMAP_PRESETS } from '../lib/mailbox/imap.js'

const argv = process.argv.slice(2)
const which = argv.includes('--box') ? argv[argv.indexOf('--box') + 1] : 'both'

const config = await loadConfig()
const credentials = await loadCredentials()
const provider = config.imapProvider ?? 'qq'
const preset = IMAP_PRESETS[provider] ?? IMAP_PRESETS.qq

console.log(`账号   ${config.imapUser}`)
console.log(`服务商 ${provider} · ${preset.imapHost}:993`)
console.log(`设备   deviceId=${config.deviceId} phoneId=${config.phoneId} quiet=${config.imapQuiet !== false}`)
console.log('')

const conn = new ImapConnection({
  host: preset.imapHost,
  port: 993,
  user: config.imapUser,
  auth: credentials.imapAuth,
})
await conn.connect()
await conn.login()

async function dump(folder) {
  try {
    await conn.select(folder)
  } catch (error) {
    console.log(`— ${folder}: select 失败 ${error?.message}`)
    return
  }
  const uids = await conn.searchAllUids({ limit: 40 })
  console.log(`— ${folder}: ${uids.length} 封`)
  for (const uid of uids) {
    const raw = await conn.fetchRaw(uid)
    if (!raw) continue
    const m = /"envelope"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"[^}]*"type"\s*:\s*"([^"]+)"/u.exec(raw)
    let line = `  uid=${uid}`
    if (m) line += ` id=${m[1]} type=${m[2]}`
    const f = /"from"\s*:\s*"([^"]*)"/u.exec(raw)
    const t = /"to"\s*:\s*"([^"]*)"/u.exec(raw)
    const ts = /"ts"\s*:\s*"([^"]*)"/u.exec(raw)
    if (f) line += ` from=${f[1]}`
    if (t) line += ` to=${t[1]}`
    if (ts) line += ` ts=${ts[1]}`
    if (!m) line += ` （非鸿驿邮件 / 解析失败 ${raw.length}B）`
    console.log(line)
  }
  console.log('')
}

if (which === 'drafts' || which === 'both') await dump(preset.draftsFolder ?? 'Drafts')
if (which === 'inbox' || which === 'both') await dump('INBOX')

await conn.logout()
