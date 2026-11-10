import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
console.log('quiet', mb.quiet, 'folder', mb.quietFolder, 'trash', mb.trashFolder)
const before = await mb.pull({ limit: 3 })
const arr = Array.isArray(before) ? before : (before.items ?? [])
const env = arr[0]?.envelope ?? arr[0]
console.log('picked', env?.id)
const r = await mb.ack([env.id])
console.log('ack result', JSON.stringify(r))
const after = await mb.pull({ limit: 3 })
const arr2 = Array.isArray(after) ? after : (after.items ?? [])
console.log('still there?', arr2.some((x) => (x?.envelope ?? x)?.id === env.id))
