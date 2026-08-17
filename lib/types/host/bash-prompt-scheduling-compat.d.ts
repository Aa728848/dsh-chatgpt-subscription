import type { Context } from '@deepseek-ai/cordis';
/**
 * DSH_COMPAT_REMOVE(persistent-bash-prompt-mismatch)
 *
 * Temporary compatibility shim for DSH 0.1.0-rc.6. The persistent bash tool
 * (`@deepseek-ai/dsh-tool-bash-persistent`) configures the bash shell PS1 to
 * `__DSH_PERSISTENT_BASH_PROMPT__ `, while the underlying PTY backend
 * (`@deepseek-ai/dsh-terminal-bash`) only checks for a hardcoded `dsh> `
 * prompt with a 6-character truncation limit.
 *
 * When the prompt does not match, `promptTextSeen` remains false and the PTY
 * session falls back to the 3.5s idle silence timeout (`idleSilenceMs: 3000ms`
 * + `handoffGraceMs: 500ms`) on every command execution.
 *
 * This compatibility module patches the PTY session `onData` handler so that
 * both `dsh> ` and `__DSH_PERSISTENT_BASH_PROMPT__ ` (and its trimmed variants)
 * satisfy `promptTextSeen`, restoring instant 50ms readiness settling.
 *
 * Remove this module, its installation in `src/index.ts`, and its focused test
 * once upstream aligns `CONTROLLED_PROMPT` with persistent bash tools.
 */
export declare const DSH_BASH_PROMPT_COMPAT_MARKER: "__dshChatgptSubscriptionBashPromptCompatV1";
export declare const KNOWN_CONTROLLED_PROMPTS: readonly ["dsh> ", "dsh>", "__DSH_PERSISTENT_BASH_PROMPT__ ", "__DSH_PERSISTENT_BASH_PROMPT__"];
export declare function isKnownControlledPrompt(tail: string): boolean;
interface SanitizerResult {
    text: string;
    prompt?: boolean;
    promptTail?: string;
}
interface SanitizerLike {
    push(data: string): SanitizerResult;
}
export interface PtySessionLike {
    sanitizer: SanitizerLike;
    promptSeen: boolean;
    promptTextSeen: boolean;
    promptTail: string;
    lastOutputAt: number;
    appendOutput(text: string): void;
    onData(data: string): void;
}
export declare function patchSessionOnData(target: {
    prototype?: PtySessionLike;
} | PtySessionLike): () => void;
/**
 * Installs the persistent bash prompt compatibility patch onto registered and
 * future PTY backends via Cordis scoped injection.
 */
export declare function installBashPromptCompat(ctx: Context): () => void;
export {};
//# sourceMappingURL=bash-prompt-scheduling-compat.d.ts.map