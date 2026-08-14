export interface CallbackServerOptions {
    expectedState: string;
    exchange: (code: string, signal: AbortSignal) => Promise<void>;
}
/** One-shot localhost OAuth callback listener. */
export declare class OAuthCallbackServer {
    private readonly options;
    private readonly abortController;
    private server;
    private settled;
    private resolveCompletion;
    private rejectCompletion;
    readonly completion: Promise<void>;
    constructor(options: CallbackServerOptions);
    listen(): Promise<void>;
    cancel(reason: Error): void;
    dispose(): void;
    private handle;
    private finish;
    private close;
}
//# sourceMappingURL=callback-server.d.ts.map