import { test, expect } from 'vitest'
import { signInOasisQuotaCredential, stepChatCompletionsUrl } from '../src/host/step-code/client.ts'
import { buildChatRequest } from '../src/host/step-code/mapper.ts'

test('step usage accounting shape', async () => {
  const account = process.env.STEP_USER ?? ''
  const password = process.env.STEP_PW ?? ''
  const cred = await signInOasisQuotaCredential({ profile: 'step_plan', account, password })
  console.log('[probe] stepChatCompletionsUrl =', stepChatCompletionsUrl('step_plan'))
  const url = stepChatCompletionsUrl('step_plan')
  const req = buildChatRequest({
    provider: 'step-code',
    model: 'step-5-preview',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
  })
  console.log('[probe] request body keys =', Object.keys(req as object).join(','))
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cred.token.split('...')[0] },
    body: JSON.stringify(req),
  })
  const text = await res.text()
  console.log('[probe] status =', res.status)
  console.log('[probe] body   =', text.slice(0, 400))
})