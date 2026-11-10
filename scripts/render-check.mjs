/**
 * Render smoke test for the settings card WITHOUT a real React.
 *
 * The host injects `react` into the module loader, so `react` is not resolvable
 * from this package (and never should be a dependency). That leaves a gap: a typo
 * inside the card — an undefined variable in the new relay section, a mismatched
 * tag — would only show up in the real GUI. This script closes the gap with a
 * ~100-line hook shim: it loads client.js through a fake `__ModuleLoader__`,
 * provides a fake `react`, fakes `fetch` against a fixture state, and renders the
 * card in both branches (loading, and fully loaded with a live outbox).
 *
 * Run: node scripts/render-check.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* --------------------------------------------------------------- react shim */

let hookIndex = 0
let hookState = []
const effects = []
let pendingSetState = null

const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(initial) {
    const i = hookIndex++
    if (!(i in hookState)) hookState[i] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      hookState[i] = typeof next === 'function' ? next(hookState[i]) : next
      pendingSetState = true
    }
    return [hookState[i], setter]
  },
  useEffect(fn) {
    const i = hookIndex++
    effects.push({ i, fn })
  },
  useRef(initial) {
    const i = hookIndex++
    if (!(i in hookState)) hookState[i] = { current: initial }
    return hookState[i]
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useMemo(fn) {
    hookIndex += 1
    return fn()
  },
}

/* ------------------------------------------------------------- loader shim */

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

const source = await fs.readFile(path.join(root, 'client.js'), 'utf8')
// The bundle is CJS-ish: it calls the loader with an inline factory.
new Function('window', 'console', source)(globalThis.window, console)

if (!loaded || loaded.id !== 'dsh-hongyi') throw new Error(`client.js 没有通过 __ModuleLoader__.load 注册 dsh-hongyi（得到 ${loaded?.id}）`)
const plugin = loaded.factory((name) => {
  if (name === 'react') return react
  throw new Error(`client.js 只允许 require('react')，却要求了 ${name}`)
})
console.log(`✔ loader 注册 id=${loaded.id}`)
console.log(`✔ 模块导出：inject=${JSON.stringify(plugin.inject)}，apply=${typeof plugin.apply}`)

/* --------------------------------------------------------------- host shim */

let registered = null
const hostCtx = {
  slots: {
    inject(name, thunk) {
      if (name !== 'settings.section') throw new Error(`registered into unexpected slot ${name}`)
      return thunk()
    },
    register(meta, component) {
      registered = { meta, component }
      return () => {
        registered = null
      }
    },
  },
}
plugin.apply(hostCtx)
if (!registered) throw new Error('apply() 没有注册设置卡片')
console.log(`✔ 设置卡片已注册：id=${registered.meta.id} order=${registered.meta.order} label=${registered.meta.label()}`)
const Card = registered.component

/* ------------------------------------------------------------- fetch shim */

