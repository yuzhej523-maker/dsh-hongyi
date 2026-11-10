/**
 * Telemetry throttling.
 *
 * Two rules from the brief, both implemented here as one pure decision:
 *   1. report when the observed state actually CHANGED (within `minGapSec`);
 *   2. otherwise send one summary every `summaryIntervalSec` (10 min).
 *
 * A heartbeat (`heartbeatSec`, 30 s) is *not* the same thing as a summary: it is
 * the liveness proof the phone uses to decide 在线/离线, and it is deliberately
 * cheap — the APK only needs to know the last time it heard from us.
 *
 * Keeping the decision pure (`decide`) means the expensive part (writing to the
 * mailbox) is opt-in and countable, and the tests can drive the clock directly
 * instead of sleeping.
 */
import crypto from 'node:crypto'

/** A stable digest of the fields whose change is worth an immediate report. */
export function digestOf(state) {
  const canonical = JSON.stringify({
    online: Boolean(state?.online),
    enabled: Boolean(state?.enabled),
    driver: state?.driver ?? '',
    box: state?.box ?? '',
    queuePending: Number(state?.queuePending ?? 0),
    queueParked: Number(state?.queueParked ?? 0),
    lastCommand: state?.lastCommand ?? '',
    lastCommandOk: state?.lastCommandOk ?? null,
    // 任务状态也要参与节流：新任务开跑/结束/卡住都该立刻让手机看到，
    // 但不能因为「日志又多了一行」就发一封信（所以用 tasks.signature 短指纹）。
    tasks: state?.tasks?.signature ?? '',
  })
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

/** 短指纹：把任意几个字符串揉成一个稳定的小标识（用于任务列表的变化检测）。 */
export function digestTail(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0001'), 'utf8').digest('hex').slice(0, 10)
}

/**
 * @param {object} input
 * @param {string} input.digest          digest of the current state
 * @param {string} input.lastDigest      digest of the last reported state
 * @param {number} input.now             epoch ms
 * @param {number} input.lastSentAt      epoch ms of the last outbound report (0 = never)
 * @param {number} [input.minGapSec]     never send more often than this (default 10)
 * @param {number} [input.summaryIntervalSec] unchanged-state summary period (default 600)
 * @param {number} [input.heartbeatSec]  liveness heartbeat period (default 30)
 * @returns {{send:boolean, reason:'first'|'change'|'summary'|'heartbeat'|'idle'}}
 */
export function decide({
  digest,
  lastDigest,
  now,
  lastSentAt,
  lastHeartbeatAt = 0,
  minGapSec = 10,
  summaryIntervalSec = 600,
  heartbeatSec = 30,
}) {
  const sinceSent = lastSentAt === 0 ? Number.POSITIVE_INFINITY : now - lastSentAt
  // Any successful send is also proof of life, so the heartbeat clock starts at
  // whichever came last — otherwise a state report would be followed immediately
  // by a redundant heartbeat half a second later.
  const lastContact = Math.max(lastSentAt, lastHeartbeatAt)
  const sinceBeat = lastContact === 0 ? Number.POSITIVE_INFINITY : now - lastContact
  const gapOk = sinceSent >= minGapSec * 1000

  if (lastSentAt === 0) return { send: true, reason: 'first' }
  if (digest !== lastDigest && gapOk) return { send: true, reason: 'change' }
  if (sinceSent >= summaryIntervalSec * 1000) return { send: true, reason: 'summary' }
  if (sinceBeat >= heartbeatSec * 1000) return { send: true, reason: 'heartbeat' }
  return { send: false, reason: 'idle' }
}
