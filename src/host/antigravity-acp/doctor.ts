/**
 * The line's self-check: one command that answers "why is this line not working?"
 *
 * Every other diagnostic in this repository is either a unit test (needs a
 * checkout) or a route (needs a running host and a browser). Neither helps the
 * person who just installed the plugin and sees no models. This module runs the
 * same probes the adapter runs, in the same order, and prints one line per stage:
 * executable, protocol, sign-in, catalogue, and (when a session is available) one
 * real prompt.
 *
 * It is deliberately a pure function over injected probes so it can be tested
 * without a live agent, and it never prints a credential or a raw protocol frame.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/doctor
 */

import type { AcpLaunch } from './adapter.ts'
import type { AcpClient } from './acp-client.ts'
import type { AntigravityAcpModelDto } from '../../shared/antigravity-acp-contracts.ts'

/** One stage's outcome. */
export interface DoctorStep {
  /** Stable stage id, e.g. `binary`, `protocol`, `auth`, `catalog`, `prompt`. */
  id: string
  ok: boolean
  /** One line a human can act on. */
  detail: string
}

/** Everything the check needs, injected. */
export interface DoctorProbes {
  resolveBinary(): Promise<{ path?: string; version?: string; kind?: string; error?: string }>
  resolveLaunch(): Promise<AcpLaunch>
  spawnClient(launch: AcpLaunch): AcpClient
  readCatalog(client: AcpClient): Promise<{ models: AntigravityAcpModelDto[]; tier?: { id: string; name: string } }>
  probeAuth(client: AcpClient): Promise<{ authenticated: boolean; tier?: { id: string; name: string } }>
  /** Optional: run one real prompt and return the assistant text. */
  probePrompt?(client: AcpClient, model: string): Promise<string>
}

/** Result of one full self-check. */
export interface DoctorReport {
  ok: boolean
  steps: DoctorStep[]
}

/**
 * Run every stage, in order, stopping where the next stage would be meaningless.
 *
 * @param probes - The line's own probes.
 * @returns One step per stage plus an overall verdict.
 */
export async function runDoctor(probes: DoctorProbes): Promise<DoctorReport> {
  const steps: DoctorStep[] = []
  const binary: { path?: string; version?: string; kind?: string; error?: string } =
    await probes.resolveBinary().catch((error: unknown): { error: string } => ({ error: String(error) }))
  if (binary.path === undefined) {
    steps.push({ id: 'binary', ok: false, detail: binary.error ?? 'No usable Antigravity CLI (agy) was found.' })
    return { ok: false, steps }
  }
  steps.push({
    id: 'binary',
    ok: true,
    detail: `${binary.kind ?? 'unknown'} ${binary.path}${binary.version === undefined ? '' : ' (v' + binary.version + ')'}`,
  })

  let client: AcpClient | undefined
  try {
    const launch = await probes.resolveLaunch()
    client = probes.spawnClient(launch)
  } catch (error) {
    steps.push({ id: 'protocol', ok: false, detail: 'Could not start the agent: ' + String(error) })
    return { ok: false, steps }
  }

  try {
    const auth = await probes.probeAuth(client)
    steps.push({
      id: 'auth',
      ok: auth.authenticated,
      detail: auth.authenticated
        ? 'Signed in' + (auth.tier === undefined ? '' : ' (' + auth.tier.name + ')')
        : 'Not signed in. Run `agy acp --login` or use the sign-in button in this card.',
    })
    if (!auth.authenticated) return { ok: false, steps: finish(steps) }

    const catalog = await probes.readCatalog(client)
    steps.push({
      id: 'catalog',
      ok: catalog.models.length > 0,
      detail: catalog.models.length === 0
        ? 'The agent returned no models for this account.'
        : `${catalog.models.length} model(s): ${catalog.models.slice(0, 5).map((model) => model.id).join(', ')}${catalog.models.length > 5 ? ', ...' : ''}`,
    })
    if (catalog.models.length === 0) return { ok: false, steps: finish(steps) }

    if (probes.probePrompt !== undefined) {
      const answer = await probes.probePrompt(client, catalog.models[0]!.id).catch((error: unknown) => 'FAILED: ' + String(error))
      steps.push({
        id: 'prompt',
        ok: !answer.startsWith('FAILED: '),
        detail: answer.slice(0, 200),
      })
    }
    return { ok: steps.every((step) => step.ok), steps: finish(steps) }
  } finally {
    await client.dispose().catch(() => undefined)
  }
}

/** Put the protocol stage in front of the stages that needed a live client. */
function finish(steps: DoctorStep[]): DoctorStep[] {
  if (steps.some((step) => step.id === 'protocol')) return steps
  // The binary check ran first; a live session proves the protocol stage too, so
  // both stay in the report, binary first, protocol second.
  const done = steps.find((step) => step.id === 'binary')
  return [
    ...(done === undefined ? [] : [done]),
    { id: 'protocol', ok: true, detail: 'ACP v1 session opened over stdio.' },
    ...steps.filter((step) => step.id !== 'binary'),
  ]
}

/**
 * Render one report as the lines a CLI prints.
 *
 * @param report - The report from {@link runDoctor}.
 * @returns One line per stage, plus a verdict line.
 */
export function formatDoctorReport(report: DoctorReport): string[] {
  const lines = report.steps.map((step) => `${step.ok ? 'OK  ' : 'FAIL'} ${step.id.padEnd(9)} ${step.detail}`)
  lines.push(report.ok ? 'Antigravity (ACP) is ready.' : 'Antigravity (ACP) is not ready; fix the first FAIL above.')
  return lines
}
