// @vitest-environment node
/**
 * Tests for the Matrix media gateway client.
 *
 * Every request here is a mock: this file must never reach MiniMax. What it
 * pins is the CONTRACT - the endpoint the gateway lives at, the four headers a
 * media call carries, and the two failure kinds (a business refusal inside an
 * HTTP 200, and a non-2xx answer classified by the line's existing verdict).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MATRIX_TOOL_VIDEOS_UNDERSTAND,
  MatrixToolError,
  callMatrixTool,
  matrixPayloadField,
  matrixRequestHeaders,
  matrixToolUrl,
} from '../src/host/minimax-code/matrix-client.ts'

/** One recorded fetch call. */
interface Recorded {
  url: string
  init: RequestInit | undefined
}

/** A fetch that answers one status and one body, and records what it was asked. */
function mockFetch(status: number, body: string): { fetchFn: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const OK_ENVELOPE = JSON.stringify({
  base_resp: { status_code: 0, status_msg: 'success' },
  content: 'a cat walks across a kitchen counter',
})

describe('matrixToolUrl', () => {
  it('builds the cn agent endpoint from the measured host', () => {
    expect(matrixToolUrl('cn', MATRIX_TOOL_VIDEOS_UNDERSTAND))
      .toBe('https://agent.minimax.cn/mavis/api/v1/mcp/videos_understand')
  })

  it('builds the global agent endpoint from the io host', () => {
    expect(matrixToolUrl('global', MATRIX_TOOL_VIDEOS_UNDERSTAND))
      .toBe('https://agent.minimax.io/mavis/api/v1/mcp/videos_understand')
  })

  it('never uses the check-in surface host', () => {
    // agent.minimaxi.com serves the check-in line, not the Matrix gateway: the
    // upstream tree spells it LEGACY. Sending a media call there would miss.
    for (const region of ['cn', 'global'] as const) {
      expect(matrixToolUrl(region, MATRIX_TOOL_VIDEOS_UNDERSTAND)).not.toContain('minimaxi.com')
    }
  })

  it('tolerates a leading slash on the tool segment', () => {
    expect(matrixToolUrl('cn', '/videos_understand'))
      .toBe('https://agent.minimax.cn/mavis/api/v1/mcp/videos_understand')
  })
})

describe('matrixRequestHeaders', () => {
  it('sends exactly four headers', () => {
    expect(Object.keys(matrixRequestHeaders('tok-123')).sort())
      .toEqual(['accept', 'authorization', 'content-type', 'user-agent'])
  })

  it('carries the bearer token and the measured values', () => {
    expect(matrixRequestHeaders('tok-123')).toEqual({
      accept: 'application/json',
      authorization: 'Bearer tok-123',
      'content-type': 'application/json',
      'user-agent': 'MiniMaxAgent',
    })
  })

  it('sends none of the check-in surface signature or routing headers', () => {
    const headers = matrixRequestHeaders('tok-123')
    for (const forbidden of ['yy', 'x-timestamp', 'x-signature', 'user_id', 'biz_id', 'request_sk']) {
      expect(headers).not.toHaveProperty(forbidden)
    }
  })

  it('sends no credential header other than authorization', () => {
    expect(matrixRequestHeaders('tok-123')).not.toHaveProperty('x-api-key')
  })
})

describe('callMatrixTool', () => {
  it('returns the parsed envelope on HTTP 200 with base_resp.status_code 0', async () => {
    const { fetchFn, calls } = mockFetch(200, OK_ENVELOPE)
    const response = await callMatrixTool({
      region: 'cn',
      accessToken: 'tok-123',
      tool: MATRIX_TOOL_VIDEOS_UNDERSTAND,
      body: { video_info: [{ url: 'https://example.com/a.mp4', mime_type: 'video/mp4' }] },
      fetchFn,
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ content: 'a cat walks across a kitchen counter' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://agent.minimax.cn/mavis/api/v1/mcp/videos_understand')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      video_info: [{ url: 'https://example.com/a.mp4', mime_type: 'video/mp4' }],
    })
  })

  it('sends the four headers on the wire', async () => {
    const { fetchFn, calls } = mockFetch(200, OK_ENVELOPE)
    await callMatrixTool({
      region: 'cn', accessToken: 'tok-123', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization', 'content-type', 'user-agent'])
  })

  it('treats an envelope with no base_resp as a success', async () => {
    // "The wrapper said nothing" is not a refusal: a tool that answers a bare
    // payload is still answering.
    const { fetchFn } = mockFetch(200, JSON.stringify({ task_id: 't-1' }))
    const response = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    })
    expect(response.body.task_id).toBe('t-1')
  })

  it('reports a business failure as terminal, with the service wording', async () => {
    const { fetchFn } = mockFetch(200, JSON.stringify({
      base_resp: { status_code: 1004, status_msg: 'Please carry the API secret key' },
    }))
    const error = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MatrixToolError)
    const failure = error as MatrixToolError
    expect(failure.code).toBe('MINIMAX_MATRIX_BUSINESS_ERROR')
    expect(failure.status).toBe(200)
    // A refusal the service understood is never worth retrying.
    expect(failure.classification.retryable).toBe(false)
    expect(failure.classification.accountScoped).toBe(false)
    expect(failure.message).toContain('1004')
    expect(failure.message).toContain('Please carry the API secret key')
  })

  it('reports a non-zero top-level code as a terminal business failure', async () => {
    // The second half of upstream's gate (matrix-tools/client.ts:140-158): after
    // base_resp is stripped, a non-zero `code` on the payload is ALSO a
    // business failure. Reading only base_resp.status_code reported {"code":123}
    // as a SUCCESS, which is the defect this pins.
    const { fetchFn } = mockFetch(200, JSON.stringify({ base_resp: { status_code: 0 }, code: 123 }))
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure).toBeInstanceOf(MatrixToolError)
    expect(failure.code).toBe('MINIMAX_MATRIX_BUSINESS_ERROR')
    expect(failure.status).toBe(200)
    expect(failure.classification.code).toBe('PROVIDER_ERROR')
    // Terminal, for the same reason a base_resp refusal is: asking again is the
    // same question.
    expect(failure.classification.retryable).toBe(false)
    expect(failure.classification.accountScoped).toBe(false)
    expect(failure.message).toContain('code 123')
  })

  it('reports a non-zero base_resp status_code as the same business failure', async () => {
    const { fetchFn } = mockFetch(200, JSON.stringify({ base_resp: { status_code: 5 } }))
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.code).toBe('MINIMAX_MATRIX_BUSINESS_ERROR')
    expect(failure.classification.retryable).toBe(false)
    expect(failure.message).toContain('base_resp.status_code 5')
    // The two codes are named separately, so a refusal is never misattributed.
    expect(failure.message).not.toContain('code 5,')
  })

  it('names BOTH codes when both are non-zero', async () => {
    const { fetchFn } = mockFetch(200, JSON.stringify({
      base_resp: { status_code: 5, status_msg: 'bad params' }, code: 123,
    }))
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.message).toContain('base_resp.status_code 5')
    expect(failure.message).toContain('code 123')
    expect(failure.message).toContain('bad params')
  })

  it('treats a zero top-level code as a success', async () => {
    // The measured get_voice_list answer carries code: 0 at the top level, and
    // reading it must not turn a working call into a refusal.
    const { fetchFn } = mockFetch(200, JSON.stringify({
      base_resp: { status_code: 0 }, code: 0, content: 'a cat walks',
    }))
    const response = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    })
    expect(response.body.content).toBe('a cat walks')
  })

  it('does not read a nested code as the envelope verdict', async () => {
    // Upstream reads `code` as a SIBLING of the payload fields, not from inside
    // data/result. A nested code is that tool's own business field.
    const { fetchFn } = mockFetch(200, JSON.stringify({
      base_resp: { status_code: 0 }, data: { code: 123, task_id: 't-9' },
    }))
    const response = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    })
    expect(response.body).toHaveProperty('data')
  })

  it('classifies a 401 as a refused credential', async () => {
    const { fetchFn } = mockFetch(401, JSON.stringify({ code: 401, message: 'token is required' }))
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.code).toBe('MINIMAX_MATRIX_HTTP_ERROR')
    expect(failure.status).toBe(401)
    expect(failure.classification.code).toBe('INVALID_CREDENTIAL')
    expect(failure.classification.retryable).toBe(false)
    expect(failure.classification.accountScoped).toBe(true)
  })

  it('classifies a 403 as a refused credential', async () => {
    const { fetchFn } = mockFetch(403, JSON.stringify({ message: 'forbidden' }))
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.classification.code).toBe('INVALID_CREDENTIAL')
    expect(failure.classification.retryable).toBe(false)
    expect(failure.classification.accountScoped).toBe(true)
  })

  it('classifies a 429 as retryable back-pressure', async () => {
    const { fetchFn } = mockFetch(429, JSON.stringify({ message: 'rate_limit_exceeded' }))
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.classification.code).toBe('RATE_LIMIT')
    expect(failure.classification.retryable).toBe(true)
    // Back-pressure is the plan's, not one account's: cooling this account
    // would empty the pool without helping.
    expect(failure.classification.accountScoped).toBe(false)
  })

  it('classifies a 5xx as a retryable server error', async () => {
    for (const status of [500, 502, 503]) {
      const { fetchFn } = mockFetch(status, JSON.stringify({ message: 'upstream unavailable' }))
      const failure = await callMatrixTool({
        region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
      }).catch((caught: unknown) => caught) as MatrixToolError
      expect(failure.status).toBe(status)
      expect(failure.classification.code).toBe('SERVER')
      expect(failure.classification.retryable).toBe(true)
      expect(failure.classification.accountScoped).toBe(false)
    }
  })

  it('classifies a 400 as a terminal provider error', async () => {
    const { fetchFn } = mockFetch(400, JSON.stringify({ message: 'invalid params' }))
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.status).toBe(400)
    expect(failure.classification.code).toBe('PROVIDER_ERROR')
    expect(failure.classification.retryable).toBe(false)
    expect(failure.classification.accountScoped).toBe(false)
  })

  it('carries the reused classification shape on every failure', async () => {
    // The four fields are the contract the rest of the line reads; a failure
    // that dropped one would break a caller switched from the Messages route.
    const { fetchFn } = mockFetch(503, '{}')
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(Object.keys(failure.classification).sort())
      .toEqual(['accountScoped', 'code', 'message', 'retryable'])
  })

  it('reports a 200 whose body is not a JSON object as a terminal failure', async () => {
    const { fetchFn } = mockFetch(200, '<html>hello</html>')
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.code).toBe('MINIMAX_MATRIX_BUSINESS_ERROR')
    expect(failure.classification.retryable).toBe(false)
  })

  it('reports a transport failure as retryable without inventing a status', async () => {
    const fetchFn = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.code).toBe('MINIMAX_MATRIX_TRANSPORT_ERROR')
    expect(failure.status).toBeUndefined()
    expect(failure.classification.code).toBe('TRANSPORT')
    expect(failure.classification.retryable).toBe(true)
  })

  it('reports a timeout as retryable TIMEOUT', async () => {
    const fetchFn = (async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    }) as unknown as typeof fetch
    const failure = await callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn, timeoutMs: 5,
    }).catch((caught: unknown) => caught) as MatrixToolError
    expect(failure.code).toBe('MINIMAX_MATRIX_TIMEOUT')
    expect(failure.classification.code).toBe('TIMEOUT')
    expect(failure.classification.retryable).toBe(true)
  })

  it('passes a caller cancellation through instead of classifying it', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof fetch
    await expect(callMatrixTool({
      region: 'cn', accessToken: 'tok', tool: MATRIX_TOOL_VIDEOS_UNDERSTAND, body: {}, fetchFn,
      signal: controller.signal,
    })).rejects.toThrow(/aborted/)
  })
})

describe('matrixPayloadField', () => {
  it('reads a top-level payload field', () => {
    expect(matrixPayloadField({ task_id: 't-1' }, 'task_id')).toBe('t-1')
  })

  it('reads a field nested under data or result', () => {
    expect(matrixPayloadField({ data: { task_id: 't-2' } }, 'task_id')).toBe('t-2')
    expect(matrixPayloadField({ result: { task_id: 't-3' } }, 'task_id')).toBe('t-3')
  })

  it('returns undefined rather than an empty string for a missing field', () => {
    expect(matrixPayloadField({}, 'task_id')).toBeUndefined()
  })

  it('prefers the top-level field over a nested one', () => {
    expect(matrixPayloadField({ task_id: 'top', data: { task_id: 'nested' } }, 'task_id')).toBe('top')
  })
})