const SCENARIOS = [
  {
    name: '首屏（state 还没取回来）',
    // No fixtures at all: every fetch 404s, so the card must stay in its loading
    // shell. This is what a user sees for the first ~100ms after opening settings.
    routes: {},
    expect: ['鸿驿 · 云端中转'],
    // The loading shell is replaced as soon as state resolves, so the relay
    // section (which needs state) must not be in it.
    forbid: ['中转 · 上行 / 下行'],
  },
  {
    name: '已连接 + 中转运行 + 队列有积压',
    routes: {
      state: {
        version: '0.4.0', protocol: 1, phase: 4, home: 'D:\\dsh-data\\.dsh\\hongyi',
        config: {
          driver: 'mock', baseUrl: 'http://127.0.0.1:7654', box: 'dsh-hongyi', wecomWebhook: '',
          enabled: true, telemetry: {}, relay: { intervalMs: 15000 }, link: { cdpPort: 0, cliPath: '', enabled: false },
          tasks: { stallAfterSec: 180, recentLimit: 5 }, imapQuiet: true,
        },
        credentials: { tokenSet: true, token: 'abcd••••ef', deviceSecretSet: true },
        drivers: [{ id: 'mock', label: '本地模拟信箱', ready: true }, { id: 'tencent-docs', label: '腾讯文档', ready: false }],
      },
      relay: {
        ok: true, running: true, paused: false, intervalMs: 15000, needsModel: 2,
        status: {
          sent: 12, received: 3, executed: 2, skippedDuplicate: 1, lastTickAt: '2026-11-10T05:20:00.000Z',
          lastTickError: null, ticks: 40,
        },
        outbox: { pending: 2, parked: 1, total: 3, nextAttemptAt: '2026-11-10T05:21:00.000Z', lastError: '信箱不可达：fetch failed' },
      },
      outbox: {
        ok: true,
        stats: { pending: 2, parked: 1, total: 3, nextAttemptAt: '2026-11-10T05:21:00.000Z', lastError: '信箱不可达：fetch failed' },
        entries: [
          { id: 'telemetry_mwa8kbb3_931f14e2d474aa3b', type: 'telemetry', state: 'pending', attempts: 2, nextAt: '2026-11-10T05:21:00.000Z', lastError: '信箱不可达：fetch failed' },
          { id: 'ack_mwa8kbea_d4f958904a8699c0', type: 'ack', state: 'parked', attempts: 12, nextAt: null, lastError: 'timeout' },
        ],
      },
      tasks: {
        ok: true, source: 'http', updatedAt: '19:30:00',
        tasks: {
          total: 7, running: 2, failed: 1, stalled: 1, signature: 'abcd1234ef',
          recent: [
            { id: 'bg-mwa1', name: 'hongyi-apk-build', status: 'running', exitCode: null, engine: 'pwsh', ageSec: 240, idleSec: 12, stalled: false, tail: 'Compiling lib/main.dart…' },
            { id: 'bg-mwa2', name: 'sdk-download', status: 'running', exitCode: null, engine: 'pwsh', ageSec: 900, idleSec: 420, stalled: true, tail: '...1250/1849 MB' },
            { id: 'bg-mwa3', name: 'regress-all', status: 'done', exitCode: 1, engine: 'pwsh', ageSec: 1200, idleSec: 1200, stalled: false, tail: 'FAIL smoke-phase1' },
          ],
        },
      },
      doctor: {
        ok: true, summary: '9/9 通过',
        checks: [
          { id: 'node', label: 'Node 运行时', ok: true, detail: 'Node 24.19.0', hint: '' },
          { id: 'secret', label: '设备密钥', ok: false, detail: '未设置', hint: '建议在真实信箱前生成' },
        ],
      },
    },
    expect: [
      '鸿驿 · 连接状态',
      'v0.4.0 · 协议 v1 · Phase 4',
      '云端信箱',
      'API 凭据与设备密钥',
      '中转 · 上行 / 下行',
      '轮询 15000ms',
      '待发 2 · 暂停 1',
      '待云端解析 2',
      '已发 12 · 已收 3 · 已执行 2 · 幂等跳过 1',
      '立即同步',
      '暂停上行',
      '重试队列',
      '任务监测',
      '运行中 2',
      '疑似卡住 1',
      '失败 1',
      'hongyi-apk-build',
      'sdk-download',
      'regress-all',
      '刷新任务列表',
    ],
    forbid: ['正在读取鸿驿状态…'],
  },
  {
    name: '中转未启动（降级显示）',
    routes: {
      state: {
        version: '0.4.0', protocol: 1, phase: 4, home: 'D:\\h',
        config: { driver: 'mock', baseUrl: 'http://127.0.0.1:7654', box: 'b', wecomWebhook: '', enabled: false, telemetry: {}, relay: {}, link: {}, tasks: {}, imapQuiet: true },
        credentials: { tokenSet: false, deviceSecretSet: false, token: '未设置' },
        drivers: [],
      },
      relay: { ok: false, reason: '中转引擎未启动（插件未激活或已被清理）' },
      tasks: { ok: false, reason: '采集失败：/bgjobs/state 不可达' },
      outbox: { ok: false, reason: '中转引擎未启动' },
    },
    expect: ['中转 · 上行 / 下行', '未启动', '中转引擎未启动（插件未激活或已被清理）', '插件已停用', '任务监测', '采集失败：/bgjobs/state 不可达'],
  },
]

