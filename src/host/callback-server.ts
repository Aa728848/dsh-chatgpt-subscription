import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
  OAUTH_CALLBACK_HOST,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORT,
} from '../compat.ts'

export interface CallbackServerOptions {
  expectedState: string
  exchange: (code: string, signal: AbortSignal) => Promise<void>
}

/** One-shot localhost OAuth callback listener. */
export class OAuthCallbackServer {
  private readonly abortController = new AbortController()
  private server: http.Server | null = null
  private settled = false
  private resolveCompletion!: () => void
  private rejectCompletion!: (error: Error) => void
  readonly completion = new Promise<void>((resolve, reject) => {
    this.resolveCompletion = resolve
    this.rejectCompletion = reject
  })

  constructor(private readonly options: CallbackServerOptions) {}

  async listen(): Promise<void> {
    if (this.server !== null) throw new Error('OAuth callback server already started')
    const server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    }).catch((error: unknown) => {
      this.server = null
      server.close()
      throw error
    })
  }

  cancel(reason: Error): void {
    this.finish(reason)
  }

  dispose(): void {
    if (!this.settled) this.finish(new Error('OAuth callback listener disposed'))
    else this.close()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.settled) {
      await writeHtml(response, 410, 'This sign-in attempt is no longer active.')
      return
    }
    if (!isLoopback(request.socket.remoteAddress)) {
      await writeHtml(response, 403, 'OAuth callback rejected.')
      return
    }
    const url = new URL(request.url ?? '/', `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}`)
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      await writeHtml(response, 404, 'Not found.')
      return
    }
    const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (providerError !== null || code === null || code === '' || state !== this.options.expectedState) {
      await writeHtml(response, 400, 'ChatGPT returned an invalid OAuth callback.')
      this.finish(new Error(providerError === null ? 'invalid OAuth callback' : 'OAuth provider rejected sign-in'))
      return
    }
    try {
      await this.options.exchange(code, this.abortController.signal)
      await writeHtml(response, 200, 'ChatGPT sign-in completed. You can close this window.')
      this.finish()
    } catch (error) {
      await writeHtml(response, 500, 'ChatGPT sign-in could not be completed. Return to DSH for details.')
      this.finish(error instanceof Error ? error : new Error('OAuth token exchange failed'))
    }
  }

  private finish(error?: Error): void {
    if (this.settled) return
    this.settled = true
    this.abortController.abort()
    this.close()
    if (error === undefined) this.resolveCompletion()
    else this.rejectCompletion(error)
  }

  private close(): void {
    const server = this.server
    this.server = null
    server?.close()
    server?.closeAllConnections()
  }
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function writeHtml(response: ServerResponse, status: number, message: string): Promise<void> {
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  })
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    response.once('finish', done)
    response.once('close', done)
    response.end(`<!doctype html><meta charset="utf-8"><title>DSH Codex sign-in</title><h1>${escaped}</h1>`)
  })
}
