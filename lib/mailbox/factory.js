/**
 * One place that turns config + credentials into a mailbox object.
 *
 * Three transports exist and they differ only in *how* the four operations are
 * carried out, never in what they mean:
 *
 *   `mock` / HTTP drivers → MailboxClient  (POST/GET against a base URL)
 *   `folder` / `tdrive`   → FolderMailbox  (read/write files in a synced folder)
 *   `imap`                → ImapMailbox    (SMTP 发信 / IMAP 收件，QQ/163/Gmail 均可)
 *
 * Keeping the choice here means `index.js`, the relay and the helper scripts all
 * pick the same implementation for the same config — a card that says "邮箱"
 * can never end up talking HTTP.
 */
import { MailboxClient, isFolderDriver } from './client.js'
import { FolderMailbox } from './folder.js'
import { ImapMailbox } from './imap.js'

/**
 * @param {object} config      resolved config (lib/config.js)
 * @param {object} credentials { token, deviceSecret }
 */
export function createMailbox(config, credentials = {}) {
  if (isFolderDriver(config?.driver)) {
    return new FolderMailbox({
      root: config.folderRoot,
      box: config.box,
      secret: credentials.deviceSecret ?? '',
      driver: config.driver,
    })
  }
  if (config?.driver === 'imap') {
    return new ImapMailbox({
      user: config.imapUser ?? credentials.imapUser ?? '',
      auth: credentials.imapAuth ?? '',
      provider: config.imapProvider ?? 'qq',
      box: config.box,
      secret: credentials.deviceSecret ?? '',
      driver: 'imap',
      /**
       * 静默通道（默认开）：信封走草稿箱 APPEND，不进收件箱、不弹提醒。
       * 关掉它才回到「发到自己的收件箱」的老路（会在手机/电脑邮箱里弹新邮件）。
       */
      quiet: config.imapQuiet !== false,
      quietFolder: config.imapQuietFolder ?? '',
    })
  }
  return new MailboxClient({
    baseUrl: config?.baseUrl,
    box: config?.box,
    token: credentials.token ?? '',
    secret: credentials.deviceSecret ?? '',
    driver: config?.driver,
    timeoutMs: 8000,
  })
}

export { MailboxClient, FolderMailbox, ImapMailbox }
