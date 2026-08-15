import { CallId, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, attributionHeaders, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
//#region src/host/model-catalog.ts
const PROVIDER_ID = "codex-chatgpt";
const PROVIDER_NAME = "Codex（ChatGPT 订阅）";
const MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.2"
];
const STANDARD_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh"
];
const GPT_56_REASONING_EFFORTS = [...STANDARD_REASONING_EFFORTS, "max"];
const MODEL_REASONING = {
	"gpt-5.6-sol": {
		efforts: GPT_56_REASONING_EFFORTS,
		defaultEffort: "medium"
	},
	"gpt-5.6-terra": {
		efforts: GPT_56_REASONING_EFFORTS,
		defaultEffort: "medium"
	},
	"gpt-5.6-luna": {
		efforts: GPT_56_REASONING_EFFORTS,
		defaultEffort: "medium"
	},
	"gpt-5.5": {
		efforts: STANDARD_REASONING_EFFORTS,
		defaultEffort: "medium"
	},
	"gpt-5.4": {
		efforts: STANDARD_REASONING_EFFORTS,
		defaultEffort: "none"
	},
	"gpt-5.4-mini": {
		efforts: STANDARD_REASONING_EFFORTS,
		defaultEffort: "none"
	},
	"gpt-5.2": {
		efforts: STANDARD_REASONING_EFFORTS,
		defaultEffort: "none"
	}
};
function listCodexModels() {
	return MODEL_IDS.map((id) => ({
		provider: PROVIDER_ID,
		id,
		name: id,
		inputModalities: ["text", "image"]
	}));
}
function resolveCodexModel(model) {
	const reasoning = MODEL_REASONING[model] ?? MODEL_REASONING["gpt-5.6-sol"];
	return {
		provider: PROVIDER_ID,
		id: model,
		name: model,
		inputModalities: ["text", "image"],
		context: { contextWindow: 272e3 },
		defaultMaxTokens: 32768,
		reasoning: {
			efforts: reasoning.efforts.map((effort) => ({
				id: ReasoningEffortId(effort),
				name: effort
			})),
			defaultEffort: ReasoningEffortId(reasoning.defaultEffort)
		}
	};
}
//#endregion
//#region src/host/adapter.ts
const RETRY_POLICY = resolveRetryPolicy({
	mode: "normal",
	maxRetries: 2,
	retryableCodes: [
		"RATE_LIMIT",
		"SERVER_ERROR",
		"NETWORK"
	],
	backoff: {
		initialDelayMs: 1e3,
		maxDelayMs: 1e4,
		jitterRatio: .15
	}
}, "dsh-chatgpt-subscription.retry");
var CodexChatGptAdapter = class extends LlmAdapter {
	client;
	constructor(client) {
		super();
		this.client = client;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: PROVIDER_NAME
		};
	}
	providerRetryPolicy() {
		return RETRY_POLICY;
	}
	async listModels() {
		return listCodexModels();
	}
	async resolveModel(_provider, model) {
		return resolveCodexModel(model);
	}
	stream(options) {
		return this.client.stream(options);
	}
};
//#endregion
//#region src/compat.ts
/**
* Compatibility constants for the ChatGPT-backed Codex flow. The backend and
* OAuth parameters are not a public third-party API contract, so every such
* value is isolated here for review and rollback.
*/
const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_CALLBACK_HOST = "localhost";
const OAUTH_CALLBACK_PORT = 1455;
const OAUTH_REDIRECT_URI = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}/auth/callback`;
const OAUTH_SCOPE = "openid profile email offline_access";
const OAUTH_ORIGINATOR = "opencode";
const ROUTE_PREFIX = "/api/dsh-chatgpt-subscription";
const PLUGIN_VERSION = "0.1.0-alpha.0";
const CODEX_RESPONSES_URL = `https://chatgpt.com/backend-api/codex/responses`;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ORIGINATOR = "opencode";
const QUOTA_MIN_UPSTREAM_INTERVAL_MS = 15e3;
const OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
//#endregion
//#region src/host/callback-server.ts
/** One-shot localhost OAuth callback listener. */
var OAuthCallbackServer = class {
	options;
	abortController = new AbortController();
	server = null;
	settled = false;
	resolveCompletion;
	rejectCompletion;
	completion = new Promise((resolve, reject) => {
		this.resolveCompletion = resolve;
		this.rejectCompletion = reject;
	});
	constructor(options) {
		this.options = options;
	}
	async listen() {
		if (this.server !== null) throw new Error("OAuth callback server already started");
		const server = http.createServer((request, response) => {
			this.handle(request, response);
		});
		this.server = server;
		await new Promise((resolve, reject) => {
			const onError = (error) => reject(error);
			server.once("error", onError);
			server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
				server.off("error", onError);
				resolve();
			});
		}).catch((error) => {
			this.server = null;
			server.close();
			throw error;
		});
	}
	cancel(reason) {
		this.finish(reason);
	}
	dispose() {
		if (!this.settled) this.finish(/* @__PURE__ */ new Error("OAuth callback listener disposed"));
		else this.close();
	}
	async handle(request, response) {
		if (this.settled) {
			await writeHtml(response, 410, "This sign-in attempt is no longer active.");
			return;
		}
		if (!isLoopback(request.socket.remoteAddress)) {
			await writeHtml(response, 403, "OAuth callback rejected.");
			return;
		}
		const url = new URL(request.url ?? "/", `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}`);
		if (url.pathname !== "/auth/callback") {
			await writeHtml(response, 404, "Not found.");
			return;
		}
		const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (providerError !== null || code === null || code === "" || state !== this.options.expectedState) {
			await writeHtml(response, 400, "ChatGPT returned an invalid OAuth callback.");
			this.finish(/* @__PURE__ */ new Error(providerError === null ? "invalid OAuth callback" : "OAuth provider rejected sign-in"));
			return;
		}
		try {
			await this.options.exchange(code, this.abortController.signal);
			await writeHtml(response, 200, "ChatGPT sign-in completed. You can close this window.");
			this.finish();
		} catch (error) {
			await writeHtml(response, 500, "ChatGPT sign-in could not be completed. Return to DSH for details.");
			this.finish(error instanceof Error ? error : /* @__PURE__ */ new Error("OAuth token exchange failed"));
		}
	}
	finish(error) {
		if (this.settled) return;
		this.settled = true;
		this.abortController.abort();
		this.close();
		if (error === void 0) this.resolveCompletion();
		else this.rejectCompletion(error);
	}
	close() {
		const server = this.server;
		this.server = null;
		server?.close();
		server?.closeAllConnections();
	}
};
function isLoopback(address) {
	if (address === void 0) return false;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function writeHtml(response, status, message) {
	const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		connection: "close"
	});
	return new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		response.once("finish", done);
		response.once("close", done);
		response.end(`<!doctype html><meta charset="utf-8"><title>DSH Codex sign-in</title><h1>${escaped}</h1>`);
	});
}
//#endregion
//#region src/host/oauth-service.ts
var OAuthServiceError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "OAuthServiceError";
	}
};
var OAuthService = class {
	store;
	fetchFn;
	now;
	random;
	logger;
	loginTimeoutMs;
	loginEvents = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Map();
	activeLogin = null;
	refreshPromise = null;
	lastLoginError;
	disposed = false;
	constructor(store, options = {}) {
		this.store = store;
		this.fetchFn = options.fetchFn ?? fetch;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? randomBytes;
		this.logger = options.logger ?? console;
		this.loginTimeoutMs = options.loginTimeoutMs ?? 3e5;
	}
	async status() {
		try {
			const credentials = await this.store.load();
			return this.statusFromCredentials(credentials);
		} catch {
			return {
				...this.statusFromCredentials(null),
				error: publicError(new OAuthServiceError("storage-failed", "Secure credential storage could not be read."))
			};
		}
	}
	async startLogin() {
		this.assertAvailable();
		if (this.activeLogin !== null) throw new OAuthServiceError("login-active", "A ChatGPT sign-in is already in progress.");
		this.lastLoginError = void 0;
		const loginId = this.random(24).toString("base64url");
		const verifier = this.random(48).toString("base64url");
		const state = this.random(32).toString("base64url");
		const expiresAt = this.now() + this.loginTimeoutMs;
		const server = new OAuthCallbackServer({
			expectedState: state,
			exchange: async (code, signal) => this.exchangeCode(code, verifier, signal)
		});
		try {
			await server.listen();
		} catch {
			server.completion.catch(() => void 0);
			server.dispose();
			throw new OAuthServiceError("internal", "The localhost OAuth callback listener could not start on port 1455.");
		}
		const timeout = setTimeout(() => {
			this.cancelActive(new OAuthServiceError("login-expired", "ChatGPT sign-in timed out."), "failed");
		}, this.loginTimeoutMs);
		timeout.unref?.();
		this.activeLogin = {
			id: loginId,
			expiresAt,
			server,
			timeout
		};
		this.publish({
			type: "pending",
			loginId
		});
		server.completion.then(() => {
			this.completeLogin(loginId);
		}).catch((error) => {
			this.failLogin(loginId, error);
		});
		this.logger.info("[dsh-chatgpt-subscription] OAuth login started");
		return {
			loginId,
			authUrl: buildAuthorizationUrl(verifier, state),
			expiresAt
		};
	}
	cancelLogin(loginId) {
		if (this.activeLogin === null || this.activeLogin.id !== loginId) throw new OAuthServiceError("bad-request", "The requested sign-in is not active.");
		this.cancelActive(new OAuthServiceError("login-cancelled", "ChatGPT sign-in was cancelled."), "cancelled");
	}
	subscribe(loginId, listener) {
		const current = this.loginEvents.get(loginId);
		if (current === void 0) return null;
		let set = this.listeners.get(loginId);
		if (set === void 0) {
			set = /* @__PURE__ */ new Set();
			this.listeners.set(loginId, set);
		}
		set.add(listener);
		listener(current);
		return () => {
			set?.delete(listener);
			if (set?.size === 0) this.listeners.delete(loginId);
		};
	}
	async refresh() {
		this.assertAvailable();
		const stored = await this.loadAuthenticated();
		await this.refreshCredentials(stored);
		return this.status();
	}
	async logout() {
		if (this.activeLogin !== null) this.cancelActive(new OAuthServiceError("login-cancelled", "ChatGPT sign-in was cancelled."), "cancelled");
		await this.store.clear().catch(() => {
			throw new OAuthServiceError("storage-failed", "Secure credentials could not be deleted.");
		});
		this.lastLoginError = void 0;
		this.logger.info("[dsh-chatgpt-subscription] OAuth credentials cleared");
	}
	async credentials(forceRefresh = false) {
		const stored = await this.loadAuthenticated();
		if (forceRefresh || stored.expiresAt - this.now() <= 6e4) return this.refreshCredentials(stored);
		return stored;
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		if (this.activeLogin !== null) this.cancelActive(new OAuthServiceError("login-cancelled", "ChatGPT sign-in was cancelled."), "cancelled");
		this.listeners.clear();
		this.loginEvents.clear();
	}
	async exchangeCode(code, verifier, signal) {
		const response = await this.fetchFn(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: OAUTH_REDIRECT_URI,
				client_id: CHATGPT_OAUTH_CLIENT_ID,
				code_verifier: verifier
			}).toString(),
			signal
		}).catch(() => {
			throw new OAuthServiceError("oauth-token-exchange-failed", "ChatGPT token exchange could not be reached.");
		});
		if (!response.ok) {
			const detail = await oauthErrorIdentifier(response);
			throw new OAuthServiceError("oauth-token-exchange-failed", `ChatGPT token exchange failed (${response.status}${detail === null ? "" : `, ${detail}`}).`);
		}
		const credentials = credentialsFromTokenResponse(await response.json(), this.now());
		await this.store.save(credentials).catch(() => {
			throw new OAuthServiceError("storage-failed", "ChatGPT credentials could not be saved securely.");
		});
	}
	refreshCredentials(stored) {
		if (this.refreshPromise !== null) return this.refreshPromise;
		this.refreshPromise = this.performRefresh(stored).finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}
	async performRefresh(stored) {
		const response = await this.fetchFn(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: stored.refreshToken,
				client_id: CHATGPT_OAUTH_CLIENT_ID
			}).toString()
		}).catch(() => {
			throw new OAuthServiceError("refresh-failed", "ChatGPT token refresh could not be reached.");
		});
		if (!response.ok) {
			const detail = await oauthErrorIdentifier(response);
			if (response.status === 400 || response.status === 401) await this.store.clear().catch(() => {
				throw new OAuthServiceError("storage-failed", "Expired ChatGPT credentials could not be deleted securely.");
			});
			throw new OAuthServiceError("refresh-failed", `ChatGPT token refresh failed (${response.status}${detail === null ? "" : `, ${detail}`}). Sign in again.`);
		}
		const fresh = credentialsFromTokenResponse(await response.json(), this.now(), stored);
		await this.store.save(fresh).catch(() => {
			throw new OAuthServiceError("storage-failed", "Refreshed credentials could not be saved securely.");
		});
		this.logger.info("[dsh-chatgpt-subscription] OAuth credentials refreshed");
		return fresh;
	}
	async loadAuthenticated() {
		const stored = await this.store.load().catch(() => {
			throw new OAuthServiceError("storage-failed", "Secure credential storage could not be read.");
		});
		if (stored === null) throw new OAuthServiceError("not-authenticated", "Sign in with ChatGPT first.");
		return stored;
	}
	statusFromCredentials(credentials) {
		const active = this.activeLogin;
		if (credentials === null) return {
			authenticated: false,
			account: null,
			storage: {
				kind: "windows-dpapi",
				encrypted: true
			},
			login: {
				active: active !== null,
				loginId: active?.id ?? null,
				expiresAt: active === null ? null : Math.floor(active.expiresAt / 1e3)
			},
			...this.lastLoginError === void 0 ? {} : { error: this.lastLoginError }
		};
		const identity = extractIdentity(credentials);
		return {
			authenticated: true,
			account: {
				email: maskEmail(credentials.email ?? identity.email),
				planType: credentials.planType ?? identity.planType ?? null,
				accountIdSuffix: maskAccountId(credentials.accountId ?? identity.accountId),
				tokenExpiresAt: Math.floor(credentials.expiresAt / 1e3)
			},
			storage: {
				kind: "windows-dpapi",
				encrypted: true
			},
			login: {
				active: active !== null,
				loginId: active?.id ?? null,
				expiresAt: active === null ? null : Math.floor(active.expiresAt / 1e3)
			},
			...this.lastLoginError === void 0 ? {} : { error: this.lastLoginError }
		};
	}
	completeLogin(loginId) {
		if (this.activeLogin?.id !== loginId) return;
		clearTimeout(this.activeLogin.timeout);
		this.activeLogin = null;
		this.lastLoginError = void 0;
		this.publish({
			type: "completed",
			loginId
		});
		this.logger.info("[dsh-chatgpt-subscription] OAuth login completed");
	}
	failLogin(loginId, error) {
		if (this.activeLogin?.id !== loginId) return;
		clearTimeout(this.activeLogin.timeout);
		this.activeLogin = null;
		const mapped = publicError(error, "oauth-callback-invalid");
		this.lastLoginError = mapped;
		this.publish({
			type: "failed",
			loginId,
			error: mapped
		});
		this.logger.warn(`[dsh-chatgpt-subscription] OAuth login failed (${mapped.code}): ${mapped.message}`);
	}
	cancelActive(error, outcome) {
		const active = this.activeLogin;
		if (active === null) return;
		clearTimeout(active.timeout);
		this.activeLogin = null;
		active.server.cancel(error);
		this.publish(outcome === "cancelled" ? {
			type: "cancelled",
			loginId: active.id
		} : {
			type: "failed",
			loginId: active.id,
			error: publicError(error)
		});
	}
	publish(event) {
		this.loginEvents.set(event.loginId, event);
		for (const listener of this.listeners.get(event.loginId) ?? []) listener(event);
	}
	assertAvailable() {
		if (this.disposed) throw new OAuthServiceError("internal", "The OAuth service has been disposed.");
	}
};
function buildAuthorizationUrl(verifier, state) {
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return `${OAUTH_AUTHORIZE_URL}?${new URLSearchParams({
		response_type: "code",
		client_id: CHATGPT_OAUTH_CLIENT_ID,
		redirect_uri: OAUTH_REDIRECT_URI,
		scope: OAUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state,
		originator: OAUTH_ORIGINATOR
	}).toString()}`;
}
function parseJwtClaims(token) {
	if (token === void 0) return void 0;
	const parts = token.split(".");
	if (parts.length !== 3) return void 0;
	try {
		const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return typeof value === "object" && value !== null ? value : void 0;
	} catch {
		return;
	}
}
function publicError(error, fallback = "internal") {
	if (error instanceof OAuthServiceError) return {
		code: error.code,
		message: error.message
	};
	return {
		code: fallback,
		message: "The ChatGPT sign-in operation failed."
	};
}
function credentialsFromTokenResponse(response, now, previous) {
	if (typeof response.access_token !== "string" || response.access_token === "") throw new OAuthServiceError("oauth-token-exchange-failed", "ChatGPT returned no access token.");
	const refreshToken = typeof response.refresh_token === "string" && response.refresh_token !== "" ? response.refresh_token : previous?.refreshToken;
	if (refreshToken === void 0) throw new OAuthServiceError("oauth-token-exchange-failed", "ChatGPT returned no refresh token.");
	const seconds = Number(response.expires_in);
	const expiresIn = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
	const base = {
		accessToken: response.access_token,
		refreshToken,
		idToken: typeof response.id_token === "string" ? response.id_token : previous?.idToken,
		expiresAt: now + expiresIn * 1e3
	};
	const identity = extractIdentity(base);
	return {
		...base,
		accountId: identity.accountId ?? previous?.accountId,
		email: identity.email ?? previous?.email,
		planType: identity.planType ?? previous?.planType
	};
}
function extractIdentity(credentials) {
	const result = {};
	for (const token of [credentials.idToken, credentials.accessToken]) {
		const claims = parseJwtClaims(token);
		if (claims === void 0) continue;
		const nested = claims["https://api.openai.com/auth"];
		result.email ??= stringClaim(claims.email);
		result.planType ??= stringClaim(claims.chatgpt_plan_type) ?? stringClaim(nested?.chatgpt_plan_type);
		result.accountId ??= stringClaim(claims.chatgpt_account_id) ?? stringClaim(nested?.chatgpt_account_id) ?? stringClaim(claims.organizations?.[0]?.id) ?? stringClaim(nested?.organizations?.[0]?.id);
	}
	return result;
}
function stringClaim(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function maskEmail(email) {
	if (email === void 0) return null;
	const at = email.indexOf("@");
	if (at <= 0 || at === email.length - 1) return "***";
	return `${email.slice(0, 1)}***${email.slice(at)}`;
}
function maskAccountId(accountId) {
	if (accountId === void 0) return null;
	return `…${accountId.slice(-4)}`;
}
async function oauthErrorIdentifier(response) {
	const payload = await response.json().catch(() => null);
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const error = payload.error;
	const candidates = typeof error === "object" && error !== null && !Array.isArray(error) ? [error.code, error.type] : [error];
	for (const candidate of candidates) if (typeof candidate === "string" && /^[a-z0-9_.-]{1,64}$/i.test(candidate)) return candidate;
	return null;
}
//#endregion
//#region src/host/responses-mapper.ts
function hiddenSandboxControlToolNames(options) {
	const retryTools = recentSandboxRetryToolNames(options.messages);
	return new Set(options.tools?.filter((tool) => hasSandboxControls(tool.parameters) && !retryTools.has(tool.name)).map((tool) => tool.name) ?? []);
}
async function buildResponsesPayload(options, attachments) {
	const sandboxRetryTools = recentSandboxRetryToolNames(options.messages);
	const instructions = [
		options.system?.trim(),
		...options.messages.filter((message) => message.role === "system").map((message) => blocksToText(message.content).trim()),
		sandboxToolInstruction(options.tools, sandboxRetryTools),
		commandToolInstruction(options.tools),
		runCodeInstruction(options.tools)
	].filter((value) => Boolean(value));
	const input = [];
	const knownToolCalls = /* @__PURE__ */ new Map();
	for (const message of options.messages) {
		if (message.role === "system") continue;
		const replayItems = replayOutputItems(message);
		if (message.role === "assistant" && replayItems !== null) {
			input.push(...replayItems);
			for (const item of replayItems) if (item.type === "function_call" && typeof item.call_id === "string") knownToolCalls.set(item.call_id, typeof item.name === "string" ? item.name : void 0);
			if (!replayItems.some((item) => item.type === "message")) {
				const content = await mapContent(message, attachments, options.signal);
				if (content.length > 0) input.push({
					role: message.role,
					content
				});
			}
			appendMissingToolCalls(input, knownToolCalls, message);
			continue;
		}
		const toolResult = message.content.find((block) => block.type === "tool-result");
		if (toolResult?.type === "tool-result") {
			const callId = String(toolResult.toolCallId);
			const rawOutput = blocksToText(toolResult.content);
			if (knownToolCalls.has(callId)) {
				const output = toolResult.isError && knownToolCalls.get(callId) === "run_code" ? runCodeErrorOutput(rawOutput) : rawOutput;
				input.push({
					type: "function_call_output",
					call_id: callId,
					output
				});
			} else input.push({
				role: "user",
				content: [{
					type: "input_text",
					text: `Tool result for unavailable call ${callId}${toolResult.isError ? " (error)" : ""}:\n${rawOutput}`
				}]
			});
			continue;
		}
		const content = await mapContent(message, attachments, options.signal);
		if (content.length > 0) input.push({
			role: message.role,
			content
		});
		if (message.role === "assistant") appendMissingToolCalls(input, knownToolCalls, message);
	}
	const payload = {
		model: options.model,
		input,
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"]
	};
	if (instructions.length > 0) payload.instructions = instructions.join("\n\n");
	if (options.tools?.length) {
		payload.tools = options.tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: toolDescriptionForCodex(tool.name, tool.description),
			parameters: toolParametersForCodex(tool.name, tool.parameters, sandboxRetryTools.has(tool.name))
		}));
		payload.tool_choice = "auto";
		payload.parallel_tool_calls = true;
	}
	if (options.reasoningEffort !== void 0) payload.reasoning = {
		effort: options.reasoningEffort,
		summary: "auto"
	};
	return payload;
}
function runCodeInstruction(tools) {
	if (!tools?.some((tool) => tool.name === "run_code")) return void 0;
	return "run_code compatibility rule: its code is parsed as strict JavaScript/TypeScript before execution. On Windows, do not embed PowerShell containing $, ${...}, backslashes, or here-strings in JavaScript template literals; String.raw does not disable ${...} interpolation. Prefer arrays of ordinary quoted strings joined with \"\\n\", escaping backslashes, or use a file-write tool for large scripts and then invoke pwsh.";
}
function toolDescriptionForCodex(name, description) {
	if (name === "run_code") return `${description}\n\nCompatibility: code is strict JavaScript/TypeScript. When composing PowerShell, avoid JavaScript template literals containing $, \${...}, Windows backslashes, or PowerShell here-strings. Prefer ordinary quoted string arrays joined with "\\n", or write a script file with a dedicated file tool before invoking pwsh.`;
	if (isCommandTool(name)) return `${description}\n\n${commandToolCompatibilityText(name)}`;
	return description;
}
function commandToolInstruction(tools) {
	const names = tools?.filter((tool) => isCommandTool(tool.name)).map((tool) => tool.name);
	if (!names?.length) return void 0;
	return `Command tool compatibility rule (${[...new Set(names)].join(", ")}): each command call runs in a fresh process, so do not rely on cd, aliases, functions, or variables from previous calls; set workdir when the tool supports it. On Windows/pwsh, keep commands in native PowerShell syntax and native Windows paths. For deletion or move operations, first resolve and verify exact absolute target paths, then operate on those literal paths only; avoid dynamically deleting paths built from $HOME, wildcards, command substitution, or another shell's output. Treat [auto-mode hard deny] and similar policy denials as non-retriable; choose a safer non-destructive inspection or report the limitation instead of repeating the same command or adding sandbox escalation. If downloads fail with TLS credential or connection-closed errors, treat that as an environment/network failure and use local sources or report the limitation instead of cycling through equivalent download commands.`;
}
function commandToolCompatibilityText(name) {
	const shell = name.toLowerCase();
	return `Compatibility: command execution is stateless between calls.${shell === "pwsh" || shell.includes("powershell") ? " Use native PowerShell syntax and native Windows paths; prefer workdir over cd because every call starts a fresh process." : " Prefer workdir over cd because every call starts a fresh process."} For destructive operations, verify exact absolute targets first and use literal paths; policy hard-deny results require a safer command shape, not sandbox escalation.`;
}
function sandboxToolInstruction(tools, sandboxRetryTools) {
	if (!tools?.some((tool) => hasSandboxControls(tool.parameters))) return void 0;
	if (sandboxRetryTools.size === 0) return "Tool sandbox rule: this is not a sandbox-escalation retry. Omit sandbox_permissions and justification from every tool call. First run the tool with the session's current access.";
	return `Tool sandbox rule: sandbox_permissions and justification may only be used to retry the exact denied call for: ${[...sandboxRetryTools].join(", ")}. Omit both fields from every other tool call, and request a strictly wider mode with a non-empty justification sentence.`;
}
function toolParametersForCodex(toolName, parameters, allowSandboxRetry) {
	const hideSandboxControls = !allowSandboxRetry && hasSandboxControls(parameters);
	const augmentCommandTool = isCommandTool(toolName);
	if (!hideSandboxControls && toolName !== "run_code" && !augmentCommandTool) return parameters;
	const cloned = structuredClone(parameters);
	const properties = record$2(cloned.properties);
	if (properties !== null && hideSandboxControls) {
		delete properties.sandbox_permissions;
		delete properties.justification;
	}
	if (hideSandboxControls && Array.isArray(cloned.required)) cloned.required = cloned.required.filter((name) => name !== "sandbox_permissions" && name !== "justification");
	if (toolName === "run_code" && properties !== null) {
		const code = record$2(properties.code);
		if (code !== null) {
			const current = typeof code.description === "string" ? code.description.trim() : "";
			const compatibility = "Strict JavaScript/TypeScript source. For PowerShell on Windows, avoid JavaScript template literals containing $, ${...}, backslashes, or here-strings; String.raw still performs ${...} interpolation. Prefer ordinary quoted string arrays joined with \"\\n\" and escape backslashes, or write a script file with a dedicated file tool.";
			code.description = current ? `${current}\n\n${compatibility}` : compatibility;
		}
	}
	if (augmentCommandTool && properties !== null) {
		appendPropertyDescription(properties.command, "Single command for a fresh process; do not rely on state from earlier calls.");
		appendPropertyDescription(properties.workdir, "Use a native absolute working directory instead of embedding cd in the command.");
		appendPropertyDescription(properties.timeoutMs, "Positive finite timeout in milliseconds for bounded commands.");
		appendPropertyDescription(properties.run_in_background, "Use only for long-running servers or watchers whose output will be checked later.");
		appendPropertyDescription(properties.sandbox_permissions, "Only set when retrying the exact previous sandbox-denied call; it does not bypass hard-deny policy results.");
		appendPropertyDescription(properties.justification, "Required only for an allowed sandbox retry; explain why the wider access is needed.");
	}
	return cloned;
}
function appendPropertyDescription(value, addition) {
	const property = record$2(value);
	if (property === null) return;
	const current = typeof property.description === "string" ? property.description.trim() : "";
	if (current.includes(addition)) return;
	property.description = current ? `${current}\n\n${addition}` : addition;
}
function isCommandTool(name) {
	const normalized = name.toLowerCase();
	return normalized === "pwsh" || normalized === "powershell" || normalized === "bash" || normalized === "shell";
}
function hasSandboxControls(parameters) {
	const properties = record$2(parameters.properties);
	return properties !== null && ("sandbox_permissions" in properties || "justification" in properties);
}
function recentSandboxRetryToolNames(messages) {
	const deniedCallIds = /* @__PURE__ */ new Set();
	let assistant;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			assistant = message;
			break;
		}
		for (const block of message.content) {
			if (block.type !== "tool-result") continue;
			if (isSandboxDenial(blocksToText(block.content))) deniedCallIds.add(String(block.toolCallId));
		}
	}
	const result = /* @__PURE__ */ new Set();
	if (assistant === void 0 || deniedCallIds.size === 0) return result;
	for (const block of assistant.content) if (block.type === "tool-call" && deniedCallIds.has(String(block.id))) result.add(block.name);
	return result;
}
function isSandboxDenial(output) {
	return /\[sandbox:\s*file access denied\b/i.test(output) || /\bsandbox\b.*\b(?:access denied|denied access|EPERM)\b/i.test(output);
}
function appendMissingToolCalls(input, knownToolCalls, message) {
	for (const block of message.content) {
		if (block.type !== "tool-call") continue;
		const callId = String(block.id);
		if (knownToolCalls.has(callId)) continue;
		input.push({
			type: "function_call",
			call_id: callId,
			name: block.name,
			arguments: block.arguments
		});
		knownToolCalls.set(callId, block.name);
	}
}
function runCodeErrorOutput(output) {
	if (!isRunCodeParserError(output)) return output;
	return `${output}\n\nCompatibility hint: run_code failed while parsing strict JavaScript/TypeScript, before the nested tool ran. Avoid JavaScript template literals for PowerShell containing $, \${...}, Windows backslashes, or here-strings; String.raw does not prevent \${...} interpolation. Build the script from ordinary quoted strings joined with "\\n" (escaping backslashes), or write a script file with a dedicated file tool and then invoke pwsh.`;
}
function isRunCodeParserError(output) {
	return /(?:Legacy octal escape is not permitted in strict mode|Unexpected token|Invalid or unexpected token|Unterminated template|Expected ['"]?\}['"]?)/i.test(output);
}
async function mapContent(message, attachments, signal) {
	const result = [];
	for (const block of message.content) if (block.type === "text") result.push({
		type: message.role === "assistant" ? "output_text" : "input_text",
		text: block.text
	});
	else if (block.type === "image") {
		if (message.role !== "user") continue;
		result.push({
			type: "input_image",
			image_url: await imageDataUrl(block.attachment, attachments, signal)
		});
	}
	return result;
}
async function imageDataUrl(ref, attachments, signal) {
	const stored = await attachments.readImage(ref, signal);
	return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`;
}
function blocksToText(blocks) {
	return blocks.map((block) => {
		if (block.type === "text" || block.type === "reasoning") return block.text;
		if (block.type === "image") return `[image: ${block.attachment.name ?? block.attachment.attachmentId}]`;
		if (block.type === "tool-result") return blocksToText(block.content);
		return "";
	}).filter(Boolean).join("\n");
}
function replayOutputItems(message) {
	if (message.source.kind !== "model") return null;
	const replay = message.source.replayState;
	if (typeof replay !== "object" || replay === null || Array.isArray(replay)) return null;
	const items = replay.outputItems;
	if (!Array.isArray(items)) return null;
	return structuredClone(items.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item)));
}
function record$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
//#endregion
//#region src/host/wire-auth.ts
function codexHeaders(credentials, sessionId) {
	const dshAgent = attributionHeaders()["user-agent"] ?? "dsh/unknown";
	return {
		authorization: `Bearer ${credentials.accessToken}`,
		...credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {},
		originator: CODEX_ORIGINATOR,
		"user-agent": `dsh-chatgpt-subscription/${PLUGIN_VERSION} (${dshAgent})`,
		...sessionId ? { "session-id": sessionId } : {}
	};
}
function stableSessionId(value) {
	const source = value === void 0 || value === "" ? randomUUID() : value;
	return `dsh-${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}
function retryAfterMs(headers) {
	const raw = headers.get("retry-after");
	if (raw === null) return void 0;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1e3, 10 * 6e4);
	const timestamp = Date.parse(raw);
	if (!Number.isFinite(timestamp)) return void 0;
	return Math.min(Math.max(0, timestamp - Date.now()), 10 * 6e4);
}
//#endregion
//#region src/host/responses-client.ts
var ResponsesClient = class {
	oauth;
	attachments;
	fetchFn;
	onGenerationFinished;
	constructor(oauth, attachments, options = {}) {
		this.oauth = oauth;
		this.attachments = attachments;
		this.fetchFn = options.fetchFn ?? fetch;
		this.onGenerationFinished = options.onGenerationFinished ?? (() => void 0);
	}
	async *stream(options) {
		const payload = await buildResponsesPayload(options, this.attachments);
		const hiddenSandboxControls = hiddenSandboxControlToolNames(options);
		const sessionId = stableSessionId(options.sessionId);
		try {
			yield* parseResponsesStream(await this.send(payload, sessionId, options.signal), options.signal, hiddenSandboxControls);
		} finally {
			this.onGenerationFinished();
		}
	}
	async send(payload, sessionId, signal) {
		let credentials = await this.oauth.credentials();
		let response = await this.request(payload, credentials, sessionId, signal);
		if (response.status === 401) {
			await response.body?.cancel().catch(() => void 0);
			credentials = await this.oauth.credentials(true);
			response = await this.request(payload, credentials, sessionId, signal);
		}
		if (!response.ok) throw await responseError(response);
		return response;
	}
	async request(payload, credentials, sessionId, signal) {
		try {
			return await this.fetchFn(CODEX_RESPONSES_URL, {
				method: "POST",
				headers: {
					...codexHeaders(credentials, sessionId),
					"content-type": "application/json",
					accept: "text/event-stream"
				},
				body: JSON.stringify(payload),
				signal
			});
		} catch (cause) {
			if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
			throw new LlmError("Codex could not be reached.", "NETWORK", { cause });
		}
	}
};
async function* parseResponsesStream(response, signal, hiddenSandboxControls = /* @__PURE__ */ new Set()) {
	if (response.body === null) throw new LlmError("Codex returned no response stream.", "PROVIDER_ERROR");
	const reader = response.body.getReader();
	const abortReader = () => {
		reader.cancel(signal?.reason).catch(() => void 0);
	};
	signal?.addEventListener("abort", abortReader, { once: true });
	const decoder = new TextDecoder();
	let buffer = "";
	let nextIndex = 0;
	let textIndex = null;
	let reasoningIndex = null;
	let text = "";
	let reasoning = "";
	let terminal = null;
	let usage = null;
	let replayOutput = [];
	const tools = /* @__PURE__ */ new Map();
	const toolFor = (event, item) => {
		const itemId = string(event.item_id) ?? string(item?.id);
		const outputIndex = number(event.output_index);
		const key = itemId ?? (outputIndex === void 0 ? `tool-${tools.size}` : `index-${outputIndex}`);
		let tool = tools.get(key);
		if (tool === void 0) {
			tool = {
				index: nextIndex++,
				id: string(item?.call_id) ?? string(event.call_id) ?? `call_${key}`,
				itemId,
				name: string(item?.name) ?? string(event.name) ?? "",
				arguments: "",
				started: false
			};
			tools.set(key, tool);
		}
		return tool;
	};
	const consume = async function* (event) {
		const type = string(event.type);
		if (type === "response.output_text.delta" || type === "response.refusal.delta") {
			const delta = string(event.delta) ?? "";
			if (textIndex === null) {
				textIndex = nextIndex++;
				yield {
					type: "block-start",
					index: textIndex,
					blockType: "text"
				};
			}
			text += delta;
			if (delta) yield {
				type: "text-delta",
				index: textIndex,
				text: delta
			};
			return;
		}
		if (type === "response.reasoning_summary_text.delta") {
			const delta = string(event.delta) ?? "";
			if (reasoningIndex === null) {
				reasoningIndex = nextIndex++;
				yield {
					type: "block-start",
					index: reasoningIndex,
					blockType: "reasoning"
				};
			}
			reasoning += delta;
			if (delta) yield {
				type: "reasoning-delta",
				index: reasoningIndex,
				text: delta
			};
			return;
		}
		if (type === "response.output_item.added" || type === "response.output_item.done") {
			const item = record$1(event.item);
			if (item !== null && type === "response.output_item.done") replayOutput.push(structuredClone(item));
			if (string(item?.type) !== "function_call") return;
			const tool = toolFor(event, item ?? void 0);
			tool.id = string(item?.call_id) ?? tool.id;
			tool.name = string(item?.name) ?? tool.name;
			const initial = string(item?.arguments) ?? "";
			if (!tool.started) {
				tool.started = true;
				yield {
					type: "block-start",
					index: tool.index,
					blockType: "tool-call"
				};
				yield {
					type: "tool-call-delta",
					index: tool.index,
					id: CallId(tool.id),
					name: tool.name || void 0,
					argumentsDelta: initial
				};
				tool.arguments = initial;
			} else if (type === "response.output_item.done" && initial !== "") tool.arguments = initial;
			return;
		}
		if (type === "response.function_call_arguments.delta") {
			const tool = toolFor(event);
			const delta = string(event.delta) ?? "";
			if (!tool.started) {
				tool.started = true;
				yield {
					type: "block-start",
					index: tool.index,
					blockType: "tool-call"
				};
			}
			tool.arguments += delta;
			yield {
				type: "tool-call-delta",
				index: tool.index,
				id: CallId(tool.id),
				name: tool.name || void 0,
				argumentsDelta: delta
			};
			return;
		}
		if (type === "response.function_call_arguments.done") {
			const tool = toolFor(event);
			const finalArguments = string(event.arguments);
			if (finalArguments !== void 0) tool.arguments = finalArguments;
			return;
		}
		if (type === "response.completed" || type === "response.incomplete") {
			const completed = record$1(event.response);
			usage = mapUsage(record$1(completed?.usage));
			const output = completed?.output;
			if (Array.isArray(output)) replayOutput = output.filter((item) => record$1(item) !== null).map((item) => structuredClone(item));
			terminal = type === "response.incomplete" ? { kind: "max-tokens" } : { kind: "stop" };
			return;
		}
		if (type === "response.failed" || type === "error") {
			const error = record$1(event.error) ?? record$1(record$1(event.response)?.error);
			throw new LlmError(string(error?.message) ?? "Codex generation failed.", string(error?.code) ?? "PROVIDER_ERROR");
		}
	};
	try {
		while (true) {
			if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split(/\r?\n\r?\n/);
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
				if (data === "" || data === "[DONE]") continue;
				let event;
				try {
					event = JSON.parse(data);
				} catch {
					throw new LlmError("Codex returned malformed streaming JSON.", "PROTOCOL_ERROR");
				}
				const valueRecord = record$1(event);
				if (valueRecord !== null) yield* consume(valueRecord);
			}
		}
	} finally {
		signal?.removeEventListener("abort", abortReader);
		reader.releaseLock();
	}
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
	if (terminal === null) throw new LlmError("Codex stream ended before a terminal event.", "PROTOCOL_ERROR");
	if (reasoningIndex !== null) yield {
		type: "block-end",
		index: reasoningIndex,
		block: {
			type: "reasoning",
			text: reasoning
		}
	};
	if (textIndex !== null) yield {
		type: "block-end",
		index: textIndex,
		block: {
			type: "text",
			text
		}
	};
	for (const item of replayOutput) if (item.type === "function_call" && typeof item.name === "string" && hiddenSandboxControls.has(item.name) && typeof item.arguments === "string") item.arguments = stripSandboxControls(item.arguments);
	let validToolCount = 0;
	const replayedToolCallIds = new Set(replayOutput.flatMap((item) => item.type === "function_call" && typeof item.call_id === "string" ? [item.call_id] : []));
	for (const tool of tools.values()) {
		if (!tool.started) continue;
		if (hiddenSandboxControls.has(tool.name)) tool.arguments = stripSandboxControls(tool.arguments);
		if (!isSafeJsonArguments(tool.arguments) || tool.name === "") throw new LlmError(`Codex returned invalid JSON arguments for tool ${tool.name || "(unnamed)"}.`, "INVALID_TOOL_ARGUMENTS");
		validToolCount++;
		if (!replayedToolCallIds.has(tool.id)) {
			replayOutput.push({
				type: "function_call",
				call_id: tool.id,
				name: tool.name,
				arguments: tool.arguments
			});
			replayedToolCallIds.add(tool.id);
		}
		yield {
			type: "block-end",
			index: tool.index,
			block: {
				type: "tool-call",
				id: CallId(tool.id),
				name: tool.name,
				arguments: tool.arguments
			}
		};
	}
	if (usage !== null) yield {
		type: "usage",
		usage
	};
	yield {
		type: "finish",
		reason: validToolCount > 0 ? { kind: "tool-calls" } : terminal,
		replayState: { outputItems: replayOutput }
	};
}
function mapUsage(value) {
	if (value === null) return null;
	const totalInput = number(value.input_tokens) ?? 0;
	const outputTokens = number(value.output_tokens) ?? 0;
	const cached = number(record$1(value.input_tokens_details)?.cached_tokens) ?? 0;
	const reasoning = number(record$1(value.output_tokens_details)?.reasoning_tokens);
	return {
		inputTokens: Math.max(0, totalInput - cached),
		outputTokens,
		...cached > 0 ? { cacheReadTokens: cached } : {},
		...reasoning === void 0 ? {} : { reasoningTokens: reasoning }
	};
}
function isSafeJsonArguments(value) {
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}
function stripSandboxControls(value) {
	try {
		const parsedRecord = record$1(JSON.parse(value));
		if (parsedRecord === null) return value;
		let changed = false;
		for (const name of ["sandbox_permissions", "justification"]) if (name in parsedRecord) {
			delete parsedRecord[name];
			changed = true;
		}
		return changed ? JSON.stringify(parsedRecord) : value;
	} catch {
		return value;
	}
}
async function responseError(response) {
	const requestId = response.headers.get("x-request-id");
	const detail = (await response.text().catch(() => "")).slice(0, 500);
	const options = {
		status: response.status,
		...requestId ? { requestId: ProviderRequestId(requestId) } : {},
		...response.status === 429 ? { providerRetryAfterMs: retryAfterMs(response.headers) } : {}
	};
	if (response.status === 401) return new LlmError("ChatGPT sign-in has expired. Sign in again.", "AUTH", options);
	if (response.status === 429) return new LlmError("Codex rate limit reached.", "RATE_LIMIT", options);
	if (response.status >= 500) return new LlmError(`Codex service error (${response.status}).`, "SERVER_ERROR", options);
	return new LlmError(`Codex request failed (${response.status})${detail ? `: ${detail}` : "."}`, "PROVIDER_ERROR", options);
}
function record$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function string(value) {
	return typeof value === "string" ? value : void 0;
}
function number(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
//#endregion
//#region src/host/usage-service.ts
var UsageService = class {
	oauth;
	fetchFn;
	now;
	cache = null;
	lastUpstreamAt = 0;
	blockedUntil = 0;
	invalidated = false;
	inFlight = null;
	constructor(oauth, options = {}) {
		this.oauth = oauth;
		this.fetchFn = options.fetchFn ?? fetch;
		this.now = options.now ?? Date.now;
	}
	async status(authenticated, force = false) {
		if (!authenticated) return {
			state: "signed-out",
			buckets: [],
			fetchedAt: null,
			stale: false
		};
		const now = this.now();
		let credentials;
		try {
			credentials = await this.oauth.credentials();
		} catch {
			return this.failure({
				code: "quota-failed",
				message: "ChatGPT credentials could not be refreshed."
			});
		}
		const accountKey = identityKey(credentials);
		if (this.cache !== null && this.cache.accountKey !== accountKey) this.clear();
		if (!force && !this.invalidated && this.cache !== null && now - this.cache.fetchedAt < 6e4) return this.fromCache(false);
		if (this.cache !== null && now - this.lastUpstreamAt < 15e3) return this.fromCache(this.invalidated || now - this.cache.fetchedAt >= 6e4);
		if (now < this.blockedUntil) return this.failure({
			code: "rate-limited",
			message: "Quota refresh is temporarily rate limited."
		});
		if (this.inFlight !== null) return this.inFlight;
		this.inFlight = this.refreshUpstream(credentials, accountKey).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}
	invalidate() {
		this.invalidated = true;
	}
	clear() {
		this.cache = null;
		this.blockedUntil = 0;
		this.invalidated = false;
	}
	async testConnection() {
		const started = this.now();
		const result = await this.status(true, true);
		if (result.state === "error" || result.error !== void 0) throw new UsageServiceError(result.error ?? {
			code: "connection-failed",
			message: "Codex connection test failed."
		});
		return {
			connected: true,
			latencyMs: Math.max(0, this.now() - started),
			checkedAt: Math.floor(this.now() / 1e3)
		};
	}
	async refreshUpstream(initialCredentials, initialAccountKey) {
		this.lastUpstreamAt = this.now();
		try {
			let credentials = initialCredentials;
			let accountKey = initialAccountKey;
			let response = await this.fetch(credentials);
			if (response.status === 401) {
				await response.body?.cancel().catch(() => void 0);
				credentials = await this.oauth.credentials(true);
				accountKey = identityKey(credentials);
				response = await this.fetch(credentials);
			}
			if (response.status === 429) {
				const delay = retryAfterMs(response.headers) ?? 15e3;
				this.blockedUntil = this.now() + Math.max(QUOTA_MIN_UPSTREAM_INTERVAL_MS, delay);
				await response.body?.cancel().catch(() => void 0);
				return this.failure({
					code: "rate-limited",
					message: "Quota refresh was rate limited. Existing data was kept."
				});
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => void 0);
				return this.failure({
					code: "quota-failed",
					message: `Quota request failed (${response.status}).`
				});
			}
			const buckets = mapCodexUsage(await response.json());
			this.cache = {
				buckets,
				fetchedAt: this.now(),
				accountKey
			};
			this.invalidated = false;
			return this.fromCache(false);
		} catch (error) {
			const publicError = error instanceof UsageServiceError ? error.publicError : {
				code: "quota-failed",
				message: "Quota information could not be refreshed."
			};
			return this.failure(publicError);
		}
	}
	fetch(credentials) {
		return this.fetchFn(CODEX_USAGE_URL, { headers: {
			...codexHeaders(credentials),
			accept: "application/json"
		} });
	}
	fromCache(stale, error) {
		if (this.cache === null) return {
			state: error ? "error" : "empty",
			buckets: [],
			fetchedAt: null,
			stale,
			...error ? { error } : {}
		};
		return {
			state: error ? "stale" : this.cache.buckets.length > 0 ? "ready" : "empty",
			buckets: structuredClone(this.cache.buckets),
			fetchedAt: Math.floor(this.cache.fetchedAt / 1e3),
			stale,
			...error ? { error } : {}
		};
	}
	failure(error) {
		return this.fromCache(this.cache !== null, error);
	}
};
var UsageServiceError = class extends Error {
	publicError;
	constructor(publicError) {
		super(publicError.message);
		this.publicError = publicError;
	}
};
function mapCodexUsage(value) {
	const data = record(value);
	if (data === null) return [];
	const planType = typeof data.plan_type === "string" ? data.plan_type : null;
	const result = [];
	addBucket(result, "codex", "Codex", planType, data.rate_limit);
	addBucket(result, "code-review", "Code review", planType, data.code_review_rate_limit);
	return result;
}
function addBucket(result, id, name, planType, value) {
	const source = record(value);
	if (source === null) return;
	const primary = mapWindow(source.primary_window);
	const secondary = mapWindow(source.secondary_window);
	if (primary === null && secondary === null) return;
	result.push({
		id,
		name,
		planType,
		primary,
		secondary
	});
}
function mapWindow(value) {
	const data = record(value);
	if (data === null) return null;
	const used = numeric(data.used_percent);
	if (used === void 0) return null;
	const seconds = numeric(data.limit_window_seconds);
	const reset = numeric(data.reset_at);
	return {
		usedPercent: Math.min(100, Math.max(0, used)),
		windowDurationMins: seconds !== void 0 && seconds > 0 ? seconds / 60 : null,
		resetsAt: reset !== void 0 && reset > 0 ? reset : null
	};
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function numeric(value) {
	if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return void 0;
	const number = Number(value);
	return Number.isFinite(number) ? number : void 0;
}
function identityKey(credentials) {
	return credentials.accountId ?? credentials.email ?? credentials.planType ?? "signed-in";
}
//#endregion
//#region src/host/routes.ts
const MAX_BODY_BYTES = 64 * 1024;
function registerRoutes(ctx, oauth, usage) {
	const handler = async (request, response) => {
		const url = new URL(request.url ?? "/", "http://dsh.local");
		if (request.method === "GET" && url.pathname === `/api/dsh-chatgpt-subscription/status`) {
			const oauthStatus = await oauth.status();
			json(response, {
				ok: true,
				value: {
					...oauthStatus,
					quota: await usage.status(oauthStatus.authenticated)
				}
			});
			return;
		}
		if (request.method !== "POST") {
			jsonError(response, 405, {
				code: "bad-request",
				message: "Method not allowed."
			});
			return;
		}
		if (!isSameOriginMutation(request)) {
			jsonError(response, 403, {
				code: "csrf-rejected",
				message: "Cross-origin request rejected."
			});
			return;
		}
		const contentType = request.headers["content-type"];
		if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
			jsonError(response, 415, {
				code: "bad-request",
				message: "A JSON request body is required."
			});
			return;
		}
		const body = await readJson(request);
		if (body === null) {
			jsonError(response, 400, {
				code: "bad-request",
				message: "Malformed JSON request."
			});
			return;
		}
		try {
			switch (url.pathname) {
				case `${ROUTE_PREFIX}/login/start`:
					json(response, {
						ok: true,
						value: await oauth.startLogin()
					});
					return;
				case `${ROUTE_PREFIX}/login/cancel`: {
					const loginId = field(body, "loginId");
					if (loginId === null) throw new Error("missing loginId");
					oauth.cancelLogin(loginId);
					json(response, {
						ok: true,
						value: { cancelled: true }
					});
					return;
				}
				case `${ROUTE_PREFIX}/logout`:
					await oauth.logout();
					usage.clear();
					json(response, {
						ok: true,
						value: { authenticated: false }
					});
					return;
				case `${ROUTE_PREFIX}/token/refresh`: {
					const oauthStatus = await oauth.refresh();
					json(response, {
						ok: true,
						value: {
							...oauthStatus,
							quota: await usage.status(oauthStatus.authenticated)
						}
					});
					return;
				}
				case `${ROUTE_PREFIX}/quota/refresh`:
					if (!(await oauth.status()).authenticated) throw new Error("not authenticated");
					json(response, {
						ok: true,
						value: await usage.status(true, true)
					});
					return;
				case `${ROUTE_PREFIX}/connection/test`:
					json(response, {
						ok: true,
						value: await usage.testConnection()
					});
					return;
				default: jsonError(response, 404, {
					code: "bad-request",
					message: "Route not found."
				});
			}
		} catch (error) {
			const mapped = error instanceof UsageServiceError ? error.publicError : publicError(error, error instanceof Error && error.message === "missing loginId" ? "bad-request" : error instanceof Error && error.message === "not authenticated" ? "not-authenticated" : "internal");
			jsonError(response, statusFor(mapped), mapped);
		}
	};
	const events = (request, response) => {
		if (request.method !== "GET") {
			response.writeHead(405);
			response.end();
			return;
		}
		const loginId = new URL(request.url ?? "/", "http://dsh.local").searchParams.get("loginId");
		if (loginId === null || loginId === "") {
			jsonError(response, 400, {
				code: "bad-request",
				message: "loginId is required."
			});
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-content-type-options": "nosniff"
		});
		response.write("retry: 1000\n\n");
		let terminal = false;
		let heartbeat;
		let unsubscribe = null;
		const cleanup = () => {
			if (heartbeat !== void 0) clearInterval(heartbeat);
			unsubscribe?.();
			unsubscribe = null;
		};
		const send = (event) => {
			response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			if (event.type !== "pending") {
				terminal = true;
				queueMicrotask(() => {
					cleanup();
					response.end();
				});
			}
		};
		unsubscribe = oauth.subscribe(loginId, send);
		if (unsubscribe === null) {
			response.end("event: failed\ndata: {\"type\":\"failed\",\"error\":{\"code\":\"bad-request\",\"message\":\"Unknown loginId.\"}}\n\n");
			return;
		}
		if (terminal) {
			unsubscribe();
			response.end();
			return;
		}
		heartbeat = setInterval(() => response.write(": ping\n\n"), 15e3);
		request.once("close", cleanup);
	};
	const disposers = [ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler
	}), ctx.webServer.register({
		kind: "exact",
		path: `${ROUTE_PREFIX}/login/events`,
		handler: events
	})];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
