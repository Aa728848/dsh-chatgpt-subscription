/**
 * Replace the compaction directive DSH ships with one that reads better.
 *
 * DSH's `compaction-basic` delivers its summarization directive as the FINAL
 * user message of the replayed conversation (see its `summarizer.ts`): keeping
 * the conversation's own prefix in front of it is what makes the auxiliary call
 * a genuine prefix of the last routed request, so the provider's KV cache is
 * reused instead of invalidated. That directive is a private constant of the
 * harness, not a setting, and no preset may edit it.
 *
 * The replacement below keeps that property: it is spliced into the SAME final
 * message, so every earlier message — the system prompt, the tools, the whole
 * conversation — is byte-identical and the cache prefix still matches. Only the
 * trailing instruction differs, which is the part a compaction request was
 * never going to cache-hit anyway.
 *
 * Three things the shipped directive gets wrong, each learned from the official
 * `MoonshotAI/kimi-code` agent (`fullCompaction/compaction-instruction.md`):
 *
 * 1. **Language.** It demands "concise English engineering prose" even when the
 *    conversation is not English, so a Chinese session's checkpoint comes back
 *    in English and the resumed turn has to translate its own history. The
 *    official instruction says to keep the conversation's own language.
 * 2. **Rigid sections.** It fixes nine headings. When a conversation is mostly
 *    one long debugging thread, forcing it into nine buckets spends the budget
 *    on empty sections and starves the one that matters. The official
 *    instruction lets the shape follow the task.
 * 3. **Values, not commands.** It says to preserve "commands and error strings"
 *    but not the VALUES those commands returned. A resumed turn that knows
 *    `grep -n foo` ran, but not what it printed, re-runs it — and the file may
 *    have changed since.
 *
 * What is deliberately kept from DSH's version: the instruction to fold a prior
 * `<compacted-summary>` block forward rather than copy it, because without it
 * each compaction restates the previous checkpoint and the history grows a
 * summary of a summary.
 *
 * @module dsh-chatgpt-subscription/compaction-prompt
 */

/**
 * First line of the directive DSH ships.
 *
 * Matched as a prefix rather than the whole text: the harness owns that
 * constant and may reword its later sections without warning, and a matcher
 * pinned to the full string would silently stop replacing anything.
 */
export const SHIPPED_INSTRUCTION_OPENING =
  'You are now acting as a compaction engine for this AI coding assistant.'

/** Marker the harness wraps a prior checkpoint in; the replacement must keep folding it. */
export const PRIOR_CHECKPOINT_OPEN_TAG = '<compacted-summary>'

