/**
 * Read-only diagnostic probe for the child→parent subagent relay.
 *
 * The probe answers one question with evidence: when a continuable child tells
 * its parent it finished (`send_message` or the runtime settlement notice),
 * what did the parent's side actually do — was the message inserted into the
 * inbox, claimed, turned into a model request, and did that turn produce any
 * visible content? It observes durable session events plus the live Agent
 * snapshot and writes metadata-only lines: never prompt text, never file
 * contents, never credentials. The only message text it copies is a bounded
 * excerpt of a tool result that matches a known delivery-failure marker.
 *
 * It is inert unless {@link RELAY_PROBE_ENV} is truthy, it never throws into the
 * host (a diagnostic must not break the deployment), and it writes nothing but
 * the log file.
 *
 * @module dsh-chatgpt-subscription/relay-probe
 */
/** Environment switch: any of `1`, `true`, `yes`, `on` enables the probe. */
export declare const RELAY_PROBE_ENV = "DSH_CHATGPT_SUBSCRIPTION_RELAY_PROBE";
/** Environment override for the log path (default `$DSH_HOME/relay-probe.log`). */
export declare const RELAY_PROBE_FILE_ENV = "DSH_CHATGPT_SUBSCRIPTION_RELAY_PROBE_FILE";
/** Default log file name inside the DSH home. */
export declare const RELAY_PROBE_FILE_NAME = "relay-probe.log";
/** A probe log is truncated once it grows past this size. */
export declare const RELAY_PROBE_MAX_BYTES: number;
/** Message source kinds that cross the child→parent delivery boundary. */
export declare const RELAY_SOURCE_KINDS: readonly string[];
/** One Session as this probe reads it. */
export interface ProbeSession {
    readonly id: string;
    /** A real Session header carries many more fields; only two are read here. */
    readonly header?: {
        readonly origin?: unknown;
        readonly parentSession?: unknown;
        readonly [key: string]: unknown;
    } | undefined;
}
/** One durable session event as this probe reads it. */
export interface ProbeEvent {
    readonly type?: unknown;
    readonly seq?: unknown;
    readonly data?: unknown;
}
/** Live Agent fields this probe snapshots (never mutated). */
export interface ProbeAgent {
    readonly status?: unknown;
    readonly inbox?: {
        readonly nextStep?: readonly unknown[];
        readonly nextTurn?: readonly unknown[];
    } | undefined;
}
/** Registry lookup for the live Agent behind a Session id. */
export interface AgentsLookup {
    get(id: string): ProbeAgent | undefined;
}
/** Where probe lines go. */
export interface RelayProbeSink {
    write(line: string): void;
}
/** Construction inputs for {@link RelayProbe}. */
export interface RelayProbeOptions {
    readonly sink: RelayProbeSink;
    readonly agents?: AgentsLookup | undefined;
    readonly clock?: (() => number) | undefined;
    readonly maxObservedSessions?: number | undefined;
}
/** The Context surface {@link installRelayProbe} needs. */
export interface RelayProbeContext {
    on(event: 'session/event', listener: (session: ProbeSession, event: ProbeEvent) => void): unknown;
    get?(name: string): unknown;
    logger?: {
        info(message: string): void;
    } | undefined;
}
/**
 * Observes delivery boundaries and the parent turns they should produce.
 *
 * Every method is fail-open: an unexpected shape is dropped, never thrown.
 */
export declare class RelayProbe {
    private readonly options;
    private readonly observed;
    private readonly started;
    private readonly clock;
    private readonly maxObserved;
    private seen;
    /** Count of observations dropped by the fail-open boundary. */
    failures: number;
    constructor(options: RelayProbeOptions);
    /** Observe one durable session event. */
    observe(session: ProbeSession, event: ProbeEvent): void;
    private step;
    /** A delivery entering (or leaving) the parent's inbox. */
    private onSplice;
    /** A message committed to the session surface — for a relay, the claim. */
    private onUserMessage;
    /** A child attempting to report to its parent. */
    private onToolCall;
    /** A tool result that may be a refused delivery. */
    private onToolResult;
    private toolResultText;
    private observedRequest;
    private turnReason;
    private formTag;
    /** Live snapshot of the Agent behind this Session, when it is resident. */
    private agentState;
    private pending;
    private watch;
    private line;
    /** One startup line so a captured file says which process wrote it. */
    head(path: string): void;
    /** Sessions currently under observation. */
    get observedCount(): number;
    /** Event sequence number of the last observed event, when present. */
    mark(seq: unknown): void;
    /** Last observed durable sequence number, when the log carried one. */
    get lastSeq(): number | undefined;
}
/** Where the probe reads a fallback value from, beside the process environment. */
export interface RelayProbeEnvOptions {
    /**
     * An env-file consulted after the process environment. Defaults to no file so
     * a caller (or a test) never reads configuration behind the injected
     * environment's back; {@link relayProbeEnvFile} names the deployment default.
     */
    readonly envFile?: string | null;
    /** DSH home used for the default log path and env file. */
    readonly home?: string;
}
/** The deployment's env file, `$DSH_HOME/.env`, as the proxy settings already read it. */
export declare function relayProbeEnvFile(home?: string): string;
/**
 * Read one probe key from the process environment, then from the env file.
 * The key is always one of this module's own constants, so it is safe to
 * interpolate into the lookup pattern.
 * @param key - constant probe key.
 * @param env - environment to read first.
 * @param options - optional env-file fallback and DSH home.
 * @returns the trimmed value, or undefined when neither source sets one.
 */
export declare function relayProbeEnvValue(key: string, env: Record<string, string | undefined>, options?: RelayProbeEnvOptions): string | undefined;
/** Whether the environment enables the probe. */
export declare function relayProbeEnabled(env?: Record<string, string | undefined>, options?: RelayProbeEnvOptions): boolean;
/** Resolve the probe log path from the environment. */
export declare function relayProbeLogPath(env?: Record<string, string | undefined>, options?: RelayProbeEnvOptions): string;
/** Append-only file sink that truncates itself past a size cap. */
export declare function createFileRelayProbeSink(options: {
    path: string;
    maxBytes?: number;
}): RelayProbeSink;
/**
 * Subscribe the probe to durable session events.
 * @param ctx - host context (or its probe-facing subset).
 * @param options - sink, optional agent lookup, and optional clock.
 * @returns the disposer that detaches the listener.
 */
export declare function installRelayProbe(ctx: RelayProbeContext, options: RelayProbeOptions & {
    path?: string;
}): () => void;
//# sourceMappingURL=relay-probe.d.ts.map