function isSameOriginMutation(request) {
	const host = request.headers.host;
	const origin = request.headers.origin;
	if (typeof host !== "string" || host === "" || typeof origin !== "string" || origin === "") return false;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}
async function readJson(request) {
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return null;
		chunks.push(buffer);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}
function field(value, name) {
	const candidate = value[name];
	return typeof candidate === "string" && candidate !== "" ? candidate : null;
}
function json(response, envelope, status = 200) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	response.end(JSON.stringify(envelope));
}
function jsonError(response, status, error) {
	json(response, {
		ok: false,
		error
	}, status);
}
function statusFor(error) {
	if (error.code === "csrf-rejected") return 403;
	if (error.code === "not-authenticated") return 401;
	if (error.code === "rate-limited") return 429;
	if (error.code === "login-active") return 409;
	if (error.code === "bad-request") return 400;
	return 502;
}
//#endregion
//#region src/host/token-store.ts
function parseStoredCredentials(value) {
	if (typeof value !== "object" || value === null) throw new Error("credential bundle is not an object");
	const record = value;
	if (typeof record.accessToken !== "string" || record.accessToken === "") throw new Error("access token is missing");
	if (typeof record.refreshToken !== "string" || record.refreshToken === "") throw new Error("refresh token is missing");
	if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) throw new Error("expiry is invalid");
	const optional = (key) => {
		const candidate = record[key];
		if (candidate === void 0) return void 0;
		if (typeof candidate !== "string") throw new Error(`${key} is invalid`);
		return candidate;
	};
	return {
		accessToken: record.accessToken,
		refreshToken: record.refreshToken,
		expiresAt: record.expiresAt,
		idToken: optional("idToken"),
		accountId: optional("accountId"),
		email: optional("email"),
		planType: optional("planType")
	};
}
//#endregion
//#region src/host/token-store-windows.ts
const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:DSH_CODEX_TOKEN_PATH
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$directory = [IO.Path]::GetDirectoryName($path)
[IO.Directory]::CreateDirectory($directory) | Out-Null
$temporary = $path + '.tmp-' + [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllBytes($temporary, $cipher)
if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, $null) } else { [IO.File]::Move($temporary, $path) }
`;
const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:DSH_CODEX_TOKEN_PATH
if (-not [IO.File]::Exists($path)) { exit 3 }
$cipher = [IO.File]::ReadAllBytes($path)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;
const CLEAR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:DSH_CODEX_TOKEN_PATH
if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
`;
function defaultDpapiCredentialPath() {
	return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "storages", "dsh-chatgpt-subscription", "oauth.dpapi");
}
var WindowsDpapiTokenStore = class {
	path;
	constructor(path = defaultDpapiCredentialPath()) {
		this.path = path;
		if (process.platform !== "win32") throw new Error("Windows DPAPI storage requires Windows");
		if (dirname(path) === path) throw new Error("invalid DPAPI credential path");
	}
	async load() {
		const result = await runPowerShell(UNPROTECT_SCRIPT, this.path, "");
		if (result.code === 3) return null;
		if (result.code !== 0) throw new Error("DPAPI credential read failed");
		try {
			return parseStoredCredentials(JSON.parse(result.stdout));
		} catch {
			throw new Error("DPAPI credential payload is invalid");
		}
	}
	async save(value) {
		if ((await runPowerShell(PROTECT_SCRIPT, this.path, JSON.stringify(value))).code !== 0) throw new Error("DPAPI credential write failed");
	}
	async clear() {
		if ((await runPowerShell(CLEAR_SCRIPT, this.path, "")).code !== 0) throw new Error("DPAPI credential deletion failed");
	}
};
function runPowerShell(script, path, stdin) {
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			script
		], {
			env: {
				...process.env,
				DSH_CODEX_TOKEN_PATH: path
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let stdout = "";
		let stderrLength = 0;
		const timer = setTimeout(() => {
			child.kill();
			reject(/* @__PURE__ */ new Error("DPAPI helper timed out"));
		}, 1e4);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 1 << 20) child.kill();
		});
		child.stderr.on("data", (chunk) => {
			stderrLength += chunk.length;
			if (stderrLength > 1 << 20) child.kill();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({
				code: code ?? 1,
				stdout
			});
		});
		child.stdin.end(stdin);
	});
}
//#endregion
//#region src/index.ts
const inject = [
	"webServer",
	"llm",
	"attachments"
];
function apply(ctx) {
	const oauth = new OAuthService(new WindowsDpapiTokenStore(), { logger: ctx.logger });
	const usage = new UsageService(oauth);
	const adapter = new CodexChatGptAdapter(new ResponsesClient(oauth, ctx.attachments, { onGenerationFinished: () => usage.invalidate() }));
	ctx.effect(() => {
		const disposeRoutes = registerRoutes(ctx, oauth, usage);
		const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
		return () => {
			disposeAdapter();
			disposeRoutes();
			oauth.dispose();
		};
	}, "dsh-chatgpt-subscription: adapter, routes, and lifecycle");
}
//#endregion
export { CodexChatGptAdapter, OAuthService, ResponsesClient, UsageService, apply, inject, mapCodexUsage, parseResponsesStream };
