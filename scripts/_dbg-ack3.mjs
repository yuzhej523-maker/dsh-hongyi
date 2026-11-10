import { ImapConnection, IMAP_PRESETS } from '../lib/mailbox/imap.js'
const p = IMAP_PRESETS.qq
const mk = () => new ImapConnection({ host: p.imapHost, port: 993, user: process.env.U, auth: process.env.A, timeoutMs: 25000 })
async function probe(label, fn) {
  const c = mk(); await c.connect(); await c.login()
  await c.select('Drafts')
  const uids = await c.searchAllUids({ limit: 3 })
  const target = uids[uids.length - 1]
  console.log(`\n--- ${label} (uid ${target}) ---`)
  try { await fn(c, target) } catch (e) { console.log('  ERR', e.message) }
  const f = await c.command(`UID FETCH ${target} (FLAGS)`)
  console.log('  flags now:', f.trim().split('\r\n')[0])
  await c.select('Drafts')
  const st = await c.command('STATUS "Drafts" (MESSAGES)')
  console.log('  ', st.trim().split('\r\n')[0])
  c.logout()
}
await probe('A: +FLAGS.SILENT 然后 EXPUNGE', async (c, u) => {
  console.log(' ', (await c.command(`UID STORE ${u} +FLAGS.SILENT (\Deleted)`)).trim())
  console.log(' ', (await c.command('EXPUNGE')).trim())
})
await probe('B: +FLAGS 非 silent', async (c, u) => {
  console.log(' ', JSON.stringify((await c.command(`UID STORE ${u} +FLAGS (\Deleted)`)).slice(0, 160)))
  console.log(' ', (await c.command('EXPUNGE')).trim())
})
await probe('C: MOVE 到 Deleted Messages', async (c, u) => {
  console.log(' ', JSON.stringify((await c.command(`UID MOVE ${u} "Deleted Messages"`)).slice(0, 200)))
})
await probe('D: FLAGS (\Deleted) 覆盖', async (c, u) => {
  console.log(' ', JSON.stringify((await c.command(`UID STORE ${u} FLAGS (\Deleted)`)).slice(0, 160)))
  console.log(' ', (await c.command('EXPUNGE')).trim())
})
