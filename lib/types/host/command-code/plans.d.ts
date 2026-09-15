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
    id: string;
    /** Display name the CLI renders, e.g. `GOAT`. */
    name: string;
    /** Monthly credit allowance the plan grants. */
    monthlyCredits: number;
}
/**
 * Every plan, longest id first.
 *
 * The order matters: the service appends suffixes (`individual-pro-v1`) and
 * shares prefixes across plans (`individual-pro` is a prefix of both
 * `individual-pro-v1` and `individual-provider`), so the match must try the
 * longest id first or `individual-provider` would resolve to `Pro`.
 */
export declare const COMMAND_CODE_PLANS: readonly CommandCodePlan[];
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
export declare function resolveCommandCodePlan(planId: string | null | undefined): CommandCodePlan | null;
/** Display name for one plan id, falling back to the raw id so nothing is hidden. */
export declare function commandCodePlanLabel(planId: string | null | undefined): string | null;
//# sourceMappingURL=plans.d.ts.map