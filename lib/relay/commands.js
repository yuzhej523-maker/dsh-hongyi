/**
 * Structured-command parsing — the "省积分铁律" lives here.
 *
 * The four verbs the phone may send (start / stop / status / download <url>) are
 * matched by plain string rules and executed locally. Nothing in this file can
 * reach a model: a payload either matches a known verb (and becomes an action)
 * or it is *classified* as needing one (`needs_model`), queued for the optional
 * WorkBuddy cloud task. That split is the whole point of the design, so it is
 * implemented as a pure function with no I/O — easy to test, impossible to
 * accidentally turn into a model call.
 */

/** Verbs executed on the PC without any model involvement. */
export const LOCAL_ACTIONS = ['start', 'stop', 'status', 'tasks', 'download', 'help']

const VERB_PATTERNS = [
  { action: 'start', re: /^(?:start|run|resume|开始|启动|继续|恢复)(?:\s|$)/i },
  { action: 'stop', re: /^(?:stop|pause|halt|停止|暂停|别同步|停)/i },
  { action: 'tasks', re: /^(?:tasks|jobs|tasklist|任务|任务列表|在跑什么|跑到哪|卡住了吗)(?:\s|$)/i },
  { action: 'status', re: /^(?:status|state|ping|状态|情况|在吗)(?:\s|$)/i },
  { action: 'download', re: /^(?:download|get|fetch|下载|取文件|拉取)(?:\s|$)/i },
  { action: 'help', re: /^(?:help|commands|帮助|指令)(?:\s|$)/i },
]

/** A URL is the only argument `download` accepts. */
const URL_RE = /^https?:\/\/[^\s]+$/i

/**
 * @param {{ text?: string, cmd?: string, arg?: string }} input
 * @returns {{kind:'action', action:string, arg:string} | {kind:'needs_model', text:string, reason:string}}
 */
export function parseCommand(input) {
  const rawCmd = typeof input?.cmd === 'string' ? input.cmd.trim() : ''
  const rawArg = typeof input?.arg === 'string' ? input.arg.trim() : ''
  const rawText = typeof input?.text === 'string' ? input.text.trim() : ''

  // The APK's quick buttons send `cmd`; free-form text arrives in `text`.
  const source = rawCmd.length > 0 ? `${rawCmd} ${rawArg}`.trim() : rawText

  if (source.length === 0) {
    return { kind: 'needs_model', text: '', reason: '空指令：既没有结构化命令也没有文本' }
  }

  if (rawCmd.length > 0) {
    const verb = rawCmd.toLowerCase()
    if (!LOCAL_ACTIONS.includes(verb)) {
      // An unknown verb from the quick buttons is a client bug, not free text —
      // say so instead of burning a model call on it.
      return {
        kind: 'needs_model',
        text: source,
        reason: `未知的结构化命令「${rawCmd}」；支持：${LOCAL_ACTIONS.join(' / ')}`,
      }
    }
    if (verb === 'download') {
      if (!URL_RE.test(rawArg)) {
        return { kind: 'needs_model', text: source, reason: 'download 需要一个 http(s) 地址作为参数' }
      }
      return { kind: 'action', action: 'download', arg: rawArg }
    }
    return { kind: 'action', action: verb, arg: rawArg }
  }

  for (const { action, re } of VERB_PATTERNS) {
    const match = re.exec(source)
    if (!match) continue
    if (action === 'download') {
      const rest = source.slice(match[0].length).trim()
      if (!URL_RE.test(rest)) {
        return { kind: 'needs_model', text: source, reason: 'download 后面紧跟的必须是一个 http(s) 地址' }
      }
      return { kind: 'action', action: 'download', arg: rest }
    }
    return { kind: 'action', action, arg: rawCmd.length > 0 ? rawArg : source.slice(match[0].length).trim() }
  }

  // Anything else is natural language: hand it to the optional cloud task.
  return { kind: 'needs_model', text: source, reason: '自然语言指令：本地不做语义解析（省积分）' }
}
