/**
 * 宿主对浏览器暴露的只读 HTTP 路由。
 *
 * 这是**唯一**能把进展送到浏览器的通道：浏览器半边是另一个运行时（独立 bundle，
 * 跑在用户浏览器里），拿不到宿主进程的任何对象或 globalThis 状态，因此只能走
 * 同源 HTTP。
 *
 * 路径固定在 `/api/dsh-progress-updates/updates`：客户端半边的取数常量就是从
 * 这个形状写死的，搬家时不能顺手改名，否则面板读到的是 404。
 *
 * @module dsh-chatgpt-subscription/host/progress-updates/routes
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ProgressUpdate } from './store.ts'

/** 本路由族的前缀。 */
export const PROGRESS_API_PREFIX = '/api/dsh-progress-updates'

/** 进展读取路由的完整路径。 */
export const PROGRESS_UPDATES_PATH = PROGRESS_API_PREFIX + '/updates'

/** 路由默认的 JSON 响应头。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

/**
 * 断言本次请求来自本机。
 *
 * 进展内容会包含用户在会话里做的事，属于个人数据，所以只有 loopback（桌面端
 * 自己）能读：socket 地址是权威判断，Host 头必须也是 loopback 权威（挡住 DNS
 * 重绑定），`X-Forwarded-For` 永远不信任。
 * @param request - 进来的 HTTP 请求。
 * @returns 是否放行。
 */
function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostname: string
  try {
    hostname = new URL('http://' + host).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  return request.headers['sec-fetch-site'] !== 'cross-site'
}

/** socket 远端地址是否落在 loopback 范围（127/8、::1、IPv4-mapped）。 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** IPv4 127/8 判定（四段十进制，首段为 127）。 */
function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 主机名是否指向 loopback 权威（localhost、[::1]、127/8）。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 写一个 JSON 响应。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 要序列化的值。
 * @param headers - 追加或覆盖的头。
 */
function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

/**
 * 一条会话进展的读取面：路由只读它，不关心它怎么被写。
 */
export interface ProgressUpdatesReader {
  /**
   * 读取一个会话当前的进展列表。
   * @param sessionId - 会话 id；调用方可用空串表示"当前/默认"。
   * @returns 该会话的进展（按时间顺序，最多 MAX_UPDATES 条）。
   */
  updatesOf(sessionId: string): readonly ProgressUpdate[]
}

/**
 * 进展读取路由：`GET /api/dsh-progress-updates/updates?session=<id>`。
 *
 * 返回 `{ updates: ProgressUpdate[] }`。响应带 no-store：这个列表随 agent 干活
 * 实时变化，缓存住就等于展示过期进展。
 * @param reader - 进展读取面。
 * @returns 可注册的 route。
 */
export function makeProgressUpdatesRoute(reader: ProgressUpdatesReader): WebRoute {
  return {
    kind: 'exact',
    path: PROGRESS_UPDATES_PATH,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const session = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('session') ?? ''
      writeJson(res, 200, { updates: reader.updatesOf(session) }, { 'cache-control': 'no-store' })
    },
  }
}
