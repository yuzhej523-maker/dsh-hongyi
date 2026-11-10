window.__ModuleLoader__.load({
  id: 'dsh-hongyi',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const ENDPOINT = '/hongyi'

    /* ---------------------------------------------------------------- styles
     * Inline objects keep the card self-contained: no stylesheet is injected into
     * the shell, so unmounting the section cannot leave orphan CSS behind.
     * Colours come from theme tokens with plain fallbacks so the card follows the
     * host theme instead of fighting it.
     */
    const C = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      sub: 'var(--dsw-alias-label-secondary, #5b6470)',
      faint: 'var(--dsw-alias-label-tertiary, #8b93a1)',
      line: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
      panel: 'var(--dsw-alias-bg-l2, rgba(127,127,127,0.06))',
      accent: 'var(--dsw-alias-state-business-primary, #2f6df6)',
      ok: 'var(--dsw-alias-state-success-primary, #12a150)',
      warn: 'var(--dsw-alias-state-warning-primary, #c68108)',
      bad: 'var(--dsw-alias-state-error-primary, #d33b3b)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 18px', color: C.text, fontSize: 13 },
      card: { border: `1px solid ${C.line}`, borderRadius: 10, padding: '12px 14px', background: C.panel },
      head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
      title: { fontSize: 13, fontWeight: 600, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' },
      label: { minWidth: 92, color: C.sub, fontSize: 12 },
      input: {
        flex: '1 1 220px', minWidth: 180, padding: '6px 9px', fontSize: 12,
        borderRadius: 7, border: `1px solid ${C.line}`, background: 'transparent', color: C.text, outline: 'none',
      },
      select: {
        padding: '6px 9px', fontSize: 12, borderRadius: 7,
        border: `1px solid ${C.line}`, background: 'transparent', color: C.text,
      },
      btn: {
        padding: '6px 12px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
        border: `1px solid ${C.line}`, background: 'transparent', color: C.text,
      },
      btnPrimary: {
        padding: '6px 12px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
        border: `1px solid ${C.accent}`, background: C.accent, color: '#fff',
      },
      btnDanger: {
        padding: '6px 12px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
        border: `1px solid ${C.bad}`, background: 'transparent', color: C.bad,
      },
      hint: { fontSize: 11.5, color: C.faint, lineHeight: 1.6, margin: '4px 0 0' },
      mono: { fontFamily: C.mono, fontSize: 11.5 },
      light: (state) => ({
        width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto',
        background: state === 'ok' ? C.ok : state === 'warn' ? C.warn : state === 'bad' ? C.bad : C.faint,
        boxShadow: state === 'ok' ? `0 0 0 3px ${C.ok}22` : 'none',
      }),
      log: {
        marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.line}`,
        background: 'rgba(0,0,0,0.04)', fontFamily: C.mono, fontSize: 11.5,
        whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', lineHeight: 1.55,
      },
    }

    /* ------------------------------------------------------------- transport
     * The card talks to the host half through the plugin's own named route, so
     * there is exactly one implementation of every operation (also reachable via
     * the `/hongyi` command).
     */
    async function call(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const response = await fetch(`${ENDPOINT}/${path}`, init)
      const text = await response.text()
      let data
      try {
        data = text.length > 0 ? JSON.parse(text) : {}
      } catch {
        throw new Error(`鸿驿返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 160)}`)
      }
      if (!response.ok) throw new Error(data.reason ?? `鸿驿请求失败（HTTP ${response.status}）`)
      return data
    }

    function StatusLight({ state, label }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { style: S.light(state) }),
        h('span', { style: { fontSize: 12, color: C.sub } }, label))
    }

    function Field({ label, hint, children }) {
      return h('div', { style: { marginBottom: 8 } },
        h('div', { style: S.row },
          h('span', { style: S.label }, label),
          children),
        hint ? h('p', { style: S.hint }, hint) : null)
    }

    /* ------------------------------------------------------------------ card */
    function HongyiCard() {
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [log, setLog] = useState('')
      const [doctor, setDoctor] = useState(null)
      const [tokenDraft, setTokenDraft] = useState('')
      const [showLink, setShowLink] = useState(false)
      const [draft, setDraft] = useState(null)
      const [relay, setRelay] = useState(null)
      const [outbox, setOutbox] = useState(null)
      const [tasks, setTasks] = useState(null)
      /** 手机发来的指令流水（读 journal.ndjson；桌面端也要看得见）。 */
      const [commands, setCommands] = useState(null)      /** 收件箱（手机发过来的文件）与发送状态。 */
      const [inbox, setInbox] = useState(null)
      const [draftImapAuth, setDraftImapAuth] = useState('')
      /** 设备密钥明文，只在用户点「显示密钥」时短暂持有；'' = 已隐藏。 */
      const [secretShown, setSecretShown] = useState('')
      /** 邮箱授权码获取手册的展开状态（默认收起，避免设置页太长）。 */
      const [showManual, setShowManual] = useState(false)
      const aliveRef = useRef(true)

      useEffect(() => () => { aliveRef.current = false }, [])

      const refresh = useCallback(async () => {
        try {
          const next = await call('state')
          if (!aliveRef.current) return
          setState(next)
          setDraft((prev) => prev ?? {
            driver: next.config.driver,
            baseUrl: next.config.baseUrl,
            folderRoot: next.config.folderRoot,
            imapUser: next.config.imapUser,
            imapProvider: next.config.imapProvider,
            imapQuiet: next.config.imapQuiet !== false,
            imapQuietFolder: next.config.imapQuietFolder,
            box: next.config.box,
            wecomWebhook: next.config.wecomWebhook,
            enabled: next.config.enabled,
            tasks: next.config.tasks,
            sendPath: '',
          })
          setError('')
        } catch (e) {
          if (aliveRef.current) setError(e.message ?? String(e))
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const run = useCallback(async (tag, fn) => {
        setBusy(tag)
        setError('')
        try {
          const result = await fn()
          return result
        } catch (e) {
          if (aliveRef.current) setError(e.message ?? String(e))
          return null
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [])

      const onSave = () => run('save', async () => {
        const next = await call('save', draft)
        setState(next)
        // 授权码是独立凭据：imap 模式且填写了授权码时随保存一起提交
        if (draft?.driver === 'imap' && draftImapAuth.trim()) {
          const authNext = await call('imap-auth', { auth: draftImapAuth.trim() })
          setDraftImapAuth('')
          setState(authNext)
        }
        setLog('✔ 设置已保存')
      })

      const onTest = () => run('probe', async () => {
        const result = await call('probe', {})
        if (result.state) setState(result.state)
        const lines = [
          result.ok ? '✔ 测试连接通过' : '✘ 测试连接失败',
          `  阶段：${result.stage}`,
          `  说明：${result.message}`,
          result.latencyMs !== undefined ? `  耗时：${result.latencyMs}ms` : '',
          result.pingId ? `  ping id：${result.pingId}` : '',
        ].filter(Boolean)
        setLog(lines.join('\n'))
      })

      const onPing = () => run('ping', async () => {
        const result = await call('ping')
        setLog([result.ok ? '✔ ping/pong 完成' : '✘ ping 失败', `  ${result.message}`, result.pingId ? `  id：${result.pingId}` : '']
          .filter(Boolean).join('\n'))
      })

      const onDoctor = () => run('doctor', async () => {
        const report = await call('doctor')
        setDoctor(report)
        setLog(`自检：${report.summary}`)
      })

      const onSetToken = () => run('token', async () => {
        const next = await call('token', { token: tokenDraft })
        setState(next)
        setTokenDraft('')
        setLog(tokenDraft.trim() ? '✔ 凭据已保存' : '✔ 凭据已清空')
      })

      const onSetImapAuth = () => run('imap-auth', async () => {
        const next = await call('imap-auth', { auth: draftImapAuth })
        setState(next)
        setDraftImapAuth('')
        setLog(draftImapAuth.trim() ? '✔ 授权码已保存' : '✔ 授权码已清空')
      })

      const onRevoke = () => run('revoke', async () => {
        const next = await call('revoke', {})
        setState(next)
        setLog('✔ 凭据已撤销（token 与设备密钥均已删除）')
      })

      const onSecret = () => run('secret', async () => {
        const next = await call('secret', {})
        setState(next)
        setSecretShown('')
        setLog('✔ 已生成新的设备密钥（点「显示」看明文，再填到手机端）')
      })

      /*
       * [显示密钥] — 单独取一次明文，并给「复制」按钮。
       *
       * 为什么不直接把明文放进 state：state 是卡片每次刷新都会拿的数据，
       * 明文长期挂在里面等于随每次渲染进网络/日志。这里点一次取一次，
       * 并支持「隐藏」立刻清掉。
       */
      const onRevealSecret = () => run('secret-reveal', async () => {
        if (secretShown) { setSecretShown(''); setLog('已隐藏设备密钥'); return }
        const result = await call('secret-reveal', {})
        if (!result.ok) { setLog(`✘ ${result.message}`); return }
        setSecretShown(result.deviceSecret)
        setLog(`✔ ${result.message}`)
      })

      const onCopySecret = async () => {
        if (!secretShown) return
        try {
          if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(secretShown)
            setLog('✔ 设备密钥已复制到剪贴板')
          } else {
            setLog('剪贴板不可用：请手动选中下面那串密钥复制')
          }
        } catch (error) {
          setLog(`剪贴板被拒绝：${error?.message ?? error}　请手动选中复制`)
        }
      }

      /* ---------------------------------------------------------- relay 控制 */

      const refreshRelay = useCallback(async () => {
        try {
          const [relayInfo, outboxInfo, taskInfo, commandInfo, inboxInfo] = await Promise.all([
            call('relay'),
            call('outbox'),
            call('tasks').catch(() => null),
            call('commands?limit=12').catch(() => null),
            call('inbox').catch(() => null),
          ])
          if (inboxInfo) setInbox(inboxInfo)
          if (!aliveRef.current) return
          setRelay(relayInfo)
          setOutbox(outboxInfo)
          if (taskInfo) setTasks(taskInfo)
          if (commandInfo) setCommands(commandInfo)
        } catch (e) {
          if (aliveRef.current) setError(e.message ?? String(e))
        }
      }, [])

      useEffect(() => { refreshRelay() }, [refreshRelay])

      const onTick = () => run('tick', async () => {
        const result = await call('relay-tick', {})
        await refreshRelay()
        const up = result.up?.decision
        const down = result.down ?? {}
        const lines = [
          result.ok ? '✔ 已立即同步一次' : `✘ 同步失败：${result.reason ?? '未知原因'}`,
          up ? `  上行：${up.send ? `已发送（${up.reason}）` : `跳过（${up.reason}）`}` : '',
          result.up?.flushed ? `  补发队列：尝试 ${result.up.flushed.attempted} 条，成功 ${result.up.flushed.sent} 条` : '',
          `  下行：拉取 ${down.pulled ?? 0} 条，处理 ${down.handled ?? 0} 条`,
        ].filter(Boolean)
        setLog(lines.join('\\n'))
      })

      const onRelayStart = () => run('relay-start', async () => {
        await call('relay-start', {})
        await refreshRelay()
        setLog('✔ 中转已恢复上行')
      })

      const onRelayStop = () => run('relay-stop', async () => {
        await call('relay-stop', {})
        await refreshRelay()
        setLog('✔ 中转已暂停上行（下行仍在轮询，可用「恢复上行」打开）')
      })

      const onRefreshTasks = () => run('tasks', async () => {
        const result = await call('tasks?force=1')
        setTasks(result)
        const t = result.tasks ?? {}
        setLog([
          result.ok ? '✔ 任务列表已刷新' : `✘ 采集失败：${result.reason ?? '未知原因'}`,
          `  数据源：${result.source ?? '—'}`,
          `  运行中 ${t.running ?? 0} · 失败 ${t.failed ?? 0} · 疑似卡住 ${t.stalled ?? 0} · 共 ${t.total ?? 0}`,
        ].join('\n'))
      })

      const onRefreshCommands = () => run('commands', async () => {
        const result = await call('commands?limit=12')
        setCommands(result)
        setLog(result.ok ? `✔ 已读取 ${result.total} 条手机指令记录` : '✘ 指令流水读取失败')
      })

      const onSendFile = () => run('send-file', async () => {
        const filePath = String(d?.sendPath ?? '').trim()
        if (!filePath) { setLog('✘ 先填一个文件路径'); return }
        const result = await call('send-file', { path: filePath })
        setLog(result.ok
          ? [`✔ 已发出 ${result.sent}/${result.total} 片，共 ${Math.max(1, Math.round((result.size ?? 0) / 1024))}KB`, `  文件：${result.name}`, `  sha256：${result.sha256}`].join('\n')
          : `✘ 发送失败：${result.reason ?? '未知原因'}`)
        if (result.ok) setDraft((prev) => ({ ...(prev ?? d), sendPath: '' }))
      })

      const onRefreshInbox = () => run('inbox', async () => {
        const result = await call('inbox')
        setInbox(result)
        setLog(result.ok ? `✔ 收件箱 ${result.files?.length ?? 0} 个文件${(result.partial?.length ?? 0) > 0 ? `，${result.partial.length} 个在接收中` : ''}` : '✘ 读取收件箱失败')
      })

      const onRetryAll = () => run('retry', async () => {
        const result = await call('outbox-retry', {})
        await refreshRelay()
        setLog(`✔ 已安排重试：${result.retriedAll ?? 0} 条（待发 ${result.stats?.pending ?? 0}，暂停 ${result.stats?.parked ?? 0}）`)
      })

      if (state === null) {
        return h('div', { style: S.wrap },
          h('div', { style: S.card },
            h('div', { style: S.head },
              h('span', { style: S.light(error ? 'bad' : 'warn') }),
              h('h3', { style: S.title }, '鸿驿 · 云端中转')),
            h('p', { style: S.hint }, error || '正在读取鸿驿状态…')))
      }

      const { config, credentials, drivers, home, protocol, version, phase } = state
      const d = draft ?? config
      const folderMode = d.driver === 'folder' || d.driver === 'tdrive'
      const imapMode = d.driver === 'imap'
      const connected = doctor ? doctor.ok : null

      const driverOptions = (drivers ?? []).map((item) =>
        h('option', { key: item.id, value: item.id }, item.ready ? item.label : `${item.label}（未接入）`))

      return h('div', { style: S.wrap },

        /* ---- 状态 ---- */
        h('div', { style: S.card },
          h('div', { style: S.head },
            h('span', { style: S.light(busy ? 'warn' : connected === false ? 'bad' : connected === true ? 'ok' : 'warn') }),
            h('h3', { style: S.title }, '鸿驿 · 连接状态'),
            h('span', { style: { ...S.hint, marginLeft: 'auto' } }, `v${version} · 协议 v${protocol} · Phase ${phase}`)),
          h('div', { style: S.row },
            h(StatusLight, { state: d.enabled ? 'ok' : 'warn', label: d.enabled ? '插件已启用' : '插件已停用' }),
            h(StatusLight, { state: driverOptions.length > 0 && d.driver === 'mock' ? 'warn' : 'ok', label: `驱动 ${d.driver}` }),
            h(StatusLight, { state: credentials.tokenSet ? 'ok' : 'warn', label: credentials.tokenSet ? `凭据 ${credentials.token}` : '凭据未设置' }),
            h(StatusLight, { state: credentials.deviceSecretSet ? 'ok' : 'warn', label: credentials.deviceSecretSet ? '设备密钥已设置' : '设备密钥未设置' })),
          h('p', { style: S.hint }, `工作目录：${home}　（token 与设备密钥只存在这里，可随时撤销）`))

        /* ---- 信箱 ---- */
        , h('div', { style: S.card },
          h('div', { style: S.head }, h('h3', { style: S.title }, '云端信箱')),

          h(Field, { label: '通道', hint: '「云端文件夹」= 直接读写一个正在同步的云盘目录（腾讯网盘/OneDrive/坚果云/WebDAV 挂载盘均可），不需要任何 API 凭据，也不需要自建服务器。' },
            h('select', {
              style: S.select, value: d.driver,
              onChange: (e) => setDraft({ ...d, driver: e.target.value }),
            }, driverOptions)),

          folderMode
            ? h(Field, { label: '云文件夹路径', hint: '必须是绝对路径，且该目录正被云盘客户端同步。插件只在这里读写 JSON，同步由你的云盘负责。' },
              h('input', {
                style: S.input, value: d.folderRoot, spellCheck: false,
                placeholder: 'C:\Users\你\OneDrive\鸿驿',
                onChange: (e) => setDraft({ ...d, folderRoot: e.target.value }),
              }))
            : imapMode
              ? h('div', {},
                  h(Field, { label: '邮箱地址', hint: 'QQ 邮箱等任何支持 IMAP/SMTP 的邮箱。手机 APK 也直连同一邮箱。' },
                    h('input', {
                      style: S.input, value: d.imapUser, spellCheck: false,
                      placeholder: 'yourname@qq.com',
                      onChange: (e) => setDraft({ ...d, imapUser: e.target.value }),
                    })),
                  h(Field, { label: '邮箱服务商', hint: '决定 IMAP/SMTP 服务器地址与端口。' },
                    h('select', { style: S.input, value: d.imapProvider ?? 'qq', onChange: (e) => setDraft({ ...d, imapProvider: e.target.value }) },
                      h('option', { value: 'qq' }, 'QQ 邮箱（imap.qq.com / smtp.qq.com）'),
                      h('option', { value: '163' }, '163 邮箱（imap.163.com / smtp.163.com）'),
                      h('option', { value: 'gmail' }, 'Gmail（imap.gmail.com / smtp.gmail.com）'),
                      h('option', { value: 'outlook' }, 'Outlook（outlook.office365.com）'))),
                  h(Field, { label: 'IMAP/SMTP 授权码', hint: d.credentials?.imapAuthSet ? "已保存（" + (d.credentials.imapAuth ?? '') + "）。不是邮箱登录密码，是邮箱设置里开启 IMAP/SMTP 服务后生成的授权码。" : '不是邮箱登录密码：在邮箱设置里开启 IMAP/SMTP 服务后生成的授权码。' },
                    h('input', {
                      type: 'password', style: S.input, value: draftImapAuth, spellCheck: false,
                      placeholder: d.credentials?.imapAuthSet ? '已保存，留空则不修改' : '16 位授权码',
                      onChange: (e) => setDraftImapAuth(e.target.value),
                    })),

                  /* ---- 授权码获取手册（可折叠） ----------------------------------
                   * 授权码是整条链路里唯一容易卡住的一步：它不是登录密码、只显示一次、
                   * 且各家邮箱的入口不一样。把步骤直接放在设置页里，用户不用去翻文档。
                   */
                  h('div', { style: { border: '1px solid ' + C.line, borderRadius: 8, marginTop: 6 } },
                    h('div', {
                      style: { ...S.row, margin: 0, padding: '8px 10px', cursor: 'pointer' },
                      onClick: () => setShowManual(!showManual),
                    },
                      h('span', { style: { fontSize: 12, fontWeight: 600 } }, '如何获取 QQ 邮箱授权码'),
                      h('span', { style: { ...S.hint, margin: 0 } }, '（点击' + (showManual ? '收起' : '展开') + '）')),
                    showManual ? h('div', { style: { padding: '0 12px 12px', fontSize: 12, lineHeight: 1.85, color: C.sub } },
                      h('p', { style: { margin: '0 0 6px', color: C.text, fontWeight: 600 } }, '先分清两个概念'),
                      h('p', { style: { margin: '0 0 10px' } },
                        '登录密码 = 你在网页上登邮箱用的；授权码 = 给第三方程序走 IMAP/SMTP 用的 16 位随机码。',
                        h('br'),
                        '本插件要的是授权码。填登录密码会报「凭据无效」或 AUTHENTICATE failed。'),

                      h('p', { style: { margin: '0 0 6px', color: C.text, fontWeight: 600 } }, '步骤（推荐用电脑浏览器）'),
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, margin: '0 0 10px' } },
                        ...[
                          '1. 浏览器打开 mail.qq.com，登录你的 QQ 邮箱。',
                          '2. 右上角「设置」→「账号」页（新版可能叫「账号与安全」）。',
                          '3. 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」这一节。',
                          '4. 开启「IMAP/SMTP 服务」（要发信才能用，别只开 POP3）。',
                          '5. 按提示用绑定手机发一条短信到指定号码，发完点「我已发送」。',
                          '6. 页面弹出 16 位授权码（形如 abcdwxyzefghijkl）——立刻复制保存。',
                          '7. 关掉弹窗就看不到第二次；忘了只能重新生成（旧的立即失效）。',
                        ].map((line, i) => h('div', { key: 'manual-' + i }, line))),

                      h('p', { style: { margin: '0 0 6px', color: C.text, fontWeight: 600 } }, '常见问题'),
                      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, margin: '0 0 10px' } },
                        ...[
                          '· 找不到 IMAP 这一节 → 在设置里搜「IMAP」，或换手机 QQ 邮箱 App 的「设置 → 账号」。',
                          '· 提示需要实名认证 → 先去 QQ 安全中心完成实名。',
                          '· 填了授权码仍 AUTHENTICATE failed → 确认不是登录密码、复制时首尾没空格、没被重新生成。',
                          '· 收不到短信验证 → 先在账号安全里更新绑定手机号。',
                        ].map((line, i) => h('div', { key: 'manual-faq-' + i }, line))),

                      h('p', { style: { margin: '0 0 6px', color: C.text, fontWeight: 600 } }, '其他邮箱'),
                      h('p', { style: { margin: '0 0 10px' } },
                        '163：设置里开 IMAP/SMTP 后拿授权码。Gmail：开两步验证后创建「应用专用密码」。',
                        h('br'),
                        'Outlook：部分账号需管理员开启 IMAP。'),

                      h('p', { style: { margin: 0, color: C.warn } },
                        '注意：静默通道依赖「草稿箱可写」。QQ 邮箱实测支持（APPEND/SEARCH/FETCH/EXPUNGE 全通），',
                        '但不允许创建自定义文件夹。若你的邮箱连草稿箱都不支持，请关掉下面的「静默通道」。'),
                    ) : null),
                  h(Field, {
                    label: '静默通道',
                    hint: '开启后信封写入邮箱「草稿箱」而不是收件箱：不弹新邮件提醒、不进收件箱、没有投递延迟，只有鸿驿自己用 IMAP 读写。实测 QQ 邮箱支持该模式。',
                  },
                    h('input', {
                      type: 'checkbox', checked: d.imapQuiet !== false,
                      onChange: (e) => setDraft({ ...d, imapQuiet: e.target.checked }),
                      style: { width: 16, height: 16, cursor: 'pointer' },
                    })),
                  imapMode && draftImapAuth.trim() ? h(Field, { label: ' ' },
                    h('button', { style: S.btn, disabled: busy === 'imap-auth', onClick: onSetImapAuth },
                      busy === 'imap-auth' ? '保存授权码中…' : '保存授权码（也可随「保存」一起提交）')) : null)
              : h(Field, { label: '信箱地址', hint: 'HTTP(S) 基础地址。本地模拟信箱默认 http://127.0.0.1:7654（先运行 node mock/server.mjs）。' },
                h('input', {
                  style: S.input, value: d.baseUrl, spellCheck: false,
                  placeholder: 'http://127.0.0.1:7654',
                  onChange: (e) => setDraft({ ...d, baseUrl: e.target.value }),
                })),


          h(Field, { label: '信箱名', hint: '一台机器一个信箱名，APK 与 DSH 必须一致。' },
            h('input', {
              style: S.input, value: d.box, spellCheck: false,
              placeholder: 'dsh-hongyi',
              onChange: (e) => setDraft({ ...d, box: e.target.value }),
            })),

          h(Field, { label: '企微 webhook', hint: '可选加速项：只影响实时提醒，不影响收发。留空即关闭。' },
            h('input', {
              style: S.input, value: d.wecomWebhook, spellCheck: false,
              placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
              onChange: (e) => setDraft({ ...d, wecomWebhook: e.target.value }),
            })),

          h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', { style: S.btnPrimary, disabled: busy === 'save' || busy === 'probe', onClick: onSave },
              busy === 'save' ? '保存中…' : '保存'),
            h('button', { style: S.btn, disabled: busy === 'probe', onClick: onTest },
              busy === 'probe' ? '测试中…' : '测试连接'),
            h('button', { style: S.btn, disabled: busy === 'ping', onClick: onPing },
              busy === 'ping' ? '发送中…' : '发一条 ping'),
            h('button', { style: S.btn, disabled: busy === 'doctor', onClick: onDoctor },
              busy === 'doctor' ? '自检中…' : '自检')))

        /* ---- 凭据 ---- */
        , h('div', { style: S.card },
          h('div', { style: S.head }, h('h3', { style: S.title }, 'API 凭据与设备密钥')),
          h(Field, { label: 'API 凭据', hint: '写进 $DSH_HOME/hongyi/credentials.json，不写进 profile 配置，也不会上报。留空提交 = 清空。' },
            h('input', {
              style: S.input, type: 'password', value: tokenDraft, spellCheck: false,
              placeholder: credentials.tokenSet ? `已保存 ${credentials.token}（输入新值可覆盖）` : '未设置',
              onChange: (e) => setTokenDraft(e.target.value),
            }),
            h('button', { style: S.btn, disabled: busy === 'token', onClick: onSetToken }, '保存凭据'),
            h('button', { style: S.btnDanger, disabled: busy === 'revoke', onClick: onRevoke }, '撤销')),
          h(Field, { label: '设备密钥', hint: '信封 HMAC 密钥。两端必须一致，否则消息会被判为伪造而拒收。点「显示」可看明文，照着填到手机 APK 的「设置 → 设备密钥」。' },
            h(StatusLight, { state: credentials.deviceSecretSet ? 'ok' : 'warn', label: credentials.deviceSecretSet ? '已设置' : '未设置' }),
            h('button', { style: S.btn, disabled: busy === 'secret', onClick: onSecret }, '生成新密钥'),
            h('button', { style: S.btn, disabled: busy === 'secret-reveal' || !credentials.deviceSecretSet, onClick: onRevealSecret },
              secretShown ? '隐藏' : '显示'),
            secretShown ? h('button', { style: S.btn, onClick: onCopySecret }, '复制') : null),
          secretShown ? h('div', {
            style: {
              marginTop: 6, padding: '8px 10px', borderRadius: 8,
              border: `1px solid ${C.line}`, background: 'rgba(47,109,246,0.08)',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: 13, wordBreak: 'break-all', userSelect: 'all',
            },
          }, secretShown) : null,
          secretShown ? h('p', { style: S.hint }, `共 ${secretShown.length} 位。手机端填同一个串才能互通；换密钥后记得同步改手机。`) : null)

        /* ---- 自检结果 ---- */
        , doctor ? h('div', { style: S.card },
          h('div', { style: S.head }, h('h3', { style: S.title }, '自检结果'), h('span', { style: { ...S.hint, marginLeft: 'auto' } }, doctor.summary)),
          ...doctor.checks.map((item) => h('div', {
            key: item.id,
            style: { ...S.row, marginBottom: 4, alignItems: 'flex-start' },
          },
          h('span', { style: S.light(item.ok ? 'ok' : 'bad') }),
          h('span', { style: { minWidth: 140, color: C.sub, fontSize: 12 } }, item.label),
          h('span', { style: { flex: 1, fontSize: 12 } }, item.detail),
          item.ok ? null : h('span', { style: { fontSize: 11.5, color: C.warn } }, item.hint || ''))))
          : null

        /* ---- 中转（上下行引擎） ---- */
        , h('div', { style: S.card },
          h('div', { style: S.head },
            h('h3', { style: S.title }, '中转 · 上行 / 下行'),
            h('span', { style: { ...S.hint, marginLeft: 'auto' } },
              relay?.ok ? `${relay.running ? '运行中' : '已停止'}${relay.paused ? ' · 上行暂停' : ''}` : '未启动')),

          relay?.ok ? h('div', { style: S.row },
            h(StatusLight, { state: relay.running ? 'ok' : 'warn', label: relay.running ? `轮询 ${relay.intervalMs ?? '—'}ms` : '轮询已停止' }),
            h(StatusLight, { state: relay.paused ? 'warn' : 'ok', label: relay.paused ? '上行已暂停' : '上行开启' }),
            h(StatusLight, {
              state: (outbox?.stats?.pending ?? 0) > 0 ? 'warn' : 'ok',
              label: `待发 ${outbox?.stats?.pending ?? 0} · 暂停 ${outbox?.stats?.parked ?? 0}`,
            }),
            h(StatusLight, { state: (relay.needsModel ?? 0) > 0 ? 'warn' : 'ok', label: `待云端解析 ${relay.needsModel ?? 0}` }))
          : h('p', { style: S.hint }, relay?.reason ?? '正在读取中转状态…'),

          relay?.ok ? h('div', { style: { ...S.hint, fontSize: 11.5, marginTop: 2 } },
            `已发 ${relay.status.sent} · 已收 ${relay.status.received} · 已执行 ${relay.status.executed} · 幂等跳过 ${relay.status.skippedDuplicate}`
            + (relay.status.lastTickAt ? `　最近一跳 ${relay.status.lastTickAt}` : '')
            + (relay.status.lastTickError ? `　最近错误：${relay.status.lastTickError}` : '')
            + (outbox?.stats?.nextAttemptAt ? `　下次重试 ${outbox.stats.nextAttemptAt}` : ''))
          : null,

          h('p', { style: S.hint },
            '节流规则：状态变化即报（最快每 10 秒一次），无变化每 10 分钟汇总一次，另有 30 秒心跳供手机判断在线/离线。结构化指令（start / stop / status / download）本地直接执行；自由文本只入队等待云端解析——本地永不调用模型。'),

          h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', { style: S.btnPrimary, disabled: busy === 'tick', onClick: onTick },
              busy === 'tick' ? '同步中…' : '立即同步'),
            h('button', { style: S.btn, disabled: busy === 'relay-stop' || relay?.paused, onClick: onRelayStop }, '暂停上行'),
            h('button', { style: S.btn, disabled: busy === 'relay-start' || !relay?.paused, onClick: onRelayStart }, '恢复上行'),
            h('button', { style: S.btn, disabled: busy === 'retry' || !relay?.ok, onClick: onRetryAll }, '重试队列')),

          (outbox?.entries ?? []).length > 0 ? h('div', { style: { ...S.hint, marginTop: 8, fontFamily: 'ui-monospace, monospace', fontSize: 11 } },
            ...outbox.entries.slice(0, 8).map((entry) => h('div', { key: entry.id, style: { marginBottom: 2 } },
              `${entry.state === 'parked' ? '⏸' : '⏳'} ${entry.type} ${String(entry.id).slice(0, 28)}…`
              + `　尝试 ${entry.attempts}`
              + (entry.nextAt ? `　下次 ${entry.nextAt}` : '')
              + (entry.lastError ? `　${entry.lastError}` : ''))))
          : null)


        /* ---- 任务监测（电脑上正在跑什么） ---- */
        , h('div', { style: S.card },
          h('div', { style: S.head },
            h('h3', { style: S.title }, '任务监测'),
            h('span', { style: { ...S.hint, marginLeft: 'auto', marginTop: 0 } },
              tasks?.ok ? `共 ${tasks.tasks?.total ?? 0} 个 · ${tasks.tasks?.updatedAt ?? ''}` : '未采集')),

          tasks?.ok ? h('div', { style: S.row },
            h(StatusLight, { state: (tasks.tasks?.running ?? 0) > 0 ? 'ok' : 'warn', label: `运行中 ${tasks.tasks?.running ?? 0}` }),
            h(StatusLight, { state: (tasks.tasks?.stalled ?? 0) > 0 ? 'bad' : 'ok', label: `疑似卡住 ${tasks.tasks?.stalled ?? 0}` }),
            h(StatusLight, { state: (tasks.tasks?.failed ?? 0) > 0 ? 'warn' : 'ok', label: `失败 ${tasks.tasks?.failed ?? 0}` }))
          : h('p', { style: S.hint }, tasks?.reason ?? '正在采集任务列表…'),

          tasks?.ok ? h('div', { style: { ...S.hint, fontFamily: C.mono, fontSize: 11, marginTop: 6 } },
            ...(tasks.tasks?.recent ?? []).map((job) => h('div', { key: job.id, style: { marginBottom: 3 } },
              `${job.stalled ? '⏸' : job.status === 'running' ? '▶' : job.exitCode === 0 ? '✔' : '✘'} `
              + `${job.name || job.id}`
              + `　${job.status === 'running' ? `已跑 ${job.ageSec}s · 日志静默 ${job.idleSec}s` : `退出 ${job.exitCode ?? '?'} · ${job.ageSec}s 前`}`,
              job.tail ? h('div', { style: { color: C.faint, paddingLeft: 14 } }, job.tail.replace(/\s+/g, ' ').slice(-160)) : null)))
            : null,

          h('p', { style: S.hint },
            '数据来自本机 bgjobs 任务（运行中优先排序）；「日志静默」超过阈值即标记疑似卡住。手机端发 tasks 指令可随时取同一份列表。'),

          h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', { style: S.btn, disabled: busy === 'tasks', onClick: onRefreshTasks },
              busy === 'tasks' ? '刷新中…' : '刷新任务列表')))
        /* ---- 手机指令流水（桌面端看见手机让我做了什么） ---- */
        , h('div', { style: S.card },
          h('div', { style: S.head },
            h('h3', { style: S.title }, '手机指令流水'),
            h('span', { style: { ...S.hint, marginLeft: 'auto', marginTop: 0 } },
              commands?.ok ? `最近 ${commands.total} 条` : '未读取')),

          commands?.ok && commands.entries.length === 0
            ? h('p', { style: S.hint }, '手机还没有发过指令。收到后这里会立刻出现。')
            : null,

          commands?.ok ? h('div', { style: { ...S.hint, fontFamily: C.mono, fontSize: 11, marginTop: 4 } },
            ...commands.entries.map((entry) => h('div', { key: `${entry.kind}-${entry.id}-${entry.ts}`, style: { marginBottom: 4 } },
              `${entry.ok ? '✔' : '✘'} ${entry.ts ? new Date(entry.ts).toLocaleString('zh-CN') : '—'}　${entry.id ?? ''}`,
              h('div', { style: { color: C.faint, paddingLeft: 14 } }, String(entry.detail ?? '').replace(/\s+/g, ' ').slice(0, 160)))))
            : null,

          h('p', { style: S.hint },
            '手机经邮箱发来的指令不会在 DSH 聊天会话里产生对话 —— 中转是插件自己的定时器在跑。想看它做了什么就在这里，或对 DSH 说 /hongyi commands。'),

          h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', { style: S.btn, disabled: busy === 'commands', onClick: onRefreshCommands },
              busy === 'commands' ? '读取中…' : '刷新指令流水')))
        /* ---- 文件传输（电脑 ⇄ 手机，分片走同一条信箱） ---- */
        , h('div', { style: S.card },
          h('div', { style: S.head },
            h('h3', { style: S.title }, '文件传输'),
            h('span', { style: { ...S.hint, marginLeft: 'auto', marginTop: 0 } },
              inbox?.ok ? `收件箱 ${inbox.files?.length ?? 0} 个` : '未读取')),

          h('p', { style: S.hint },
            '文件按 256KB 切片，每片一条 type=file 的签名信封，走同一条信箱通道；手机端收齐后按 sha256 校验再落盘。'),

          h(Field, { label: '发送文件', hint: '填电脑上的绝对路径，点「发送到手机」。大文件会自动切片，20MB 约 80 片。' },
            h('input', {
              style: S.input,
              value: String(d.sendPath ?? ''),
              placeholder: 'C:\\Users\\你\\Desktop\\报表.pdf',
              onChange: (e) => setDraft({ ...d, sendPath: e.target.value }),
            })),
          h('div', { style: { ...S.row, marginTop: 8 } },
            h('button', {
              style: S.btnPrimary,
              disabled: busy === 'send-file' || !String(d.sendPath ?? '').trim(),
              onClick: onSendFile,
            }, busy === 'send-file' ? '发送中…' : '发送到手机'),
            h('button', { style: S.btn, disabled: busy === 'inbox', onClick: () => onRefreshInbox() },
              busy === 'inbox' ? '读取中…' : '刷新收件箱')),

          inbox?.ok && (inbox.partial?.length ?? 0) > 0
            ? h('p', { style: { ...S.hint, color: C.warn } }, `还有 ${inbox.partial.length} 个文件正在接收（分片未齐）`)
            : null,

          inbox?.ok && (inbox.files?.length ?? 0) > 0
            ? h('div', { style: { ...S.hint, fontFamily: C.mono, fontSize: 11, marginTop: 8 } },
              ...(inbox.files ?? []).map((file) => h('div', { key: file.name, style: { marginBottom: 3 } },
                `📄 ${file.name}　${Math.max(1, Math.round((file.size ?? 0) / 1024))}KB　${file.mtime ? new Date(file.mtime).toLocaleString('zh-CN') : ''}`)))
            : h('p', { style: S.hint }, `收件箱：${inbox?.dir ?? '—'}（手机发来的文件会落在这里）`))




        , h('div', { style: S.card },
          h('div', {
            style: { ...S.head, cursor: 'pointer', marginBottom: showLink ? 10 : 0 },
            onClick: () => setShowLink((v) => !v),
            role: 'button', tabIndex: 0,
            onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setShowLink((v) => !v) },
          },
            h('span', { style: { fontSize: 11, color: C.faint } }, showLink ? '▾' : '▸'),
            h('h3', { style: S.title }, 'WorkBuddy 本地联动'),
            h('span', { style: { marginLeft: 'auto', fontSize: 11.5, color: C.faint } }, '本期仅占位')),
          showLink ? h('div', null,
            h('p', { style: S.hint },
              '数据面不依赖本机 WorkBuddy 常驻：插件凭 token 直连云端信箱。这里的本地联动只用于「首次授权、调试、本地重活」，Phase 3 才会接上 CDP → 无头 CLI → 文件影子 三级降级。'),
            h(Field, { label: 'CDP 端口', hint: 'WorkBuddy 桌面端调试端口，留空表示不启用。' },
              h('input', {
                style: S.input, value: String(config.link.cdpPort ?? ''), placeholder: '例如 9222',
                onChange: (e) => setDraft({ ...d, link: { ...(d.link ?? config.link), cdpPort: Number(e.target.value) || 0 } }),
              })),
            h(Field, { label: 'CLI 路径', hint: 'WorkBuddy 命令行可执行文件的绝对路径。' },
              h('input', {
                style: S.input, value: (d.link ?? config.link).cliPath ?? '', placeholder: 'C:\\…\\WorkBuddy.exe',
                onChange: (e) => setDraft({ ...d, link: { ...(d.link ?? config.link), cliPath: e.target.value } }),
              })),
            h('p', { style: S.hint }, '本机 WorkBuddy 的登录凭据不属于本插件：鸿驿从不读取、复制或上传它。'))
          : null)

        /* ---- 输出 ---- */
        , error ? h('div', { style: { ...S.log, borderColor: C.bad, color: C.bad } }, `✘ ${error}`) : null
        , log ? h('div', { style: S.log }, log) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        if (slots === undefined || typeof slots.inject !== 'function') {
          console.warn('[dsh-hongyi] 宿主没有 slots 服务：设置卡片未注册')
          return undefined
        }
        // `inject` waits for the slot to exist and returns a disposer; returning it
        // lets Cordis release the registration when this plugin unloads.
        // 不要 return 这次 inject：它返回的是 Cordis fiber（thenable），
        // apply 返回 thenable 时宿主会 await 它，而 settings.section 槽位要到
        // 设置界面挂载后才可用 —— 启动阶段永远等不到，web boot 就卡死。
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'hongyi',
          order: 36,
          label: () => '鸿驿',
        }, HongyiCard))
      },
    }
  },
})
