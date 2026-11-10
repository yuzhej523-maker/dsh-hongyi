/**
 * Durable outbound queue.
 *
 * Anything the relay wants the phone to see goes through here first, so a
 * mailbox that is down (or a network that is gone) becomes "delay", never
 * "loss". Entries are plain envelopes plus bookkeeping:
 *
 *   { envelope, attempts, nextAt, lastError, state }
 *
 * `state` is `pending` (never successfully delivered) or `sent` (delivered at
 * least once; kept only long enough to make an at-least-once resend idempotent —
 * the phone dedupes by `envelope.id` anyway). A `sent` entry with
 * `needsAck` is what the mailbox already accepted; we simply forget it.
 *
 * The queue is one JSON file under $DSH_HOME/hongyi/queue/outbound.json.
 * Writing goes through `writeJson` (temp file + rename, no BOM), so a crash can
 * never leave half a queue behind.
 */
import { paths } from '../paths.js'
import { readJson, writeJson, journal } from '../store.js'

const DEFAULT_MAX_ATTEMPTS = 12
const DEFAULT_BASE_BACKOFF_MS = 2000
const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000
/** Cap the file so a permanently offline host cannot grow it without bound. */
const MAX_ENTRIES = 500

export class Outbox {
  constructor({ file = paths.queueFile(), journalFile = paths.journalFile(), limits = {} } = {}) {
    this.file = file
    this.journalFile = journalFile
    this.maxAttempts = limits.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.baseBackoffMs = limits.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
    this.maxBackoffMs = limits.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.entries = []
    this.loaded = false
  }

  async load() {
    if (this.loaded) return this.entries
    const stored = await readJson(this.file, { entries: [] })
    this.entries = Array.isArray(stored?.entries) ? stored.entries : []
    this.loaded = true
    return this.entries
  }

  async persist() {
    if (this.entries.length > MAX_ENTRIES) {
      // Drop the oldest *sent* entries first; pending work is never discarded.
      const sent = this.entries.filter((entry) => entry.state === 'sent')
      const pending = this.entries.filter((entry) => entry.state !== 'sent')
      const room = Math.max(0, MAX_ENTRIES - pending.length)
      this.entries = [...pending, ...sent.slice(-room)]
    }
    await writeJson(this.file, { version: 1, updatedAt: new Date().toISOString(), entries: this.entries })
  }

  /** Add an envelope unless an entry with the same id is already queued. */
  async enqueue(envelope) {
    await this.load()
    if (this.entries.some((entry) => entry.envelope?.id === envelope.id)) return false
    this.entries.push({
      envelope,
      attempts: 0,
      nextAt: 0,
      lastError: null,
      state: 'pending',
      queuedAt: new Date().toISOString(),
    })
    await this.persist()
    return true
  }

  /** Entries whose backoff has elapsed, oldest first. */
  async due(now = Date.now()) {
    await this.load()
    return this.entries
      .filter((entry) => entry.state !== 'sent' && Number(entry.nextAt ?? 0) <= now)
      .sort((a, b) => String(a.envelope?.ts ?? '').localeCompare(String(b.envelope?.ts ?? '')))
  }

  async markSent(id) {
    await this.load()
    const entry = this.entries.find((item) => item.envelope?.id === id)
    if (!entry) return
    entry.state = 'sent'
    entry.sentAt = new Date().toISOString()
    entry.lastError = null
    // Sent entries carry no further value: the mailbox has them, and a resend is
    // a duplicate (409) anyway. Keep them only until the next prune.
    this.entries = this.entries.filter((item) => item.envelope?.id !== id)
    await this.persist()
  }

  /**
   * Record a failed attempt. Delay grows exponentially from `baseBackoffMs` and
   * is capped, so a long outage costs one probe every few minutes instead of a
   * hot loop. After `maxAttempts` the entry is parked (`state: 'parked'`) rather
   * than deleted — the user can see it in the card and retry manually.
   */
  async markFailed(id, error) {
    await this.load()
    const entry = this.entries.find((item) => item.envelope?.id === id)
    if (!entry) return { attempts: 0, nextAt: 0, parked: false }
    entry.attempts = Number(entry.attempts ?? 0) + 1
    entry.lastError = String(error?.message ?? error ?? 'unknown').slice(0, 500)
    const parked = entry.attempts >= this.maxAttempts
    entry.state = parked ? 'parked' : 'pending'
    const delay = Math.min(this.baseBackoffMs * 2 ** (entry.attempts - 1), this.maxBackoffMs)
    entry.nextAt = parked ? Number.MAX_SAFE_INTEGER : Date.now() + delay
    await this.persist()
    await journal(this.journalFile, {
      kind: parked ? 'outbox-parked' : 'outbox-retry',
      id,
      attempts: entry.attempts,
      delayMs: parked ? null : delay,
      error: entry.lastError,
    })
    return { attempts: entry.attempts, nextAt: entry.nextAt, parked }
  }

  /** Manual retry: clear the backoff and un-park, keeping the attempt count visible. */
  async retry(id) {
    await this.load()
    const entry = this.entries.find((item) => item.envelope?.id === id)
    if (!entry) return false
    entry.state = 'pending'
    entry.nextAt = 0
    await this.persist()
    return true
  }

  async retryAll() {
    await this.load()
    let count = 0
    for (const entry of this.entries) {
      if (entry.state === 'sent') continue
      entry.state = 'pending'
      entry.nextAt = 0
      count += 1
    }
    if (count > 0) await this.persist()
    return count
  }

  async stats() {
    await this.load()
    const pending = this.entries.filter((entry) => entry.state === 'pending').length
    const parked = this.entries.filter((entry) => entry.state === 'parked').length
    // Only entries that carry a `nextAt` may anchor the "next retry" reading: a
    // freshly queued entry has nextAt=null and must not drag the minimum to 0
    // (which would report "no retry scheduled" while a backoff is actually armed).
    const nextAt = this.entries
      .filter((entry) => entry.state === 'pending' && Number(entry.nextAt) > 0)
      .reduce((min, entry) => Math.min(min, Number(entry.nextAt)), Number.POSITIVE_INFINITY)
    return {
      pending,
      parked,
      total: this.entries.length,
      nextAttemptAt: Number.isFinite(nextAt) && nextAt > 0 ? new Date(nextAt).toISOString() : null,
      lastError: this.entries.find((entry) => entry.lastError)?.lastError ?? null,
    }
  }
}