let failures = 0
const ok = (m) => console.log(`  ✔ ${m}`)
const fail = (m) => {
  failures += 1
  console.log(`  ✘ ${m}`)
}

function renderTreeOnce(CardComponent) {
  hookIndex = 0
  effects.length = 0
  return CardComponent({})
}

/** Walk a fake element tree and describe what a user would see. */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  // Function components (StatusLight, Field, …) carry their text in the subtree
  // they RETURN, not in `children` — a flattener that ignores them silently hides
  // every status label, which would make this check pass on a broken card.
  if (typeof node.type === 'function') {
    flatten(node.type(node.props ?? {}), out)
    return out
  }
  if (node.type === 'input') out.push(`<输入框 ${JSON.stringify(node.props.value ?? '').slice(0, 40)}>`)
  if (node.type === 'select') out.push('<下拉框>')
  if (node.type === 'button') out.push(`[按钮 ${flatten(node.children).join(' ')}]`)
  flatten(node.children, out)
  return out
}

for (const scenario of SCENARIOS) {
  console.log(`\n— 渲染场景：${scenario.name} —`)
  hookState = []
  globalThis.fetch = async (url) => {
    const name = String(url).replace('/hongyi/', '')
    const payload = scenario.routes[name]
    if (payload === undefined) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, reason: `no fixture for ${name}` }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }

  // First pass = the render a user sees before any fetch resolves.
  let tree
  try {
    tree = renderTreeOnce(Card)
  } catch (error) {
    fail(`首次渲染抛错：${error.message}`)
    continue
  }
  const firstTexts = flatten(tree)
  ok(`首次渲染成功（${firstTexts.length} 段可见文本）`)
  if (scenario.expectLoading && firstTexts.some((t) => t.includes(scenario.expectLoading))) {
    ok(`加载态可见「${scenario.expectLoading}」`)
  }

  // Drain effects and re-render until the tree stops changing. Cleanups are run
  // only at the very end: `aliveRef` is set to false by the cleanup, and running
  // it early would make every setState a no-op (the card would stay in "加载中"
  // forever) — which is exactly the bug this loop is here to catch.
  const cleanups = []
  let previousSignature = ''
  for (let round = 1; round <= 8; round += 1) {
    const effectsToRun = effects.slice()
    effects.length = 0
    for (const { fn } of effectsToRun) {
      try {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      } catch (error) {
        fail(`effect 抛错：${error.message}`)
      }
    }
    await new Promise((r) => setTimeout(r, 15))
    try {
      tree = renderTreeOnce(Card)
    } catch (error) {
      fail(`第 ${round} 次重渲染抛错：${error.message}`)
      break
    }
    const signature = flatten(tree).join('|')
    if (signature === previousSignature) break
    previousSignature = signature
  }
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch {
      /* the card's cleanup is trivial */
    }
  }

  const texts = flatten(tree)
  console.log(`  可见文本 ${texts.length} 段`)
  for (const expected of scenario.expect ?? []) {
    if (texts.some((t) => t.includes(expected))) ok(`界面出现「${expected}」`)
    else fail(`界面缺少「${expected}」`)
  }
  for (const forbidden of scenario.forbid ?? []) {
    if (texts.some((t) => t.includes(forbidden))) fail(`界面不该出现「${forbidden}」`)
    else ok(`界面未出现「${forbidden}」`)
  }
}

console.log('\n═══ 结果 ═══')
if (failures === 0) {
  console.log('✔ 设置卡片在三种状态下都能渲染，按钮与状态灯齐全')
} else {
  console.log(`✘ ${failures} 条检查失败`)
}
process.exit(failures === 0 ? 0 : 1)
