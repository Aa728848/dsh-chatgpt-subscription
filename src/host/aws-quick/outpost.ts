import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import type { AwsQuickAccountProvider, AwsQuickAuthDto, AwsQuickLoginDto } from '../../shared/aws-quick-contracts.ts'
import type { AwsQuickSettingsStore } from './settings.ts'
import { resolveQuickAgent } from './binary.ts'
import { isQuickChatHost } from './protocol.ts'

export interface QuickSession {
  jwt: string
  actorArn?: string
  wsHost: string
  tenantUrl: string
  wsPath?: string
  surface: string
  provider: string
  accountId?: string
  accountName?: string
  region?: string
  usableUntil?: number
  appVersion?: string
}
interface QuickAgentProcess {
  child: ChildProcess
  token: string
  port: number
  version?: string
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/** Resolve the same active-profile QUICKWORK_ROOT that Quick Desktop uses. */
export async function activeQuickProfileRoot(base=path.join(os.homedir(),'.quickwork')):Promise<string>{
 try{
  const manifest=JSON.parse(await fs.readFile(path.join(base,'profiles.json'),'utf8')) as {last_active?:string;entries?:Array<{id?:string;data_path?:string}>}
  const entry=manifest.entries?.find((candidate)=>candidate.id===manifest.last_active)
  if(typeof entry?.data_path!=='string'||!entry.data_path||path.isAbsolute(entry.data_path))return base
  const resolved=path.resolve(base,entry.data_path)
  return resolved===base||resolved.startsWith(base+path.sep)?resolved:base
 }catch{return base}
}
export class AwsQuickOutpost {
  private agent: QuickAgentProcess | null = null
  private starting: Promise<QuickAgentProcess> | null = null
  private sessionCache: { value: QuickSession; at: number } | null = null
  private sessionInFlight: Promise<QuickSession> | null = null
  private loginState: AwsQuickLoginDto = { state: 'idle' }
  private disposed = false
  private account: Partial<AwsQuickAuthDto> = {}
  constructor(private readonly settings: AwsQuickSettingsStore) {}
  loginStatus(): AwsQuickLoginDto { return this.loginState }
  cachedAuth(): AwsQuickAuthDto { return { ...this.account, authenticated: this.account.authenticated === true } }
  private async request<T>(agent: QuickAgentProcess, route: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${agent.port}${route}`, {
      ...init,
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${agent.token}`, ...(init.headers ?? {}) },
    })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const error = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : `HTTP ${response.status}`
      const failure = new Error(error) as Error & { status?: number; code?: string }
      failure.status = response.status
      failure.code = typeof body.error === 'string' ? body.error : undefined
      throw failure
    }
    return body as T
  }
  private async launch(): Promise<QuickAgentProcess> {
    const settings = await this.settings.read()
    const resolved = await resolveQuickAgent(settings.binaryPath)
    if (!resolved.path) throw new Error(resolved.error ?? 'AWS Quick agent was not found.')
    const port = await freePort()
    const token = randomBytes(32).toString('hex')
    // Reuse Quick Desktop's profile and OS credential vault through the official agent.
    // The plugin never reads those credentials itself and no second account is created.
    const dataDir = path.join(os.homedir(), '.quickwork')
    const activeRoot = await activeQuickProfileRoot(dataDir)
    const child = spawn(resolved.path, ['--outpost-only', '--manifest', 'desktop', '--port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        QUICKWORK_CLOUD_MODE: '1',
        QUICKWORK_OUTPOST_PORT: String(port),
        QUICKWORK_BASE: dataDir,
        QUICKWORK_USER_DATA_DIR: dataDir,
        QUICKWORK_ROOT: activeRoot,
        QUICKWORK_RESOURCES_PATH: path.dirname(path.dirname(resolved.path)),
        QUICKWORK_NODE_PATH: process.execPath,
        ...(resolved.version ? { APP_VERSION: resolved.version } : {}),
        QUICKWORK_BUILD_STAGE: 'prod',
        QUICKWORK_PROFILE_STAGE: 'prod',
        APP_CHANNEL: 'prod',
        PYTHONUTF8: '1',
      },
      windowsHide: true,
    })
    const agent: QuickAgentProcess = { child, token, port, ...(resolved.version?{version:resolved.version}:{}) }
    child.stdin?.write(`${token}\n`)
    child.stdin?.end()
    const announced = new Promise<void>((resolveAnnounce, reject) => {
      let stdout = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = () => { if (timer) clearTimeout(timer); child.off('close', onClose); child.off('error', onError) }
      const onClose = (code: number | null) => { done(); reject(new Error(`AWS Quick outpost exited before readiness (code ${String(code)}).`)) }
      const onError = (error: Error) => { done(); reject(error) }
      child.on('close', onClose)
      child.on('error', onError)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (/^OUTPOST_PORT:\s*\d+/m.test(stdout)) { done(); resolveAnnounce() }
      })
      // Never forward OUTPOST_TOKEN or raw stderr: either may contain authentication material.
      child.stderr?.resume()
      timer = setTimeout(() => { done(); reject(new Error('AWS Quick outpost did not become ready within 90 seconds.')) }, 90_000)
    })
    await announced.catch((error) => { child.kill(); throw error })
    const deadline = Date.now() + 15_000
    while (true) {
      try { await this.request(agent, '/health', { signal: AbortSignal.timeout(2_000) }); break } catch (error) {
        if (Date.now() >= deadline) { child.kill(); throw error }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    return agent
  }
  async ensureStarted(): Promise<QuickAgentProcess> {
    if (this.disposed) throw new Error('AWS Quick outpost is disposed.')
    if (this.agent && this.agent.child.exitCode === null && !this.agent.child.killed) return this.agent
    if (this.starting) return this.starting
    this.starting = this.launch().then((agent) => { this.agent = agent; return agent }).finally(() => { this.starting = null })
    return this.starting
  }
  private async fetchSession(fresh: boolean): Promise<QuickSession> {
    if (!fresh && this.sessionCache && Date.now() - this.sessionCache.at < 30_000) return this.sessionCache.value
    if (this.sessionInFlight) return this.sessionInFlight
    this.sessionInFlight = (async () => {
      const agent = await this.ensureStarted()
      const body = await this.request<Record<string, unknown>>(agent, '/auth/sncs-session')
      const jwt = typeof body.id_token === 'string' ? body.id_token : ''
      const wsHost = typeof body.ws_host === 'string' ? body.ws_host : ''
      if (!jwt || !wsHost) throw new Error('AWS Quick returned an incomplete chat session.')
      const value: QuickSession = {
        jwt, wsHost,
        tenantUrl: typeof body.tenant_url === 'string' ? body.tenant_url : `https://${wsHost}`,
        ...(typeof body.actor_arn === 'string' ? { actorArn: body.actor_arn } : {}),
        ...(typeof body.ws_path === 'string' ? { wsPath: body.ws_path } : {}),
        surface: process.platform === 'win32' ? 'QUICK_WORK_DESKTOP_WINDOWS' : 'QUICK_WORK_DESKTOP_MAC',
        provider: typeof body.provider === 'string' ? body.provider : 'social',
        ...(typeof body.aws_account_id === 'string' ? { accountId: body.aws_account_id } : {}),
        ...(typeof body.account_name === 'string' ? { accountName: body.account_name } : {}),
        ...(typeof body.region === 'string' ? { region: body.region } : {}),
        ...(typeof body.usable_until === 'number' ? { usableUntil: body.usable_until } : {}),
        ...(agent.version?{appVersion:agent.version}:{})
      }
      this.sessionCache = { value, at: Date.now() }
      this.account = { ...this.account, authenticated: true, provider: value.provider, accountName: value.accountName, region: value.region }
      return value
    })().finally(() => { this.sessionInFlight = null })
    return this.sessionInFlight
  }
  session(fresh = false): Promise<QuickSession> { return this.fetchSession(fresh) }
  async mcp<T>(action:string,body:Record<string,unknown>={}):Promise<T>{
    const agent=await this.ensureStarted()
    const read=action==='list'||action==='known-sources'
    return this.request<T>(agent,`/local/mcp/${action}`,{method:read?'GET':'POST',...(read?{}:{body:JSON.stringify(body)})})
  }
  async invokeAgentCapabilities(session:QuickSession,workingSessionId:string,outpostId:string):Promise<void>{
    const base=new URL(session.tenantUrl)
    if(base.protocol!=='https:'||!isQuickChatHost(base.hostname))throw new Error('Refusing untrusted AWS Quick tenant host.')
    const response=await fetch(new URL('/integration/quick-work/qbs-event',base),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.jwt}`,'x-amzn-qs-internal-trace-id':crypto.randomUUID()},body:JSON.stringify({eventType:'invokeAgent',eventBody:{invokeAgent:{path:'api/capabilities',queryParams:{_method:'GET'},body:{},workingSessionId,outpostId}}}),signal:AbortSignal.timeout(30_000)})
    if(!response.ok)throw new Error(`AWS Quick capabilities initialization failed (HTTP ${response.status}).`)
    const raw=await response.json() as Record<string,unknown>
    const envelope=raw.eventResponse&&typeof raw.eventResponse==='object'?(raw.eventResponse as Record<string,unknown>).invokeAgentResponse:raw
    const parsed=typeof envelope==='string'?JSON.parse(envelope) as Record<string,unknown>:envelope as Record<string,unknown>
    if(parsed?.type==='api_response'&&typeof parsed.status==='number'&&(parsed.status<200||parsed.status>=300))throw new Error(`AWS Quick capabilities initialization failed (status ${parsed.status}).`)
  }
  async deviceTools():Promise<Record<string,unknown>>{
    const agent=await this.ensureStarted()
    return this.request<Record<string,unknown>>(agent,'/local/device-tools')
  }
  async localTools():Promise<Record<string,unknown>>{
    const agent=await this.ensureStarted()
    return this.request<Record<string,unknown>>(agent,'/local/list_tools')
  }
  async outpostId():Promise<string>{
    const agent=await this.ensureStarted()
    const body=await this.request<Record<string,unknown>>(agent,'/local/outpost-id')
    const id=body.outpost_id??body.outpostId??body.id
    if(typeof id!=='string'||!id)throw new Error('AWS Quick outpost returned no registered outpost id.')
    return id
  }
  async auth(force = false): Promise<AwsQuickAuthDto> {
    try {
      const session = await this.fetchSession(force)
      return { ...this.account, authenticated: true, provider: session.provider, accountName: session.accountName ?? this.account.accountName, region: session.region ?? this.account.region }
    } catch (error) {
      const failure = error as Error & { code?: string; status?: number }
      if (failure.code === 'refresh_unavailable') return { ...this.account, authenticated: false, error: 'Quick session refresh is temporarily unavailable.' }
      return { authenticated: false, ...(this.loginState.state === 'error' ? { error: this.loginState.error } : {}) }
    }
  }
  async login(): Promise<AwsQuickLoginDto> {
    if (this.loginState.state === 'pending') return this.loginState
    this.loginState = { state: 'pending' }
    try {
      const settings = await this.settings.read()
      const agent = await this.ensureStarted()
      const provider: AwsQuickAccountProvider = settings.accountProvider
      const body = await this.request<Record<string, unknown>>(agent, '/auth/profile-login', {
        method: 'POST',
        body: JSON.stringify({ provider, ...(provider === 'enterprise' && settings.region ? { login_metadata: { region: settings.region } } : {}) }),
      })
      if (body.success !== true) throw new Error(typeof body.error === 'string' ? body.error : 'AWS Quick sign-in did not complete.')
      const metadata = typeof body.login_metadata === 'object' && body.login_metadata ? body.login_metadata as Record<string, unknown> : {}
      this.account = {
        authenticated: true,
        provider: typeof body.provider_type === 'string' ? body.provider_type : provider,
        accountName: typeof body.display_name === 'string' ? body.display_name : typeof metadata.display_name === 'string' ? metadata.display_name : undefined,
        email: typeof metadata.email === 'string' ? metadata.email : undefined,
        region: typeof metadata.region === 'string' ? metadata.region : settings.region ?? undefined,
      }
      this.sessionCache = null
      this.loginState = { state: 'complete' }
    } catch (error) {
      this.loginState = { state: 'error', error: errorText(error) }
    }
    return this.loginState
  }
  async cancelLogin(): Promise<void> {
    const agent = await this.ensureStarted()
    await this.request(agent, '/auth/profile-login-cancel', { method: 'POST', body: '{}' }).catch(() => undefined)
    if (this.loginState.state === 'pending') this.loginState = { state: 'idle' }
  }
  async logout(): Promise<void> {
    const agent = await this.ensureStarted()
    await this.request(agent, '/auth/logout', { method: 'POST', body: '{}' })
    this.sessionCache = null
    this.account = {}
    this.loginState = { state: 'idle' }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.starting) await this.starting.then((agent) => { if (agent.child.exitCode === null) agent.child.kill() }).catch(() => undefined)
    const current = this.agent
    this.agent = null
    this.sessionCache = null
    if (current && current.child.exitCode === null) {
      current.child.kill()
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2_000); current.child.once('close', () => { clearTimeout(timer); resolve() }) })
    }
  }
}
