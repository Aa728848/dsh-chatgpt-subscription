import { useEffect, useRef, useState } from 'react'
import type { MultiProviderStatusDto, ProviderAuthorizationDto, ProviderStatusDto } from '../shared/contracts.ts'
import { SubscriptionApi } from './api.ts'

const api = new SubscriptionApi()

export function ProviderSubscriptionsSection({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const [status, setStatus] = useState<MultiProviderStatusDto | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('')
  const [pending, setPending] = useState<Record<string, ProviderAuthorizationDto>>({})
  const [codes, setCodes] = useState<Record<string, string>>({})
  const loginPopups = useRef<Record<string, Window | null>>({})

  const load = async (): Promise<void> => {
    setStatus(await api.providers())
  }

  useEffect(() => { void load().catch((error: unknown) => setMessage(errorMessage(error))) }, [])

  const run = async (key: string, action: () => Promise<{ snapshot: MultiProviderStatusDto }>): Promise<void> => {
    setBusy(key)
    setMessage('')
    try {
      const result = await action()
      setStatus(result.snapshot)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const login = async (providerId: string): Promise<void> => {
    // Synchronously open a popup during user gesture for providers that need a browser OAuth URL
    let popup: Window | null = null
    // Antigravity delegates browser launch to the official agy process. Opening
    // another window here creates a blank/short-lived duplicate.
    if (providerId !== 'antigravity') {
      try {
        popup = window.open('about:blank', `dsh-provider-oauth-${providerId}`, 'popup,width=580,height=760')
      } catch {
        popup = null
      }
    }
    loginPopups.current[providerId] = popup

    setBusy(`${providerId}:login`)
    setMessage('')
    try {
      const response = await api.startProviderLogin(providerId)
      setStatus(response.snapshot)
      const auth = response.result
      setPending((value) => ({ ...value, [providerId]: auth }))

      if (auth.authorizationUrl) {
        if (popup && !popup.closed) {
          try {
            popup.location.replace(auth.authorizationUrl)
          } catch {
            // If popup navigation fails, user can click the action button
          }
        }
      } else if (auth.status !== 'pending') {
        popup?.close()
        loginPopups.current[providerId] = null
      }

      if (auth.status === 'completed') {
        setMessage(`${providerId} 登录完成`)
      } else if (auth.instructions) {
        setMessage(auth.instructions)
      }
    } catch (error) {
      popup?.close()
      loginPopups.current[providerId] = null
      setMessage(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  // Auto poll for pending authorization sessions (except those requiring manual code input)
  useEffect(() => {
    const activePolls = Object.entries(pending).filter(([_, auth]) => (
      auth.sessionId && auth.status === 'pending' && !auth.authorizationCodeRequired && !auth.inputRequired
    ))
    if (activePolls.length === 0) return
    const timer = setInterval(() => {
      for (const [providerId, auth] of activePolls) {
        if (!auth.sessionId) continue
        void api.pollProviderLogin(providerId, auth.sessionId).then((response) => {
          setStatus(response.snapshot)
          setPending((value) => ({ ...value, [providerId]: response.result }))
          const popup = loginPopups.current[providerId]
          if (response.result.authorizationUrl && popup && !popup.closed) {
            try { popup.location.replace(response.result.authorizationUrl) } catch { /* fallback link remains visible */ }
          }
          if (response.result.status === 'completed') {
            popup?.close()
            loginPopups.current[providerId] = null
            setMessage(`${providerId} 登录成功！已自动连接。`)
          }
        }).catch(() => undefined)
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [pending])

  const poll = async (providerId: string): Promise<void> => {
    const auth = pending[providerId]
    if (!auth?.sessionId) return
    setBusy(`${providerId}:poll`)
    try {
      const response = await api.pollProviderLogin(providerId, auth.sessionId)
      setStatus(response.snapshot)
      setPending((value) => ({ ...value, [providerId]: response.result }))
      setMessage(response.result.status === 'completed' ? '登录完成。' : (response.result.instructions ?? '授权仍在进行。'))
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const submitCode = async (providerId: string): Promise<void> => {
    const auth = pending[providerId]
    const code = codes[providerId]?.trim()
    if (!auth?.sessionId || !code) return
    setBusy(`${providerId}:code`)
    try {
      const response = await api.submitProviderCode(providerId, auth.sessionId, code)
      setStatus(response.snapshot)
      setPending((value) => ({ ...value, [providerId]: response.result }))
      setMessage(response.result.status === 'completed' ? '登录完成。' : (response.result.instructions ?? '授权码已提交。'))
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  return <section className={`dcs-provider-section${embedded ? ' dcs-provider-embedded' : ''}`}>
    <header className="dcs-provider-header">
      <div>
        <h2>{embedded ? '其他订阅 Provider' : '订阅 Provider'}</h2>
        <p>Claude、Grok、Cursor 与 Antigravity 的 OAuth/官方会话。凭据仅保存在 Host。</p>
      </div>
      <button type="button" disabled={busy !== null} onClick={() => void run('scan', () => api.scanProvider())}>扫描官方会话</button>
    </header>
    {message && <p role="status" className="dcs-provider-message">{message}</p>}
    <div className="dcs-provider-grid">
      {(status?.providers ?? []).map((provider) => <ProviderCard
        key={provider.providerId}
        provider={provider}
        busy={busy}
        pending={pending[provider.providerId]}
        code={codes[provider.providerId] ?? ''}
        onCode={(code) => setCodes((value) => ({ ...value, [provider.providerId]: code }))}
        onLogin={() => void login(provider.providerId)}
        onPoll={() => void poll(provider.providerId)}
        onSubmit={() => void submitCode(provider.providerId)}
        onRefresh={() => void run(`${provider.providerId}:refresh`, () => api.refreshProvider(provider.providerId))}
        onImport={(candidateId) => void run(`${provider.providerId}:import`, () => api.importProviderCandidate(provider.providerId, candidateId))}
        onRemove={(accountId) => void run(`${provider.providerId}:remove`, () => api.removeProviderAccount(provider.providerId, accountId))}
        onCopyUrl={async (url) => {
          try {
            await navigator.clipboard.writeText(url)
            setMessage('授权链接已复制到剪贴板，请粘贴到浏览器中打开。')
          } catch {
            setMessage(`授权链接：${url}`)
          }
        }}
      />)}
    </div>
    {status && <p className="dcs-provider-storage">凭据存储：{status.storage.kind} · {status.storage.encrypted ? '已加密' : '所有者权限保护'}</p>}
  </section>
}

interface ProviderCardProps {
  provider: ProviderStatusDto
  busy: string | null
  pending?: ProviderAuthorizationDto
  code: string
  onCode: (value: string) => void
  onLogin: () => void
  onPoll: () => void
  onSubmit: () => void
  onRefresh: () => void
  onImport: (candidateId: string) => void
  onRemove: (accountId: string) => void
  onCopyUrl?: (url: string) => void | Promise<void>
}

function ProviderCard(props: ProviderCardProps): React.JSX.Element {
  const { provider, busy, pending } = props
  return <article className="dcs-provider-card">
    <div className="dcs-provider-card-head">
      <div><strong>{provider.displayName}</strong><small>{provider.providerId}</small></div>
      <span data-live={provider.accounts.length > 0}>{provider.accounts.length > 0 ? '已连接' : '未登录'}</span>
    </div>
    <div className="dcs-provider-actions">
      <button type="button" disabled={busy !== null} onClick={props.onLogin}>登录添加账号</button>
      <button type="button" disabled={busy !== null} onClick={props.onRefresh}>刷新</button>
    </div>
    {pending?.instructions && <p className="dcs-provider-instructions">{pending.instructions}</p>}
    {pending?.authorizationUrl && pending.status !== 'completed' && <div className="dcs-provider-auth-link">
      <button
        type="button"
        className="dcs-provider-copy-btn"
        onClick={() => void props.onCopyUrl?.(pending.authorizationUrl!)}
        title="复制完整授权链接以手动粘贴到任意浏览器"
      >
        📋 复制授权链接
      </button>
    </div>}
    {pending?.sessionId && pending.status !== 'completed' && <div className="dcs-provider-auth-actions">
      {(pending.inputRequired || pending.authorizationCodeRequired) ? <>
        <input value={props.code} onChange={(event) => props.onCode(event.target.value)} placeholder="粘贴网页返回的授权码 (code#state)" />
        <button type="button" disabled={busy !== null || props.code.trim() === ''} onClick={props.onSubmit}>提交授权码</button>
      </> : <button type="button" disabled={busy !== null} onClick={props.onPoll}>检查登录状态</button>}
    </div>}
    {(provider.candidates ?? []).filter((candidate) => !candidate.imported).map((candidate) => <div className="dcs-provider-account" key={candidate.candidateId}>
      <div><strong>{candidate.displayName ?? candidate.email ?? candidate.accountId ?? '发现的官方会话'}</strong><small>{candidate.source ?? candidate.candidateId}</small></div>
      <button type="button" disabled={busy !== null} onClick={() => props.onImport(candidate.candidateId)}>导入</button>
    </div>)}
    {provider.accounts.length === 0
      ? <p className="dcs-provider-empty">尚未导入账号。可先扫描本机官方会话，或直接发起浏览器 OAuth。</p>
      : provider.accounts.map((account) => <div className="dcs-provider-account" key={account.accountId}>
        <div><strong>{account.displayName ?? account.email ?? account.accountId}</strong><small>{account.email ?? account.accountId}</small></div>
        <button type="button" disabled={busy !== null} onClick={() => props.onRemove(account.accountId)}>移除</button>
      </div>)}
  </article>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败。'
}
