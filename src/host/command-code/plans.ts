/**
 * Command Code subscription plans.
 *
 * Transcribed from the official CLI's own plan table, which is the only place
 * the service's `planId` strings are given human names — `/alpha/whoami` says
 * nothing about the plan and `/alpha/billing/subscriptions` only reports the
 * machine id (`individual-goat`), so a card that shows the raw id shows nothing
 * a user recognizes.
 */

/** One subscription plan, with the monthly credit allowance the CLI assigns it. */
export interface CommandCodePlan {
  id: string
  /** Display name the CLI renders, e.g. `GOAT`. */
  name: string
  /** Monthly credit allowance the plan grants. */
  monthlyCredits: number
}

/**
 * Every plan, longest id first.
 *
 * The order matters: the service appends suffixes (`individual-pro-v1`) and
 * shares prefixes across plans (`individual-pro` is a prefix of both
 * `individual-pro-v1` and `individual-provider`), so the match must try the
 * longest id first or `individual-provider` would resolve to `Pro`.
 */
export const COMMAND_CODE_PLANS: readonly CommandCodePlan[] = [
  { id: 'individual-provider', name: 'Provider', monthlyCredits: 15 },
  { id: 'individual-pro-v1', name: 'Pro', monthlyCredits: 80 },
  { id: 'individual-goat', name: 'GOAT', monthlyCredits: 70 },
  { id: 'individual-ultra', name: 'Ultra', monthlyCredits: 300 },
  { id: 'individual-max', name: 'Max', monthlyCredits: 150 },
  { id: 'individual-pro', name: 'Pro', monthlyCredits: 30 },
  { id: 'individual-go', name: 'Go', monthlyCredits: 10 },
  { id: 'teams-pro', name: 'Teams Pro', monthlyCredits: 40 },
]

/**
 * Resolve one `planId` string to its plan.
 *
 * The service is not consistent about case or separators, so the id is
 * normalized before matching and the comparison is a prefix test, exactly as
 * the CLI does it.
 *
 * @param planId - raw id from the subscription or credits payload.
 * @returns the matching plan, or null when the id is absent or unrecognized.
 */
export function resolveCommandCodePlan(planId: string | null | undefined): CommandCodePlan | null {
  if (planId === null || planId === undefined) return null
  const normalized = planId.trim().toLowerCase().replace(/_/g, '-')
  if (normalized === '') return null
  return COMMAND_CODE_PLANS.find((plan) => normalized.startsWith(plan.id)) ?? null
}

/** Display name for one plan id, falling back to the raw id so nothing is hidden. */
export function commandCodePlanLabel(planId: string | null | undefined): string | null {
  if (planId === null || planId === undefined || planId.trim() === '') return null
  return resolveCommandCodePlan(planId)?.name ?? planId
}
