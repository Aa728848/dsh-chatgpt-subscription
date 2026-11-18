import type { GenerateOptions } from './llm-compat.ts'

/**
 * Static engineering discipline for GPT-family coding requests.
 *
 * Keep this text constant: it is part of the prompt prefix and must not vary by
 * turn, time, or tool identity. Runtime repetition remains guarded by the
 * existing tool-runaway protection; this prompt expresses policy, not a blocker.
 */
export const GPT_ENGINEERING_GUIDANCE = 'Engineering execution rule for coding tasks: make the smallest COMPLETE change that addresses the root cause. Before editing, inspect the affected call sites, shared interfaces, and existing implementations; do not stop at a surface symptom, duplicate existing logic merely to reduce the diff, or perform unrelated refactors. Verify proportionally: start with the most focused relevant tests or checks. When neither code nor configuration has changed, do not rerun an equivalent check that already passed. Broaden to full suites, typechecks, or builds for shared contracts, build/release work, or other risk-relevant changes. If repeated actions produce no new evidence, substantive artifact change, or newly verified criterion, change approach or report the blocker instead of repeating the ritual.'

/** Progress is useful at decision points; narrating every tool call is noise. */
export const GPT_PROGRESS_GUIDANCE = 'Progress communication rule: during multi-step tasks, output 1-2 concise, factual sentences at meaningful stage transitions, verified findings, blockers, or before a long wait. Do not narrate every tool call or repeat an unchanged status. Keep the comprehensive final answer and summary for the final delivery after the work is complete.'

/** The shared guidance for a request that can actually use tools. */
export function gptEngineeringGuidance(tools: GenerateOptions['tools']): string | undefined {
  if (!tools?.length) return undefined
  return GPT_ENGINEERING_GUIDANCE + '\n\n' + GPT_PROGRESS_GUIDANCE
}

/** Append shared guidance without inventing a leading separator for an empty base. */
export function appendGptEngineeringGuidance(base: string, tools: GenerateOptions['tools']): string {
  const guidance = gptEngineeringGuidance(tools)
  if (guidance === undefined) return base
  return base === '' ? guidance : base + '\n\n' + guidance
}
