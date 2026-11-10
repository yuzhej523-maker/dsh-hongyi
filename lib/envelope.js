/**
 * The unified message envelope.
 *
 *   { v, id, type, from, to, ts, ttl, payload, sig }
 *
 * `v` is the protocol version (added here even though Phase 1's brief lists it
 * without one: the last milestone asks for a `v` field and explicit
 * incompatibility errors, and retro-fitting it later would break old APK
 * builds). `id` is globally unique and is the only dedupe key — every consumer
 * must treat a repeated id as already applied.
 */
import crypto from 'node:crypto'

export const PROTOCOL_VERSION = 1
export const MESSAGE_TYPES = ['telemetry', 'file', 'command', 'ack', 'event']

export function nowIso(date = new Date()) {
  return date.toISOString()
}

export function newId(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`
}

/**
 * Canonical byte string a signature covers. Field order is fixed so both halves
 * read the same bytes regardless of JSON key order.
 */
export function signingBase(env) {
  const payload = typeof env.payload === 'string' ? env.payload : JSON.stringify(env.payload ?? null)
  return [env.v, env.id, env.type, env.from, env.to, env.ts, env.ttl, payload].join('\u0001')
}

export function sign(env, secret) {
  if (!secret) return ''
  return crypto.createHmac('sha256', secret).update(signingBase(env), 'utf8').digest('hex')
}

export function verify(env, secret) {
  if (!secret) return true
  if (typeof env.sig !== 'string' || env.sig.length === 0) return false
  const expected = sign(env, secret)
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(env.sig, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export class EnvelopeError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'EnvelopeError'
    this.details = details
  }
}

export function createEnvelope({
  type,
  from,
  to,
  payload,
  ttl = 300,
  id = newId(type),
  ts = nowIso(),
  secret = '',
  extra = {},
} = {}) {
  if (!MESSAGE_TYPES.includes(type)) {
    throw new EnvelopeError(`unknown envelope type: ${String(type)}`, { allowed: MESSAGE_TYPES })
  }
  if (!from || !to) throw new EnvelopeError('from and to are required')
  const env = {
    v: PROTOCOL_VERSION,
    id,
    type,
    from,
    to,
    ts,
    ttl,
    payload: payload ?? {},
    ...extra,
    sig: '',
  }
  env.sig = sign(env, secret)
  return env
}

/**
 * Structural + version validation. Returns the envelope when it is usable and
 * throws a descriptive EnvelopeError otherwise, so a peer running an older or
 * newer protocol gets a message it can act on instead of a silent no-op.
 */
export function validateEnvelope(env, { secret = '', now = Date.now() } = {}) {
  if (env === null || typeof env !== 'object') throw new EnvelopeError('envelope is not an object')
  if (env.v === undefined) {
    throw new EnvelopeError(
      'envelope has no protocol version field (v); this build speaks v' + PROTOCOL_VERSION,
      { got: null, expected: PROTOCOL_VERSION },
    )
  }
  if (Number(env.v) !== PROTOCOL_VERSION) {
    throw new EnvelopeError(
      `incompatible protocol version v${env.v}; this build speaks v${PROTOCOL_VERSION}`,
      { got: env.v, expected: PROTOCOL_VERSION },
    )
  }
  for (const field of ['id', 'type', 'from', 'to', 'ts']) {
    if (typeof env[field] !== 'string' || env[field].length === 0) {
      throw new EnvelopeError(`envelope field "${field}" is missing or not a string`)
    }
  }
  if (!MESSAGE_TYPES.includes(env.type)) {
    throw new EnvelopeError(`unknown envelope type: ${env.type}`, { allowed: MESSAGE_TYPES })
  }
  if (!verify(env, secret)) throw new EnvelopeError('signature mismatch (bad device secret)', { id: env.id })
  if (isExpired(env, now)) throw new EnvelopeError(`envelope ${env.id} expired`, { ttl: env.ttl })
  return env
}

/** TTL is a wall-clock budget in seconds from `ts`; 0 or negative means "never". */
export function isExpired(env, now = Date.now()) {
  const ttl = Number(env?.ttl ?? 0)
  if (!Number.isFinite(ttl) || ttl <= 0) return false
  const created = Date.parse(env.ts)
  if (!Number.isFinite(created)) return false
  return now - created > ttl * 1000
}

/** A ping/pong pair is the cheapest possible end-to-end proof of the link. */
export function createPing({ from = 'dsh', to = 'phone', secret = '', ttl = 120 } = {}) {
  return createEnvelope({
    type: 'event',
    from,
    to,
    ttl,
    secret,
    payload: { kind: 'ping', at: nowIso(), protocol: PROTOCOL_VERSION },
  })
}

export function createPong(ping, { secret = '', ttl = 120 } = {}) {
  return createEnvelope({
    type: 'event',
    from: ping.to,
    to: ping.from,
    ttl,
    secret,
    payload: { kind: 'pong', echoOf: ping.id, at: nowIso(), protocol: PROTOCOL_VERSION },
  })
}
