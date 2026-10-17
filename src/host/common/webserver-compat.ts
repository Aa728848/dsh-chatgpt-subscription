export interface WebServerOriginSource {
  readonly host: string
  readonly port: number | undefined
  getOrigin?(): string
}

export function webServerOrigin(server: WebServerOriginSource): string {
  if (typeof server.getOrigin === 'function') return server.getOrigin()
  if (server.port === undefined) {
    throw new Error('dsh-chatgpt-subscription: web server origin requested before the listener bound a port')
  }
  const host = server.host === '0.0.0.0' ? '127.0.0.1' : server.host
  return `http://${host}:${server.port}`
}
