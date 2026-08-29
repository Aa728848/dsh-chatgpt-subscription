import { WebError, type WebFetchProvider, type WebFetchRequest, type WebFetchResult } from '@deepseek-ai/dsh-web'
import { CODEX_FETCH_PROVIDER_ID } from '../compat.ts'

type FetchLike = typeof fetch

export interface CodexFetchProviderOptions {
  fetchFn?: FetchLike
  maxResponseBytes?: number
  maxBodyChars?: number
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 // 2MB
const DEFAULT_MAX_BODY_CHARS = 100_000

export function createCodexFetchProvider(
  options: CodexFetchProviderOptions = {},
): WebFetchProvider {
  const fetchFn = options.fetchFn ?? fetch
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS

  return {
    id: CODEX_FETCH_PROVIDER_ID,
    available: () => true,
    async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
      const targetUrl = request.url.trim()
      let parsedUrl: URL
      try {
        parsedUrl = new URL(targetUrl)
      } catch (error) {
        throw new WebError(`invalid URL: ${targetUrl}`, 'WEB_INVALID_URL', { cause: error })
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new WebError(`unsupported URL scheme "${parsedUrl.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
      }

      let response: Response
      try {
        response = await fetchFn(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          },
          redirect: 'follow',
          signal,
        })
      } catch (error) {
        if (signal?.aborted) {
          throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
        }
        throw new WebError(`web fetch failed: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      const contentType = response.headers.get('content-type') || ''
      const mime = contentType.replace(/;.*$/s, '').trim().toLowerCase()
      const kind: 'html' | 'text' = (mime === 'text/html' || mime === 'application/xhtml+xml') ? 'html' : 'text'

      let charset = 'utf-8'
      const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType)
      if (match?.[1]) {
        charset = match[1].trim().toLowerCase()
      }

      let decoder: InstanceType<typeof TextDecoder>
      try {
        decoder = new TextDecoder(charset)
      } catch {
        decoder = new TextDecoder('utf-8')
      }

      let rawBytes: Uint8Array
      let truncatedByBytes = false
      try {
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > maxResponseBytes) {
          rawBytes = new Uint8Array(buffer.slice(0, maxResponseBytes))
          truncatedByBytes = true
        } else {
          rawBytes = new Uint8Array(buffer)
        }
      } catch (error) {
        throw new WebError(`failed to read response body: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      const decodedText = decoder.decode(rawBytes)
      const truncatedByChars = decodedText.length > maxBodyChars
      const finalContent = truncatedByChars ? decodedText.slice(0, maxBodyChars) : decodedText

      return {
        url: response.url || targetUrl,
        statusCode: response.status,
        body: {
          kind,
          content: finalContent,
        },
        truncated: truncatedByBytes || truncatedByChars,
      }
    },
  }
}