/** The replacement directive. */
export const COMPACTION_INSTRUCTION = [
  'You are about to run out of context. Create a handoff summary for the model that will resume this work after the earlier conversation is cleared.',
  '',
  '--- This message is a direct task, not part of the conversation above ---',
  '',
  'Do not impose rigid section headings; let the shape follow the task. Write it in the same language the conversation has been using — do not switch to English just because these instructions happen to be in English.',
  '',
  'Make the summary self-sufficient: the next turn will see only this summary, so every assistant message, tool call, and tool result above will be gone. Preserve what you genuinely need to continue:',
  '',
  '- What the latest request is actually asking for, and any ambiguity you have already resolved. Do not re-transcribe it: whatever fits is kept verbatim in the messages that survive, though those are size-capped.',
  '- The instructions and constraints currently in force: user preferences, project rules, environment and tooling limits. Keep decisions you have already settled (what you chose and why) separate from questions still open, so the next turn neither reopens a closed choice nor treats an undecided point as decided.',
  '- What has actually been done, at high fidelity: the exact commands run, the exact file paths touched, and whether each succeeded or failed — and the RESULTS themselves, not just the commands. Keep the concrete values returned, the key lines or error text, the schema or signature a lookup revealed: re-running to recover them may be slow or impossible, and the file may have changed since. Keep only the final working version of any code; drop intermediate attempts and already-resolved errors.',
  '- What you still do not know: context the next step depends on that this conversation never established — files or paths referenced but not yet read, schemas or APIs assumed but unseen, questions the user has not answered. Name these gaps so the next turn goes and checks them instead of assuming.',
  '- The forward plan. Right now you hold more context on this task than you ever will again; the next turn resumes with less, so the plan you commit here is the one it will follow. Give the exact next command or tool call, but do not stop at the next step: set out the remaining sequence, the decisions you have already made for those steps, the obstacles you can already foresee and how you mean to handle them, and any work you can commit to now.',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments verbatim, even when the surrounding prose is translated.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections: a correction that is lost comes back as the same mistake.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${PRIOR_CHECKPOINT_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary.`,
].join('\n')

/** One text-bearing content block, as the splice reads it. */
export interface PromptBlock {
  readonly type?: string | undefined
  readonly text?: string | undefined
}

/** One request message, narrowed to what the splice needs. */
export interface PromptMessage {
  readonly role?: string | undefined
  readonly content?: readonly PromptBlock[] | undefined
}

/**
 * Whether one message carries DSH's shipped directive.
 * @param message - one request message.
 * @returns whether its text opens with {@link SHIPPED_INSTRUCTION_OPENING}.
 */
export function carriesShippedInstruction(message: PromptMessage): boolean {
  if (message.role !== 'user') return false
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text.startsWith(SHIPPED_INSTRUCTION_OPENING)
    }
  }
  return false
}

/**
 * Splice the replacement directive into the conversation's final message.
 *
 * Every earlier message is returned by reference, unchanged: that is the whole
 * cache argument for doing this at the last message instead of rebuilding the
 * request. Returns the original array when no message carries the shipped
 * directive, so a host that reworded it (or a call that is not a compaction)
 * costs nothing and stays on the harness's own text.
 * @param messages - the compaction request's messages.
 * @returns messages whose final shipped directive is replaced, or the input.
 */
export function replaceCompactionInstruction<M extends PromptMessage>(
  messages: readonly M[],
): readonly M[] {
  const index = messages.findIndex(carriesShippedInstruction)
  if (index < 0) return messages
  const target = messages[index] as M
  const blocks = (target.content ?? []).map((block) => (
    block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(SHIPPED_INSTRUCTION_OPENING)
      ? { ...block, text: COMPACTION_INSTRUCTION }
      : block
  ))
  const replaced = { ...target, content: blocks } as M
  const next = [...messages]
  next[index] = replaced
  return next
}

/** The `llm/stream` options this splice reads and rewrites. */
export interface PromptStreamOptions {
  /** `compaction` on an auxiliary summary call; absent on a conversation turn. */
  readonly purpose?: string | undefined
  /**
   * Ordered request messages; the last one carries the summarization directive.
   *
   * Deliberately NOT readonly: assigning it is how the splice hands the
   * rewritten request downstream, because `next()` takes no arguments. The
   * harness types the same field as a mutable array for the same reason.
   */
  messages?: readonly PromptMessage[]
}

/** A chunk as it crosses the stream boundary; the splice never inspects one. */
export interface PromptChunk {
  readonly type: string
}

/** The `llm/stream` waterfall listener this module registers. */
export type PromptStreamListener = (
  options: PromptStreamOptions,
  next: () => AsyncIterable<PromptChunk>,
) => AsyncIterable<PromptChunk>

/** The context surface this splice needs, declared structurally per harness generation. */
export interface PromptContext {
  on?(
    event: 'llm/stream',
    listener: PromptStreamListener,
    options?: { readonly global?: boolean },
  ): unknown
  logger?: { warn(message: string): void } | undefined
}

/** Live handle: teardown for the registered listener. */
export interface PromptHandle {
  dispose(): void
}

/**
 * Install the `llm/stream` listener that swaps the directive in place.
 *
 * The rewrite happens on the request object the waterfall already carries,
 * because `next()` takes no arguments: there is no way to hand a modified
 * request downstream, and re-entering `stream()` to pass one would put this
 * listener back in its own path. Assigning `messages` is therefore the only
 * seam that leaves every other field — provider, model, tools, session — exactly
 * as the harness built them.
 *
 * A frozen request is skipped rather than forced: a host that freezes its
 * options is telling callers not to rewrite them, and keeping the shipped
 * directive is a correct outcome, not a failure.
 * @param ctx - structural context: the event bus and a logger.
 * @returns the live handle, or undefined on a host with no event bus.
 */
export function installCompactionPrompt(ctx: PromptContext): PromptHandle | undefined {
  const on = ctx.on
  if (typeof on !== 'function') return undefined
  // Marks a request already spliced, so a listener chain that revisits the same
  // object cannot wrap the replacement in itself.
  const spliced = new WeakSet<object>()

  const listener: PromptStreamListener = async function* replaceByStream(options, next) {
    if (options.purpose !== 'compaction' || spliced.has(options)) return yield* next()
    const messages = options.messages
    if (messages === undefined || messages.length === 0) return yield* next()
    const replaced = replaceCompactionInstruction(messages)
    // No shipped directive found: the harness reworded it, or this is not the
    // call shape we know. Leaving it alone keeps the harness's own text.
    if (replaced === messages) return yield* next()
    if (Object.isFrozen(options)) {
      ctx.logger?.warn(
        '[dsh-chatgpt-subscription] compaction prompt kept as shipped: the request options are frozen',
      )
      return yield* next()
    }
    spliced.add(options)
    options.messages = replaced
    yield* next()
  }

  const dispose = on('llm/stream', listener, { global: true })
  return { dispose: () => { if (typeof dispose === 'function') dispose() } }
}
