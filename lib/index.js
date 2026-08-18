import { createRequire } from "node:module";
import { CallId, LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, attributionHeaders, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http, { createServer } from "node:http";
import { constants, readFileSync } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import * as http2 from "node:http2";
//#region src/host/model-catalog.ts
const PROVIDER_ID$8 = "codex-chatgpt";
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
		provider: PROVIDER_ID$8,
		id,
		name: id,
		inputModalities: ["text", "image"]
	}));
}
function resolveCodexModel(model) {
	const reasoning = MODEL_REASONING[model] ?? MODEL_REASONING["gpt-5.6-sol"];
	return {
		provider: PROVIDER_ID$8,
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
const RETRY_POLICY$1 = resolveRetryPolicy({
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
		return RETRY_POLICY$1;
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
//#region src/host/subagent-report-scheduling-compat.ts
/**
* DSH_COMPAT_REMOVE(subagent-report-settlement-dedup)
*
* Temporary compatibility shim for DSH 0.1.0-rc.6. A continuable child is told
* to report its result before finishing, while DSH also unconditionally sends
* the same closing output in a `subagent-settled` notice. The report is often
* still queued when the settlement reaches the parent, so the parent sees the
* result once and the equivalent report remains as duplicate next-turn work.
*
* Remove this module, its installation in `src/index.ts`, and its focused test
* once upstream coalesces an equivalent final report with settlement delivery.
*/
const DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER = "__dshChatgptSubscriptionSubagentReportDedupCompatV1";
function sourceOf(message) {
	return message.source;
}
function isTextBlock(value, text) {
	return typeof value === "object" && value !== null && value.type === "text" && value.text === text;
}
function sameValue(left, right) {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	const leftRecord = left;
	const rightRecord = right;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]));
}
function duplicatePendingReports(agent, settlement) {
	const settlementSource = sourceOf(settlement);
	if (settlementSource.kind !== "subagent-settled" || settlementSource.senderSessionId === void 0) return [];
	if (settlement.content.length < 2 || !isTextBlock(settlement.content[1], "Its closing message:")) return [];
	const closingContent = settlement.content.slice(2);
	return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter((pending) => {
		const pendingSource = sourceOf(pending);
		return pendingSource.kind === "subagent-report" && pendingSource.senderSessionId === settlementSource.senderSessionId && sameValue(pending.content.slice(1), closingContent);
	});
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Discard only an exact, same-child report duplicate immediately before DSH
* delivers the corresponding settlement notice. Partial reports, reports with
* different content, and all unrelated inbox work remain untouched.
*/
function installSubagentReportDedupCompat(ctx) {
	const patches = /* @__PURE__ */ new Map();
	const patch = (agent) => {
		if (patches.has(agent)) return;
		const shared = agent.followup[DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER];
		if (shared?.wrappers.followup === agent.followup && shared.wrappers.steer === agent.steer && shared.wrappers.inject === agent.inject) {
			shared.owners += 1;
			patches.set(agent, shared);
			return;
		}
		const originals = {
			followup: agent.followup,
			steer: agent.steer,
			inject: agent.inject
		};
		let record;
		const deliver = (name, message) => {
			for (const duplicate of duplicatePendingReports(agent, message)) try {
				agent.inbox.remove(duplicate.id);
			} catch (error) {
				ctx.logger.warn("[dsh-chatgpt-subscription] Could not discard a duplicate DSH subagent report: " + errorMessage(error));
			}
			originals[name].call(agent, message);
		};
		const wrappers = {
			followup(message) {
				deliver("followup", message);
			},
			steer(message) {
				deliver("steer", message);
			},
			inject(message) {
				deliver("inject", message);
			}
		};
		record = {
			originals,
			wrappers,
			owners: 1
		};
		for (const wrapper of Object.values(wrappers)) Object.defineProperty(wrapper, DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER, { value: record });
		try {
			agent.followup = wrappers.followup;
			agent.steer = wrappers.steer;
			agent.inject = wrappers.inject;
			patches.set(agent, record);
		} catch (error) {
			record.owners = 0;
			for (const name of [
				"followup",
				"steer",
				"inject"
			]) if (agent[name] === wrappers[name]) try {
				agent[name] = originals[name];
			} catch {}
			ctx.logger.warn("[dsh-chatgpt-subscription] Could not install temporary DSH subagent dedup compatibility: " + errorMessage(error));
		}
	};
	const unpatch = (agent) => {
		const record = patches.get(agent);
		if (!record) return;
		patches.delete(agent);
		record.owners -= 1;
		if (record.owners > 0) return;
		for (const name of [
			"followup",
			"steer",
			"inject"
		]) {
			if (agent[name] !== record.wrappers[name]) continue;
			try {
				agent[name] = record.originals[name];
			} catch (error) {
				ctx.logger.warn("[dsh-chatgpt-subscription] Could not remove temporary DSH subagent dedup compatibility: " + errorMessage(error));
			}
		}
	};
	for (const agent of ctx.agents.list()) patch(agent);
	const disposeCreated = ctx.on("agent/created", ({ agent }) => patch(agent));
	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => unpatch(agent));
	return () => {
		disposeDisposed();
		disposeCreated();
		for (const agent of [...patches.keys()]) unpatch(agent);
	};
}
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
				...this.statusFromCredentials(null, false),
				error: publicError(new OAuthServiceError("storage-failed", "Secure credential storage could not be read."))
			};
		}
	}
	async startLogin() {
		this.assertAvailable();
		await this.store.load().catch(() => {
			throw new OAuthServiceError("storage-failed", "Secure credential storage is unavailable. Fix its ownership or permissions before signing in.");
		});
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
	statusFromCredentials(credentials, storageAvailable = true) {
		const active = this.activeLogin;
		if (credentials === null) return {
			authenticated: false,
			account: null,
			storage: {
				...this.store.storage,
				available: storageAvailable
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
				email: maskEmail$1(credentials.email ?? identity.email),
				planType: credentials.planType ?? identity.planType ?? null,
				accountIdSuffix: maskAccountId(credentials.accountId ?? identity.accountId),
				tokenExpiresAt: Math.floor(credentials.expiresAt / 1e3)
			},
			storage: {
				...this.store.storage,
				available: storageAvailable
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
function maskEmail$1(email) {
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
async function buildResponsesPayload(options, attachments, localRawImages = {}) {
	const sandboxRetryTools = recentSandboxRetryToolNames(options.messages);
	const resolveLocalRawImages = supportsImageInput(options);
	const instructionParts = [
		options.system?.trim(),
		...options.messages.filter((message) => message.role === "system").map((message) => blocksToText(message.content).trim()),
		sandboxToolInstruction(options.tools, sandboxRetryTools),
		commandToolInstruction(options.tools),
		runCodeInstruction(options.tools)
	].filter((value) => Boolean(value));
	const input = [];
	const knownToolCalls = /* @__PURE__ */ new Map();
	const localImageStats = {
		attempted: 0,
		resolved: 0,
		failed: 0
	};
	for (const message of options.messages) {
		if (message.role === "system") continue;
		const replayItems = replayOutputItems(message);
		if (message.role === "assistant" && replayItems !== null) {
			input.push(...replayItems);
			for (const item of replayItems) if (item.type === "function_call" && typeof item.call_id === "string") knownToolCalls.set(item.call_id, typeof item.name === "string" ? item.name : void 0);
			if (!replayItems.some((item) => item.type === "message")) {
				const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages);
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
		const content = await mapContent(message, attachments, options.signal, localRawImages, localImageStats, resolveLocalRawImages);
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
	const instructions = [...instructionParts, localRawImageInstruction(localImageStats)].filter((value) => Boolean(value));
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
	return "run_code compatibility rule: its code is parsed as strict JavaScript/TypeScript before execution. Shell commands are nested string data: JavaScript template literals may consume ${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them. On Windows, avoid embedding PowerShell containing $, ${...}, backslashes, or here-strings in template literals; String.raw does not disable ${...} interpolation. On Linux, prefer ordinary quoted strings or write a script file before invoking bash/sh, especially for commands containing backticks or ${...}. Prefer arrays of ordinary quoted strings joined with \"\\n\", escaping backslashes, or use a file-write tool for large scripts.";
}
function localRawImageInstruction(stats) {
	if (stats.failed === 0) return void 0;
	return "Image attachment rule: a user message contains a markdown image link to a local/raw session URL but no structured image attachment. That link is not accessible image bytes for the provider. Do not claim to see the image; ask the user to resend it as an actual image attachment if visual inspection is required.";
}
function supportsImageInput(options) {
	return options.provider === "codex-chatgpt" && options.model.toLowerCase().startsWith("gpt-");
}
function toolDescriptionForCodex(name, description) {
	if (name === "run_code") return `${description}\n\nCompatibility: code is strict JavaScript/TypeScript and nested shell commands are string data. Template literals may consume \${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them. Prefer ordinary quoted string arrays joined with "\\n", or write a script file with a dedicated file tool before invoking the shell.`;
	if (isCommandTool(name)) return `${description}\n\n${commandToolCompatibilityText(name)}`;
	return description;
}
function commandToolInstruction(tools) {
	const names = tools?.filter((tool) => isCommandTool(tool.name)).map((tool) => tool.name);
	if (!names?.length) return void 0;
	const uniqueNames = [...new Set(names)];
	const normalized = uniqueNames.map((name) => name.toLowerCase());
	const shellGuidance = [
		normalized.some((name) => name === "pwsh" || name.includes("powershell")) ? "For pwsh/PowerShell, use native PowerShell syntax and native Windows paths." : void 0,
		normalized.includes("bash") ? "For bash, use native POSIX paths and Bash syntax in a fresh non-interactive process." : void 0,
		normalized.some((name) => name === "sh" || name === "shell") ? "For sh/generic shell, prefer portable POSIX syntax and avoid Bash-only arrays, [[ ... ]], process substitution, and source." : void 0
	].filter((value) => value !== void 0).join(" ");
	return `Command tool compatibility rule (${uniqueNames.join(", ")}): each command call runs in a fresh process, so do not rely on cd, aliases, functions, or variables from previous calls; set workdir when the tool supports it. ${shellGuidance} For deletion or move operations, first resolve and verify exact absolute target paths, then operate on those literal paths only; avoid dynamically deleting paths built from home-directory expansion, wildcards, command substitution, or another shell's output. Treat [auto-mode hard deny] and similar policy denials as non-retriable; choose a safer non-destructive inspection or report the limitation instead of repeating the same command or adding sandbox escalation. If downloads fail with TLS credential or connection-closed errors, treat that as an environment/network failure and use local sources or report the limitation instead of cycling through equivalent download commands.`;
}
function commandToolCompatibilityText(name) {
	const shell = name.toLowerCase();
	return `Compatibility: command execution is stateless between calls.${shell === "pwsh" || shell.includes("powershell") ? " Use native PowerShell syntax and native Windows paths." : shell === "bash" ? " Use Bash syntax and native POSIX paths." : " Use portable POSIX syntax and native POSIX paths; avoid Bash-only arrays, [[ ... ]], process substitution, and source."} Prefer workdir over cd because every call starts a fresh process. For destructive operations, verify exact absolute targets first and use literal paths; policy hard-deny results require a safer command shape, not sandbox escalation.`;
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
			const compatibility = "Strict JavaScript/TypeScript source. Nested shell commands are string data: template literals may consume ${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them; String.raw still performs ${...} interpolation. Prefer ordinary quoted string arrays joined with \"\\n\", or write a script file with a dedicated file tool.";
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
	return normalized === "pwsh" || normalized === "powershell" || normalized === "bash" || normalized === "sh" || normalized === "shell";
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
	return `${output}\n\nCompatibility hint: run_code failed while parsing strict JavaScript/TypeScript, before the nested tool ran. Shell commands are nested string data; template literals can consume \${...}, backticks, backslashes, and escape sequences before PowerShell, Bash, or POSIX sh sees them, and String.raw does not prevent \${...} interpolation. Build the script from ordinary quoted strings joined with "\\n", or write a script file with a dedicated file tool and then invoke the shell.`;
}
function isRunCodeParserError(output) {
	return /(?:Legacy octal escape is not permitted in strict mode|Unexpected token|Invalid or unexpected token|Unterminated template|Expected ['"]?\}['"]?)/i.test(output);
}
async function mapContent(message, attachments, signal, localRawImages, localImageStats, resolveLocalRawImages) {
	const result = [];
	for (const block of message.content) if (block.type === "text") if (message.role === "user") result.push(...await mapUserText(block.text, attachments, signal, localRawImages, localImageStats, resolveLocalRawImages));
	else result.push({
		type: "output_text",
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
async function mapUserText(text, attachments, signal, localRawImages, localImageStats, resolveLocalRawImages) {
	const links = markdownImageLinks(text);
	if (links.length === 0) return [{
		type: "input_text",
		text
	}];
	if (!resolveLocalRawImages) {
		localImageStats.failed += links.length;
		return [{
			type: "input_text",
			text
		}];
	}
	const result = [];
	let cursor = 0;
	for (const match of links) {
		if (match.start > cursor) pushInputText(result, text.slice(cursor, match.start));
		localImageStats.attempted++;
		const image = await localRawImageDataUrl(match.url, localRawImages, attachments.imageLimits?.maxImageBytes, signal);
		if (image === null) {
			localImageStats.failed++;
			pushInputText(result, text.slice(match.start, match.end));
		} else {
			localImageStats.resolved++;
			result.push({
				type: "input_image",
				image_url: image
			});
		}
		cursor = match.end;
	}
	if (cursor < text.length) pushInputText(result, text.slice(cursor));
	return result.length > 0 ? result : [{
		type: "input_text",
		text
	}];
}
function pushInputText(content, text) {
	if (text === "") return;
	const previous = content.at(-1);
	if (previous?.type === "input_text" && typeof previous.text === "string") previous.text += text;
	else content.push({
		type: "input_text",
		text
	});
}
function markdownImageLinks(text) {
	const links = [];
	for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/gi)) {
		const url = match[1];
		if (match.index === void 0 || !isLocalRawImageReference(url)) continue;
		links.push({
			start: match.index,
			end: match.index + match[0].length,
			url
		});
	}
	return links;
}
async function localRawImageDataUrl(rawUrl, options, maxBytes, signal) {
	const url = localRawImageUrl(rawUrl, options.baseUrl);
	if (url === null) return null;
	let response;
	try {
		response = await (options.fetchFn ?? fetch)(url, {
			signal,
			redirect: "error"
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const contentLength = Number(response.headers.get("content-length") ?? NaN);
	if (maxBytes !== void 0 && Number.isFinite(contentLength) && contentLength > maxBytes) return null;
	let bytes;
	try {
		bytes = new Uint8Array(await response.arrayBuffer());
	} catch {
		return null;
	}
	if (maxBytes !== void 0 && bytes.byteLength > maxBytes) return null;
	const mediaType = supportedImageMediaType(response.headers.get("content-type")) ?? sniffImageMediaType(bytes);
	if (mediaType === null) return null;
	return bytesToDataUrl(mediaType, bytes);
}
function localRawImageUrl(rawUrl, baseUrl) {
	if (!isLocalRawImageReference(rawUrl)) return null;
	try {
		const url = rawUrl.startsWith("/") ? baseUrl === void 0 ? null : new URL(rawUrl, baseUrl) : new URL(rawUrl);
		if (url === null || !isLoopbackHost(url.hostname)) return null;
		return url.toString();
	} catch {
		return null;
	}
}
function isLocalRawImageReference(url) {
	return /(?:^|\/)raw\/sha256:[a-f0-9]{32,}/i.test(url);
}
function isLoopbackHost(hostname) {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}
function supportedImageMediaType(value) {
	const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
	if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/webp" || mediaType === "image/gif") return mediaType;
	return null;
}
function sniffImageMediaType(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
	if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
	return null;
}
function ascii(bytes, start, end) {
	return String.fromCharCode(...bytes.slice(start, end));
}
async function imageDataUrl(ref, attachments, signal) {
	const stored = await attachments.readImage(ref, signal);
	return bytesToDataUrl(stored.ref.mediaType, stored.data);
}
function bytesToDataUrl(mediaType, data) {
	return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
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
	const envelope = replay;
	const items = Array.isArray(envelope.outputItems) ? envelope.outputItems : Array.isArray(record$2(envelope.response)?.outputItems) ? record$2(envelope.response).outputItems : null;
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
const MAX_VISIBLE_REASONING_CHARS = 12e3;
const REASONING_DELTA_FLUSH_CHARS = 768;
const REASONING_TRUNCATED_NOTICE = "\n\n[Reasoning summary truncated to keep the DSH web UI responsive.]";
var ResponsesClient = class {
	oauth;
	attachments;
	fetchFn;
	onGenerationFinished;
	constructor(oauth, attachments, options = {}) {
		this.oauth = oauth;
		this.attachments = attachments;
		this.fetchFn = options.fetchFn ?? fetch;
		this.localRawImages = options.localRawImages ?? {};
		this.onGenerationFinished = options.onGenerationFinished ?? (() => void 0);
	}
	localRawImages;
	async *stream(options) {
		const payload = await buildResponsesPayload(options, this.attachments, this.localRawImages);
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
	let pendingReasoningDelta = "";
	let reasoningTruncated = false;
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
			const visibleDelta = visibleReasoningDelta(delta, reasoning.length, reasoningTruncated);
			reasoningTruncated ||= visibleDelta.truncated;
			if (visibleDelta.text !== "") {
				reasoning += visibleDelta.text;
				pendingReasoningDelta += visibleDelta.text;
			}
			if (pendingReasoningDelta.length >= REASONING_DELTA_FLUSH_CHARS) {
				yield {
					type: "reasoning-delta",
					index: reasoningIndex,
					text: pendingReasoningDelta
				};
				pendingReasoningDelta = "";
			}
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
	if (reasoningIndex !== null) {
		if (pendingReasoningDelta !== "") {
			yield {
				type: "reasoning-delta",
				index: reasoningIndex,
				text: pendingReasoningDelta
			};
			pendingReasoningDelta = "";
		}
		yield {
			type: "block-end",
			index: reasoningIndex,
			block: {
				type: "reasoning",
				text: reasoning
			}
		};
	}
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
function visibleReasoningDelta(delta, currentVisibleChars, alreadyTruncated) {
	if (delta === "" || alreadyTruncated) return {
		text: "",
		truncated: alreadyTruncated
	};
	const remaining = MAX_VISIBLE_REASONING_CHARS - currentVisibleChars;
	if (remaining <= 0) return {
		text: REASONING_TRUNCATED_NOTICE,
		truncated: true
	};
	if (delta.length <= remaining) return {
		text: delta,
		truncated: false
	};
	return {
		text: `${delta.slice(0, remaining)}${REASONING_TRUNCATED_NOTICE}`,
		truncated: true
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
const MAX_BODY_BYTES$1 = 64 * 1024;
function registerRoutes(ctx, oauth, usage) {
	const handler = async (request, response) => {
		const url = new URL(request.url ?? "/", "http://dsh.local");
		if (request.method === "GET" && url.pathname === `/api/dsh-chatgpt-subscription/status`) {
			const oauthStatus = await oauth.status();
			json$1(response, {
				ok: true,
				value: {
					...oauthStatus,
					quota: await usage.status(oauthStatus.authenticated)
				}
			});
			return;
		}
		if (request.method !== "POST") {
			jsonError$1(response, 405, {
				code: "bad-request",
				message: "Method not allowed."
			});
			return;
		}
		if (!isSameOriginMutation$1(request)) {
			jsonError$1(response, 403, {
				code: "csrf-rejected",
				message: "Cross-origin request rejected."
			});
			return;
		}
		const contentType = request.headers["content-type"];
		if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
			jsonError$1(response, 415, {
				code: "bad-request",
				message: "A JSON request body is required."
			});
			return;
		}
		const body = await readJson$1(request);
		if (body === null) {
			jsonError$1(response, 400, {
				code: "bad-request",
				message: "Malformed JSON request."
			});
			return;
		}
		try {
			switch (url.pathname) {
				case `${ROUTE_PREFIX}/login/start`:
					json$1(response, {
						ok: true,
						value: await oauth.startLogin()
					});
					return;
				case `${ROUTE_PREFIX}/login/cancel`: {
					const loginId = field(body, "loginId");
					if (loginId === null) throw new Error("missing loginId");
					oauth.cancelLogin(loginId);
					json$1(response, {
						ok: true,
						value: { cancelled: true }
					});
					return;
				}
				case `${ROUTE_PREFIX}/logout`:
					await oauth.logout();
					usage.clear();
					json$1(response, {
						ok: true,
						value: { authenticated: false }
					});
					return;
				case `${ROUTE_PREFIX}/token/refresh`: {
					const oauthStatus = await oauth.refresh();
					json$1(response, {
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
					json$1(response, {
						ok: true,
						value: await usage.status(true, true)
					});
					return;
				case `${ROUTE_PREFIX}/connection/test`:
					json$1(response, {
						ok: true,
						value: await usage.testConnection()
					});
					return;
				default: jsonError$1(response, 404, {
					code: "bad-request",
					message: "Route not found."
				});
			}
		} catch (error) {
			const mapped = error instanceof UsageServiceError ? error.publicError : publicError(error, error instanceof Error && error.message === "missing loginId" ? "bad-request" : error instanceof Error && error.message === "not authenticated" ? "not-authenticated" : "internal");
			jsonError$1(response, statusFor(mapped), mapped);
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
			jsonError$1(response, 400, {
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
function isSameOriginMutation$1(request) {
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
async function readJson$1(request) {
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES$1) return null;
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
function json$1(response, envelope, status = 200) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	});
	response.end(JSON.stringify(envelope));
}
function jsonError$1(response, status, error) {
	json$1(response, {
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
		planType: optional("planType"),
		providerSecrets: record.providerSecrets === void 0 ? void 0 : parseProviderSecrets(record.providerSecrets)
	};
}
function parseProviderSecrets(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("providerSecrets is invalid");
	return structuredClone(value);
}
//#endregion
//#region src/host/token-store-linux.ts
const DIRECTORY_MODE = 448;
const FILE_MODE = 384;
function defaultLinuxCredentialPath(namespace = "codex") {
	return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "storages", "dsh-chatgpt-subscription", namespace === "codex" ? "oauth.json" : "providers.json.secrets");
}
/**
* Linux credential storage protected by owner-only filesystem permissions.
* The payload is not encrypted at rest, so callers must report that distinction
* instead of presenting this store as equivalent to Windows DPAPI.
*/
var LinuxFileTokenStore = class {
	storage = {
		kind: "linux-file",
		encrypted: false
	};
	noFollow = constants.O_NOFOLLOW;
	path;
	constructor(path = void 0, namespace = "codex") {
		this.path = path ?? defaultLinuxCredentialPath(namespace);
		if (process.platform !== "linux") throw new Error("Linux credential storage requires Linux");
		if (this.noFollow === void 0) throw new Error("Linux credential storage requires O_NOFOLLOW support");
		if (dirname(this.path) === this.path) throw new Error("invalid Linux credential path");
	}
	async load() {
		let handle;
		try {
			handle = await open(this.path, constants.O_RDONLY | this.noFollow);
		} catch (error) {
			if (isMissing(error)) return null;
			throw new Error("Linux credential read failed", { cause: error });
		}
		try {
			const stats = await handle.stat();
			if (!stats.isFile()) throw new Error("credential path is not a regular file");
			if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("credential file is owned by another user");
			if ((stats.mode & 511) !== FILE_MODE) throw new Error("credential file permissions must be 0600");
			const payload = await handle.readFile({ encoding: "utf8" });
			return parseStoredCredentials(JSON.parse(payload));
		} catch (error) {
			throw new Error("Linux credential payload is invalid or insecure", { cause: error });
		} finally {
			await handle.close();
		}
	}
	async save(value) {
		const directory = dirname(this.path);
		const temporary = `${this.path}.tmp-${randomUUID()}`;
		try {
			const existing = await lstat(this.path);
			if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("credential path is not a regular file");
			assertOwnedByCurrentUser(existing.uid, "credential file");
		} catch (error) {
			if (!isMissing(error)) throw new Error("Linux credential write failed", { cause: error });
		}
		await mkdir(directory, {
			recursive: true,
			mode: DIRECTORY_MODE
		});
		const directoryStats = await stat(directory);
		if (!directoryStats.isDirectory()) throw new Error("Linux credential directory is invalid");
		assertOwnedByCurrentUser(directoryStats.uid, "credential directory");
		await chmod(directory, DIRECTORY_MODE);
		let handle;
		try {
			handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
			await handle.writeFile(JSON.stringify(value), { encoding: "utf8" });
			await handle.sync();
			await handle.close();
			handle = void 0;
			await rename(temporary, this.path);
			await chmod(this.path, FILE_MODE);
		} catch (error) {
			await handle?.close().catch(() => void 0);
			await unlink(temporary).catch(() => void 0);
			throw new Error("Linux credential write failed", { cause: error });
		}
	}
	async clear() {
		try {
			await unlink(this.path);
		} catch (error) {
			if (isMissing(error)) return;
			throw new Error("Linux credential deletion failed", { cause: error });
		}
	}
};
function assertOwnedByCurrentUser(owner, label) {
	if (typeof process.getuid === "function" && owner !== process.getuid()) throw new Error(`${label} is owned by another user`);
}
function isMissing(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
function defaultDpapiCredentialPath(namespace = "codex") {
	return join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "storages", "dsh-chatgpt-subscription", namespace === "codex" ? "oauth.dpapi" : "providers.dpapi");
}
var WindowsDpapiTokenStore = class {
	storage = {
		kind: "windows-dpapi",
		encrypted: true
	};
	path;
	constructor(path = void 0, namespace = "codex") {
		this.path = path ?? defaultDpapiCredentialPath(namespace);
		if (process.platform !== "win32") throw new Error("Windows DPAPI storage requires Windows");
		if (dirname(this.path) === this.path) throw new Error("invalid DPAPI credential path");
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
//#region src/host/platform-token-store.ts
function createPlatformTokenStore(platform = process.platform, namespace = "codex") {
	if (platform === "win32") return new WindowsDpapiTokenStore(void 0, namespace);
	if (platform === "linux") return new LinuxFileTokenStore(void 0, namespace);
	throw new Error(`Unsupported platform ${platform}; dsh-chatgpt-subscription supports Windows and Linux.`);
}
//#endregion
//#region src/host/multi-provider-adapter.ts
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
}, "dsh-subscription-providers.retry");
var MultiProviderAdapter = class extends LlmAdapter {
	providersRuntime;
	constructor(providersRuntime) {
		super();
		this.providersRuntime = providersRuntime;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.providersRuntime.providerName(provider)
		};
	}
	providerRetryPolicy() {
		return RETRY_POLICY;
	}
	listModels(provider) {
		return this.providersRuntime.listModels(provider);
	}
	resolveModel(provider, model) {
		return this.providersRuntime.resolveModel(provider, model);
	}
	stream(options) {
		return this.providersRuntime.stream(options);
	}
};
//#endregion
//#region vendor/dockyard/packages/core/src/errors.mjs
var DockyardError = class extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = "DockyardError";
		this.code = code;
		this.details = details;
	}
};
var ValidationError = class extends DockyardError {
	constructor(message, details = {}) {
		super("validation_error", message, details);
		this.name = "ValidationError";
	}
};
var ModuleConflictError = class extends DockyardError {
	constructor(moduleId) {
		super("module_conflict", `Module is already registered: ${moduleId}`, { moduleId });
		this.name = "ModuleConflictError";
	}
};
var ModuleNotFoundError = class extends DockyardError {
	constructor(moduleId) {
		super("module_not_found", `Module is not registered: ${moduleId}`, { moduleId });
		this.name = "ModuleNotFoundError";
	}
};
var AccountSelectionError = class extends DockyardError {
	constructor(message, details = {}) {
		super("account_selection_error", message, details);
		this.name = "AccountSelectionError";
	}
};
var ProviderCapabilityError = class extends DockyardError {
	constructor(providerId, capability) {
		super("provider_capability_unavailable", `Provider module ${providerId} does not have an active ${capability} driver`, {
			providerId,
			capability
		});
		this.name = "ProviderCapabilityError";
	}
};
//#endregion
//#region vendor/dockyard/packages/core/src/contracts.mjs
const ACCOUNT_HEALTH = Object.freeze({
	UNKNOWN: "unknown",
	HEALTHY: "healthy",
	DEGRADED: "degraded",
	COOLDOWN: "cooldown",
	EXPIRED: "expired",
	EXHAUSTED: "exhausted"
});
const ACCOUNT_SELECTION_POLICY = Object.freeze({
	MANUAL: "manual",
	STICKY_SESSION: "sticky_session",
	ROUND_ROBIN: "round_robin",
	FAILOVER: "failover"
});
Object.freeze([
	"oauth_discovery",
	"oauth_import",
	"oauth_authorization",
	"oauth_refresh",
	"quota",
	"catalog",
	"invoke",
	"stream"
]);
function isoOrNull(value, fieldName) {
	if (value === void 0 || value === null || value === "") return null;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new ValidationError(`Invalid ISO timestamp for ${fieldName}`, {
		fieldName,
		value
	});
	return date.toISOString();
}
function numberOrNull(value, fieldName) {
	if (value === void 0 || value === null || value === "") return null;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`Expected a finite number for ${fieldName}`, {
		fieldName,
		value
	});
	return value;
}
function stringOrNull(value) {
	return value === void 0 || value === null || value === "" ? null : String(value);
}
function objectOrEmpty(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}
function createQuotaWindow(input = {}, now = /* @__PURE__ */ new Date()) {
	return {
		id: stringOrNull(input.id),
		name: stringOrNull(input.name),
		remaining: numberOrNull(input.remaining, "quota.windows.remaining"),
		limit: numberOrNull(input.limit, "quota.windows.limit"),
		unit: stringOrNull(input.unit),
		resetAt: isoOrNull(input.resetAt, "quota.windows.resetAt"),
		updatedAt: isoOrNull(input.updatedAt, "quota.windows.updatedAt") ?? now.toISOString(),
		source: stringOrNull(input.source) ?? "unknown"
	};
}
function createQuotaSnapshot(input = {}, now = /* @__PURE__ */ new Date()) {
	return {
		remaining: numberOrNull(input.remaining, "quota.remaining"),
		limit: numberOrNull(input.limit, "quota.limit"),
		unit: stringOrNull(input.unit),
		resetAt: isoOrNull(input.resetAt, "quota.resetAt"),
		updatedAt: isoOrNull(input.updatedAt, "quota.updatedAt") ?? now.toISOString(),
		source: stringOrNull(input.source) ?? "unknown",
		windows: Array.isArray(input.windows) ? input.windows.map((window) => createQuotaWindow(window, now)) : []
	};
}
function createRefreshState(input = {}) {
	return {
		accessTokenExpiresAt: isoOrNull(input.accessTokenExpiresAt, "refresh.accessTokenExpiresAt"),
		nextRefreshAt: isoOrNull(input.nextRefreshAt, "refresh.nextRefreshAt"),
		lastRefreshedAt: isoOrNull(input.lastRefreshedAt, "refresh.lastRefreshedAt"),
		refreshable: input.refreshable === void 0 ? null : Boolean(input.refreshable)
	};
}
function createAccountRecord(input, now = /* @__PURE__ */ new Date()) {
	if (!input || typeof input !== "object") throw new ValidationError("Account input is required");
	if (!input.providerId) throw new ValidationError("Account providerId is required");
	if (!input.accountId) throw new ValidationError("Account accountId is required");
	const credentialRef = input.credentialRef ?? input.auth?.credentialRef;
	if (!credentialRef) throw new ValidationError("Account credentialRef is required");
	const health = input.health ?? {};
	const createdAt = isoOrNull(input.createdAt, "createdAt") ?? now.toISOString();
	const updatedAt = isoOrNull(input.updatedAt, "updatedAt") ?? now.toISOString();
	return {
		providerId: String(input.providerId),
		accountId: String(input.accountId),
		displayName: stringOrNull(input.displayName),
		email: stringOrNull(input.email),
		auth: {
			kind: stringOrNull(input.auth?.kind) ?? "oauth",
			credentialRef: String(credentialRef),
			scopes: Array.isArray(input.auth?.scopes) ? [...input.auth.scopes] : []
		},
		subscription: {
			plan: stringOrNull(input.subscription?.plan),
			status: stringOrNull(input.subscription?.status),
			expiresAt: isoOrNull(input.subscription?.expiresAt, "subscription.expiresAt")
		},
		quota: createQuotaSnapshot(input.quota ?? {}, now),
		refresh: createRefreshState(input.refresh ?? {}),
		resources: objectOrEmpty(input.resources),
		health: {
			status: health.status ?? ACCOUNT_HEALTH.UNKNOWN,
			lastCheckedAt: isoOrNull(health.lastCheckedAt, "health.lastCheckedAt"),
			cooldownUntil: isoOrNull(health.cooldownUntil, "health.cooldownUntil"),
			lastError: stringOrNull(health.lastError)
		},
		lastUsedAt: isoOrNull(input.lastUsedAt, "lastUsedAt"),
		createdAt,
		updatedAt
	};
}
function accountSummary(account) {
	return {
		providerId: account.providerId,
		accountId: account.accountId,
		displayName: account.displayName,
		email: account.email,
		subscription: { ...account.subscription },
		quota: { ...account.quota },
		refresh: { ...account.refresh },
		resources: structuredClone(account.resources ?? {}),
		health: { ...account.health },
		lastUsedAt: account.lastUsedAt
	};
}
function accountStorageRecord(account) {
	return {
		...accountSummary(account),
		auth: {
			kind: account.auth.kind,
			credentialRef: account.auth.credentialRef,
			scopes: [...account.auth.scopes]
		},
		createdAt: account.createdAt,
		updatedAt: account.updatedAt
	};
}
//#endregion
//#region vendor/dockyard/packages/core/src/events.mjs
var EventBus = class {
	#handlers = /* @__PURE__ */ new Map();
	on(type, handler) {
		if (!this.#handlers.has(type)) this.#handlers.set(type, /* @__PURE__ */ new Set());
		this.#handlers.get(type).add(handler);
		return () => this.off(type, handler);
	}
	off(type, handler) {
		const handlers = this.#handlers.get(type);
		if (!handlers) return;
		handlers.delete(handler);
		if (handlers.size === 0) this.#handlers.delete(type);
	}
	async emit(type, payload) {
		const handlers = [...this.#handlers.get(type) ?? []];
		for (const handler of handlers) await handler(payload);
	}
	clear() {
		this.#handlers.clear();
	}
};
//#endregion
//#region vendor/dockyard/packages/core/src/module-runtime.mjs
var ModuleRuntime = class {
	#modules = /* @__PURE__ */ new Map();
	#services = /* @__PURE__ */ new Map();
	constructor({ events = new EventBus(), logger = console } = {}) {
		this.events = events;
		this.logger = logger;
	}
	async register(module) {
		const manifest = module?.manifest;
		if (!manifest?.id || !manifest.kind) throw new ValidationError("A module manifest must contain id and kind");
		if (this.#modules.has(manifest.id)) throw new ModuleConflictError(manifest.id);
		const record = {
			module,
			manifest: { ...manifest },
			services: /* @__PURE__ */ new Set(),
			active: false
		};
		this.#modules.set(manifest.id, record);
		const context = this.#contextFor(record);
		try {
			if (typeof module.activate === "function") await module.activate(context);
			record.active = true;
			await this.events.emit("module/registered", {
				moduleId: manifest.id,
				manifest: { ...manifest }
			});
			return module;
		} catch (error) {
			this.#removeServices(record);
			this.#modules.delete(manifest.id);
			throw error;
		}
	}
	async unregister(moduleId) {
		const record = this.#modules.get(moduleId);
		if (!record) throw new ModuleNotFoundError(moduleId);
		if (typeof record.module.deactivate === "function") await record.module.deactivate(this.#contextFor(record));
		this.#removeServices(record);
		this.#modules.delete(moduleId);
		await this.events.emit("module/unregistered", { moduleId });
	}
	has(moduleId) {
		return this.#modules.has(moduleId);
	}
	get(moduleId) {
		const record = this.#modules.get(moduleId);
		if (!record) throw new ModuleNotFoundError(moduleId);
		return record.module;
	}
	list() {
		return [...this.#modules.values()].map(({ manifest, active }) => ({
			...manifest,
			active
		}));
	}
	registerService(name, value, ownerId) {
		if (this.#services.has(name)) throw new ValidationError(`Service is already registered: ${name}`, { name });
		this.#services.set(name, {
			value,
			ownerId
		});
		const record = this.#modules.get(ownerId);
		if (record) record.services.add(name);
	}
	getService(name) {
		const service = this.#services.get(name);
		if (!service) throw new ValidationError(`Service is not registered: ${name}`, { name });
		return service.value;
	}
	hasService(name) {
		return this.#services.has(name);
	}
	#contextFor(record) {
		return {
			moduleId: record.manifest.id,
			events: this.events,
			logger: this.logger,
			registerService: (name, value) => this.registerService(name, value, record.manifest.id),
			getService: (name) => this.getService(name),
			emit: (type, payload = {}) => this.events.emit(type, {
				...payload,
				moduleId: record.manifest.id
			})
		};
	}
	#removeServices(record) {
		for (const name of record.services) this.#services.delete(name);
		record.services.clear();
	}
};
//#endregion
//#region vendor/dockyard/packages/core/src/provider-module.mjs
function missingDriver(providerId, capability) {
	return async () => {
		throw new ProviderCapabilityError(providerId, capability);
	};
}
function defineProviderModule({ id, displayName, capabilities = [], driver = {} }) {
	if (!id) throw new ValidationError("Provider module id is required");
	const module = {
		manifest: {
			id,
			kind: "provider",
			displayName: displayName ?? id,
			capabilities: [...capabilities],
			dataSource: "live_oauth"
		},
		async activate(context) {
			context.registerService(`provider:${id}`, module);
			await context.emit("provider/registered", { providerId: id });
		},
		async deactivate(context) {
			await context.emit("provider/unregistered", { providerId: id });
		},
		async discover(context) {
			return driver.discover ? driver.discover(context) : missingDriver(id, "oauth_discovery")(context);
		},
		async importAccount(candidate, context) {
			return driver.importAccount ? driver.importAccount(candidate, context) : missingDriver(id, "oauth_import")(candidate, context);
		},
		async importSource(source, context) {
			return driver.importSource ? driver.importSource(source, context) : missingDriver(id, "oauth_source_import")(source, context);
		},
		async getActiveSession(context) {
			return typeof driver.getActiveSession === "function" ? driver.getActiveSession(context) : null;
		},
		async dispose() {
			return typeof driver.dispose === "function" ? driver.dispose() : void 0;
		},
		async startAuthorization(context) {
			return driver.startAuthorization ? driver.startAuthorization(context) : missingDriver(id, "oauth_authorization")(context);
		},
		async pollAuthorization(sessionId, context) {
			return driver.pollAuthorization ? driver.pollAuthorization(sessionId, context) : missingDriver(id, "oauth_authorization")(sessionId, context);
		},
		async cancelAuthorization(sessionId, context) {
			return driver.cancelAuthorization ? driver.cancelAuthorization(sessionId, context) : missingDriver(id, "oauth_authorization")(sessionId, context);
		},
		async submitAuthorizationCode(sessionId, code, context) {
			return driver.submitAuthorizationCode ? driver.submitAuthorizationCode(sessionId, code, context) : missingDriver(id, "oauth_authorization")(sessionId, code, context);
		},
		async refreshAccount(account, context) {
			return driver.refreshAccount ? driver.refreshAccount(account, context) : missingDriver(id, "oauth_refresh")(account, context);
		},
		async getQuota(account, context) {
			return driver.getQuota ? driver.getQuota(account, context) : missingDriver(id, "quota")(account, context);
		},
		async getCatalog(context) {
			return driver.getCatalog ? driver.getCatalog(context) : missingDriver(id, "catalog")(context);
		},
		async invoke(request, invocation, context) {
			return driver.invoke ? driver.invoke(request, invocation, context) : missingDriver(id, "invoke")(request, invocation, context);
		},
		async stream(request, invocation, context) {
			if (driver.stream) return driver.stream(request, invocation, context);
			if (driver.invoke) return driver.invoke(request, invocation, context);
			return missingDriver(id, "stream")(request, invocation, context);
		}
	};
	return Object.freeze(module);
}
//#endregion
//#region vendor/dockyard/packages/core/src/dsh-route.mjs
function selectionContext(context, excludedIds) {
	if (excludedIds.size === 0) return context;
	return {
		...context,
		excludeAccountIds: [...excludedIds]
	};
}
function shouldFailover(error, accountPool, context) {
	return accountPool.policy === ACCOUNT_SELECTION_POLICY.FAILOVER && !context.accountId && (error?.rateLimited || error?.quotaExhausted || error?.authExpired || error?.emptyOutput);
}
function quotaResetAt(account) {
	return [account?.quota?.resetAt, ...Array.isArray(account?.quota?.windows) ? account.quota.windows.map((window) => window?.resetAt) : []].filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.getTime()) && value.getTime() > Date.now()).sort((left, right) => left.getTime() - right.getTime())[0]?.toISOString() ?? null;
}
function failureStatus(error) {
	if (error?.authExpired) return "auth_expired";
	if (error?.quotaExhausted) return "quota_exhausted";
	if (error?.rateLimited) return "rate_limited";
	return "error";
}
function failureCooldown(error, account) {
	return error?.cooldownUntil ?? quotaResetAt(account);
}
function hasSubstantiveStreamOutput(chunk) {
	if (!chunk || typeof chunk !== "object") return true;
	if (chunk.type === "block-start") return false;
	if (chunk.type === "block-end") return Boolean(chunk.block?.text || chunk.block?.id || chunk.block?.arguments);
	return !["usage", "finish"].includes(chunk.type);
}
function providerAccount$1(account, auth) {
	return {
		...account,
		auth: {
			kind: auth.authKind,
			credentialRef: auth.credentialRef,
			scopes: [...auth.scopes]
		}
	};
}
function createProviderRoute({ providerModule, accountPool }) {
	if (!providerModule?.manifest?.id) throw new ValidationError("Provider module is required");
	if (!accountPool?.select || !accountPool?.resolve) throw new ValidationError("Account pool is required");
	if (accountPool.providerId !== providerModule.manifest.id) throw new ValidationError("Provider module and account pool do not match", {
		providerId: providerModule.manifest.id,
		poolProviderId: accountPool.providerId
	});
	return {
		providerId: providerModule.manifest.id,
		async invoke(request, context = {}) {
			const excludedIds = new Set(context.excludeAccountIds ?? []);
			let lastError = null;
			while (true) {
				let account;
				try {
					account = accountPool.select(selectionContext(context, excludedIds));
				} catch (selectionError) {
					throw lastError ?? selectionError;
				}
				excludedIds.add(account.accountId);
				const auth = accountPool.resolve(account.accountId);
				const selectedAccount = providerAccount$1(account, auth);
				try {
					const response = await providerModule.invoke(request, {
						account: selectedAccount,
						auth
					}, context);
					accountPool.report(account.accountId, {
						status: "success",
						quota: response?.quota,
						refresh: response?.refresh
					});
					return response;
				} catch (error) {
					accountPool.report(account.accountId, {
						status: failureStatus(error),
						cooldownUntil: failureCooldown(error, selectedAccount),
						message: error?.message
					});
					if (!shouldFailover(error, accountPool, context)) throw error;
					lastError = error;
				}
			}
		},
		stream(request, context = {}) {
			return (async function* streamWithHealth() {
				const excludedIds = new Set(context.excludeAccountIds ?? []);
				let lastError = null;
				while (true) {
					let account;
					try {
						account = accountPool.select(selectionContext(context, excludedIds));
					} catch (selectionError) {
						throw lastError ?? selectionError;
					}
					excludedIds.add(account.accountId);
					const auth = accountPool.resolve(account.accountId);
					const selectedAccount = providerAccount$1(account, auth);
					const pending = [];
					let hasOutput = false;
					try {
						const output = providerModule.stream(request, {
							account: selectedAccount,
							auth
						}, context);
						for await (const chunk of await output) {
							if (!hasOutput && !hasSubstantiveStreamOutput(chunk)) {
								pending.push(chunk);
								continue;
							}
							if (!hasOutput) {
								hasOutput = true;
								for (const buffered of pending) yield buffered;
							}
							yield chunk;
						}
						if (!hasOutput) {
							const error = /* @__PURE__ */ new Error("Provider stream ended without substantive output");
							error.code = "EMPTY_STREAM_OUTPUT";
							error.emptyOutput = true;
							throw error;
						}
						accountPool.report(account.accountId, { status: "success" });
						return;
					} catch (error) {
						accountPool.report(account.accountId, {
							status: failureStatus(error),
							cooldownUntil: failureCooldown(error, selectedAccount),
							message: error?.message
						});
						if (!hasOutput && shouldFailover(error, accountPool, context)) {
							lastError = error;
							continue;
						}
						throw error;
					}
				}
			})();
		}
	};
}
//#endregion
//#region vendor/dockyard/packages/account-pool/src/account-pool.mjs
function defaultClock() {
	return /* @__PURE__ */ new Date();
}
var AccountPool = class {
	#accounts = /* @__PURE__ */ new Map();
	#sessionAssignments = /* @__PURE__ */ new Map();
	#cursor = 0;
	#defaultAccountId = null;
	constructor({ providerId, policy = ACCOUNT_SELECTION_POLICY.ROUND_ROBIN, clock = defaultClock } = {}) {
		if (!providerId) throw new ValidationError("AccountPool providerId is required");
		if (!Object.values(ACCOUNT_SELECTION_POLICY).includes(policy)) throw new ValidationError(`Unknown account selection policy: ${policy}`, { policy });
		this.providerId = providerId;
		this.policy = policy;
		this.clock = clock;
	}
	upsert(input, { resetHealth = false } = {}) {
		if (input.providerId && input.providerId !== this.providerId) throw new ValidationError("Account provider does not match this pool", {
			expected: this.providerId,
			received: input.providerId
		});
		const current = this.#accounts.get(input.accountId);
		const account = createAccountRecord({
			...current,
			...input,
			credentialRef: input.credentialRef ?? current?.auth?.credentialRef,
			providerId: this.providerId,
			auth: {
				...current?.auth,
				...input.auth
			},
			subscription: {
				...current?.subscription,
				...input.subscription
			},
			quota: {
				...current?.quota,
				...input.quota
			},
			refresh: {
				...current?.refresh,
				...input.refresh
			},
			resources: {
				...current?.resources,
				...input.resources
			},
			health: resetHealth ? {
				...input.health,
				status: input.health?.status === ACCOUNT_HEALTH.EXPIRED ? ACCOUNT_HEALTH.UNKNOWN : input.health?.status ?? ACCOUNT_HEALTH.UNKNOWN,
				cooldownUntil: null,
				lastError: null
			} : {
				...current?.health,
				...input.health
			},
			createdAt: current?.createdAt ?? input.createdAt
		}, this.clock());
		this.#accounts.set(account.accountId, account);
		this.#ensureSingleAccountDefault();
		return accountSummary(account);
	}
	remove(accountId) {
		this.#sessionAssignments.forEach((assignedId, key) => {
			if (assignedId === accountId) this.#sessionAssignments.delete(key);
		});
		const removed = this.#accounts.delete(accountId);
		if (removed && this.#defaultAccountId === accountId) this.#defaultAccountId = null;
		this.#ensureSingleAccountDefault();
		return removed;
	}
	get(accountId) {
		const account = this.#accounts.get(accountId);
		return account ? accountSummary(account) : null;
	}
	list() {
		return [...this.#accounts.values()].map(accountSummary);
	}
	listForStorage() {
		return [...this.#accounts.values()].map(accountStorageRecord);
	}
	getDefaultAccountId() {
		return this.#defaultAccountId;
	}
	setPolicy(policy) {
		if (!Object.values(ACCOUNT_SELECTION_POLICY).includes(policy)) throw new ValidationError(`Unknown account selection policy: ${policy}`, { policy });
		this.policy = policy;
		this.#sessionAssignments.clear();
		this.#ensureSingleAccountDefault();
	}
	setDefaultAccount(accountId) {
		if (accountId !== null && !this.#accounts.has(accountId)) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
		this.#defaultAccountId = accountId;
	}
	select(context = {}) {
		const eligible = this.#eligibleAccounts();
		if (eligible.length === 0) throw new AccountSelectionError(`No eligible accounts for provider ${this.providerId}`, { providerId: this.providerId });
		let account;
		if (this.policy === ACCOUNT_SELECTION_POLICY.MANUAL) {
			const requestedId = context.accountId ?? this.#defaultAccountId ?? (eligible.length === 1 ? eligible[0].accountId : null);
			if (!requestedId) throw new AccountSelectionError("Manual policy requires accountId");
			account = eligible.find((candidate) => candidate.accountId === requestedId);
			if (!account) throw new AccountSelectionError(`Account is not eligible: ${requestedId}`, { accountId: requestedId });
		} else {
			const assignmentKey = this.policy === ACCOUNT_SELECTION_POLICY.STICKY_SESSION ? context.sessionId ?? context.requestId ?? null : null;
			const excludedIds = new Set(context.excludeAccountIds ?? []);
			const assignedId = assignmentKey ? this.#sessionAssignments.get(assignmentKey) : null;
			account = assignedId && !excludedIds.has(assignedId) ? eligible.find((candidate) => candidate.accountId === assignedId) : null;
			if (!account) {
				account = this.policy === ACCOUNT_SELECTION_POLICY.FAILOVER ? eligible.find((candidate) => !excludedIds.has(candidate.accountId)) : this.#next(eligible);
				if (!account) throw new AccountSelectionError("No eligible account remains after failover exclusions", {
					providerId: this.providerId,
					excludeAccountIds: [...excludedIds]
				});
				if (assignmentKey) this.#sessionAssignments.set(assignmentKey, account.accountId);
			}
		}
		const updated = {
			...account,
			lastUsedAt: this.clock().toISOString(),
			updatedAt: this.clock().toISOString()
		};
		this.#accounts.set(updated.accountId, updated);
		return accountSummary(updated);
	}
	resolve(accountId) {
		const account = this.#accounts.get(accountId);
		if (!account) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
		return {
			providerId: account.providerId,
			accountId: account.accountId,
			credentialRef: account.auth.credentialRef,
			authKind: account.auth.kind,
			scopes: [...account.auth.scopes]
		};
	}
	updateQuota(accountId, input) {
		const current = this.#accounts.get(accountId);
		if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
		return this.#patch(accountId, { quota: createQuotaSnapshot({
			...current.quota,
			...input
		}, this.clock()) });
	}
	updateRefresh(accountId, input) {
		const current = this.#accounts.get(accountId);
		if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
		return this.#patch(accountId, { refresh: createRefreshState({
			...current.refresh,
			...input
		}) });
	}
	updateResources(accountId, input = {}) {
		const current = this.#accounts.get(accountId);
		if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
		return this.#patch(accountId, { resources: {
			...current.resources,
			...input
		} });
	}
	report(accountId, result = {}) {
		const account = this.#accounts.get(accountId);
		if (!account) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
		const now = this.clock().toISOString();
		const patch = {
			updatedAt: now,
			health: {
				...account.health,
				lastCheckedAt: now
			}
		};
		if (result.quota) patch.quota = createQuotaSnapshot({
			...account.quota,
			...result.quota
		}, this.clock());
		if (result.refresh) patch.refresh = createRefreshState({
			...account.refresh,
			...result.refresh
		});
		switch (result.status) {
			case "success":
				patch.health = {
					...patch.health,
					status: ACCOUNT_HEALTH.HEALTHY,
					cooldownUntil: null,
					lastError: null
				};
				break;
			case "rate_limited":
				patch.health = {
					...patch.health,
					status: result.cooldownUntil ? ACCOUNT_HEALTH.COOLDOWN : ACCOUNT_HEALTH.DEGRADED,
					cooldownUntil: result.cooldownUntil ?? null,
					lastError: result.message ?? null
				};
				break;
			case "quota_exhausted":
				patch.health = {
					...patch.health,
					status: ACCOUNT_HEALTH.EXHAUSTED,
					cooldownUntil: result.cooldownUntil ?? null,
					lastError: result.message ?? null
				};
				break;
			case "auth_expired":
				patch.health = {
					...patch.health,
					status: ACCOUNT_HEALTH.EXPIRED,
					lastError: result.message ?? null
				};
				break;
			case "error":
				patch.health = {
					...patch.health,
					status: ACCOUNT_HEALTH.DEGRADED,
					lastError: result.message ?? null
				};
				break;
			default: break;
		}
		return this.#patch(accountId, patch);
	}
	#patch(accountId, patch) {
		const current = this.#accounts.get(accountId);
		if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
		const next = {
			...current,
			...patch,
			quota: patch.quota ? {
				...current.quota,
				...patch.quota
			} : current.quota,
			refresh: patch.refresh ? {
				...current.refresh,
				...patch.refresh
			} : current.refresh,
			resources: patch.resources ? {
				...current.resources,
				...patch.resources
			} : current.resources,
			health: patch.health ? {
				...current.health,
				...patch.health
			} : current.health
		};
		this.#accounts.set(accountId, next);
		return accountSummary(next);
	}
	#eligibleAccounts() {
		const now = this.clock();
		return [...this.#accounts.values()].filter((account) => {
			if (account.health.status === ACCOUNT_HEALTH.EXPIRED) return false;
			if (account.health.status === ACCOUNT_HEALTH.EXHAUSTED && !account.health.cooldownUntil) return false;
			if (!account.health.cooldownUntil) return true;
			return new Date(account.health.cooldownUntil).getTime() <= now.getTime();
		});
	}
	#next(accounts) {
		const account = accounts[this.#cursor % accounts.length];
		this.#cursor = (this.#cursor + 1) % accounts.length;
		return account;
	}
	#ensureSingleAccountDefault() {
		if (this.policy !== ACCOUNT_SELECTION_POLICY.MANUAL || this.#defaultAccountId || this.#accounts.size !== 1) return;
		this.#defaultAccountId = this.#accounts.keys().next().value ?? null;
	}
};
//#endregion
//#region vendor/dockyard/packages/dsh-bridge/src/index.mjs
var DshInjectionBridge = class {
	#routes = /* @__PURE__ */ new Map();
	constructor({ runtime, adapter = null } = {}) {
		if (!runtime) throw new ValidationError("DSH runtime is required");
		this.runtime = runtime;
		this.adapter = adapter;
	}
	async mountProvider(providerModule, accountPool) {
		const providerId = providerModule?.manifest?.id;
		if (!providerId) throw new ValidationError("Provider module is required");
		if (!this.runtime.has(providerId)) await this.runtime.register(providerModule);
		const route = createProviderRoute({
			providerModule,
			accountPool
		});
		this.#routes.set(providerId, route);
		if (this.adapter?.registerProviderRoute) await this.adapter.registerProviderRoute(route, providerModule.manifest);
		await this.runtime.events.emit("dsh/provider-mounted", {
			providerId,
			manifest: { ...providerModule.manifest }
		});
		return route;
	}
	async unmountProvider(providerId) {
		if (!this.#routes.get(providerId)) return false;
		if (this.adapter?.unregisterProviderRoute) await this.adapter.unregisterProviderRoute(providerId);
		this.#routes.delete(providerId);
		await this.runtime.events.emit("dsh/provider-unmounted", { providerId });
		return true;
	}
	getRoute(providerId) {
		return this.#routes.get(providerId) ?? null;
	}
	listRoutes() {
		return [...this.#routes.keys()];
	}
};
//#endregion
//#region vendor/dockyard/packages/vault/src/index.mjs
const KEYCHAIN_SERVICE = "com.dockyard-dsh.credentials";
const SWIFT_BIN = "/usr/bin/swift";
const KEYCHAIN_HELPER = join(dirname(fileURLToPath(import.meta.url)), "macos-keychain-helper.swift");
function stableKey(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}
function runKeychainHelper(request, { timeoutMs = 3e4 } = {}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			callback(value);
		};
		const child = spawn(SWIFT_BIN, [KEYCHAIN_HELPER], {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		const stdout = [];
		let exitError = "";
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => {
			exitError += chunk.toString();
		});
		child.on("error", (error) => finish(reject, error));
		child.on("close", (code) => {
			if (settled) return;
			if (code === 0) {
				try {
					finish(resolve, JSON.parse(Buffer.concat(stdout).toString("utf8")));
				} catch {
					finish(reject, /* @__PURE__ */ new Error("macOS Keychain helper returned invalid data"));
				}
				return;
			}
			const error = /* @__PURE__ */ new Error("macOS Keychain operation failed");
			error.code = code;
			error.detail = exitError.replace(/\s+/g, " ").trim().slice(0, 300);
			finish(reject, error);
		});
		timer = setTimeout(() => {
			child.kill("SIGTERM");
			const error = /* @__PURE__ */ new Error("macOS Keychain operation timed out");
			error.code = "ETIMEDOUT";
			finish(reject, error);
		}, timeoutMs);
		child.stdin.write(JSON.stringify(request));
		child.stdin.end();
	});
}
function createCredentialRef(providerId, accountId) {
	return `provider-secret://dsh-subscriptions/${providerId}/${stableKey(`${providerId}:${accountId}`)}`;
}
/**
* Non-macOS default. Keep the runtime bootable so a host credential service
* can be attached later, but never persist provider secrets in process memory
* implicitly. Tests and explicit local fixtures should inject MemorySecretStore
* themselves.
*/
var UnavailableSecretStore = class {
	constructor({ platform = process.platform } = {}) {
		this.platform = platform;
	}
	async read() {
		return null;
	}
	async write() {
		throw new Error(`Secure credential storage is unavailable on ${this.platform}; configure the host credential service`);
	}
	async delete() {}
};
var MacOSKeychainStore = class {
	constructor({ service = KEYCHAIN_SERVICE } = {}) {
		this.service = service;
	}
	async read(ref) {
		try {
			const output = await runKeychainHelper({
				operation: "read",
				service: this.service,
				account: ref,
				value: null
			});
			return output.found ? JSON.parse(output.value) : null;
		} catch (error) {
			throw error;
		}
	}
	async write(ref, value) {
		await runKeychainHelper({
			operation: "write",
			service: this.service,
			account: ref,
			value: JSON.stringify(value)
		});
		return ref;
	}
	async delete(ref) {
		await runKeychainHelper({
			operation: "delete",
			service: this.service,
			account: ref,
			value: null
		});
	}
};
function createDefaultSecretStore({ platform = process.platform } = {}) {
	if (platform !== "darwin") return new UnavailableSecretStore({ platform });
	return new MacOSKeychainStore();
}
Object.freeze({ keychainService: KEYCHAIN_SERVICE });
//#endregion
//#region vendor/dockyard/packages/runtime/src/state-store.mjs
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 3e4;
const LOCK_STALE_MS = 12e4;
function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function acquireFileLock(filePath) {
	const lockPath = `${filePath}.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	await mkdir(dirname(filePath), {
		recursive: true,
		mode: 448
	});
	while (true) try {
		const handle = await open(lockPath, "wx", 384);
		try {
			await handle.writeFile(`${process.pid}\n`, "utf8");
		} catch (error) {
			await handle.close().catch(() => {});
			await rm(lockPath, { force: true }).catch(() => {});
			throw error;
		}
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await handle.close().catch(() => {});
			await rm(lockPath, { force: true }).catch(() => {});
		};
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		try {
			const metadata = await stat(lockPath);
			if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
				await rm(lockPath, { force: true });
				continue;
			}
		} catch (lockError) {
			if (lockError?.code !== "ENOENT") throw lockError;
			continue;
		}
		if (Date.now() >= deadline) {
			const timeout = /* @__PURE__ */ new Error(`Timed out waiting for state file lock: ${filePath}`);
			timeout.code = "ELOCKTIMEOUT";
			throw timeout;
		}
		await delay(LOCK_RETRY_MS);
	}
}
async function withFileLock(filePath, operation) {
	const release = await acquireFileLock(filePath);
	try {
		return await operation();
	} finally {
		await release();
	}
}
function defaultDockyardHome({ env = process.env, home = homedir() } = {}) {
	return env.DOCKYARD_DSH_HOME || join(home, ".dockyard-dsh");
}
function defaultDockyardStatePath(options = {}) {
	return join(defaultDockyardHome(options), "state.json");
}
function emptyState() {
	return {
		schema: 1,
		pools: {},
		updatedAt: null
	};
}
var JsonStateStore = class {
	constructor({ filePath, home, env } = {}) {
		this.filePath = filePath ?? defaultDockyardStatePath({
			home,
			env
		});
	}
	async load() {
		try {
			const raw = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw);
			return {
				...emptyState(),
				...parsed,
				pools: parsed?.pools && typeof parsed.pools === "object" ? parsed.pools : {}
			};
		} catch (error) {
			if (error?.code === "ENOENT") return emptyState();
			if (error instanceof SyntaxError) {
				const archivePath = `${this.filePath}.corrupted.${Date.now()}`;
				await rename(this.filePath, archivePath).catch(() => {});
				return emptyState();
			}
			throw error;
		}
	}
	async save(state) {
		return withFileLock(this.filePath, () => this.#write(state));
	}
	async update(mutator) {
		if (typeof mutator !== "function") throw new TypeError("State update mutator must be a function");
		return withFileLock(this.filePath, async () => {
			const next = await mutator(await this.load());
			return this.#write(next);
		});
	}
	async #write(state) {
		const next = {
			...emptyState(),
			...state,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await mkdir(dirname(this.filePath), {
			recursive: true,
			mode: 448
		});
		const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
		let committed = false;
		try {
			await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 384 });
			await rename(tempPath, this.filePath);
			committed = true;
			return next;
		} finally {
			if (!committed) await rm(tempPath, { force: true }).catch(() => {});
		}
	}
};
//#endregion
//#region vendor/dockyard/packages/providers/src/provider-utils.mjs
async function readJsonFile(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}
function decodeJwtPayload(token) {
	if (typeof token !== "string") return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return null;
	}
}
function isoFromEpoch(value) {
	if (value === void 0 || value === null || value === "") return null;
	const numeric = Number(value);
	const date = Number.isFinite(numeric) ? new Date(numeric < 1e10 ? numeric * 1e3 : numeric) : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function addSecondsIso(seconds, now = /* @__PURE__ */ new Date()) {
	const numeric = Number(seconds);
	if (!Number.isFinite(numeric)) return null;
	return new Date(now.getTime() + numeric * 1e3).toISOString();
}
function finiteNumber(value) {
	if (value === void 0 || value === null || value === "") return null;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}
function stringValue(value) {
	return value === void 0 || value === null || value === "" ? null : String(value);
}
function redactError(error) {
	if (!error) return null;
	return `${error instanceof Error ? error.message : String(error)}${error?.detail ? ` ${String(error.detail)}` : ""}${error?.code !== void 0 && error?.code !== null ? ` [code ${String(error.code)}]` : ""}`.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]").replace(/(access|refresh|id)[_-]?token["'=:\s]+[^,\s}]+/gi, "$1_token=[redacted]").replace(/\b(?:sk|sk-ant|sk-proj|sk-svcacct|xai|agy|gsk|ghp|gho|ghu|github_pat|deepseek|pplx|nvapi|zai|glm)[-_][A-Za-z0-9_-]{12,}\b/gi, "[redacted]").replace(/(api[_-]?key|client[_-]?secret|session[_-]?token|private[_-]?key)["'=:\s]+[^,\s}"']+/gi, "$1=[redacted]").slice(0, 300);
}
function recursiveQuotaWindows(value, { source, now = /* @__PURE__ */ new Date(), prefix = "quota" } = {}) {
	const windows = [];
	function visit(node, path, label) {
		if (!node || typeof node !== "object" || Array.isArray(node)) return;
		const usedPercent = finiteNumber(node.used_percent ?? node.usedPercent);
		const remainingFraction = finiteNumber(node.remaining_fraction ?? node.remainingFraction);
		const remainingValue = finiteNumber(node.remaining);
		const limitValue = finiteNumber(node.limit);
		const resetAt = isoFromEpoch(node.reset_at ?? node.resetAt) ?? addSecondsIso(node.reset_after_seconds ?? node.resetAfterSeconds, now);
		if (usedPercent !== null || remainingFraction !== null || remainingValue !== null || limitValue !== null) {
			let remaining = remainingValue;
			let limit = limitValue;
			let unit = stringValue(node.unit);
			if (remaining === null && remainingFraction !== null) {
				remaining = remainingFraction;
				limit = limit ?? 1;
				unit = unit ?? "fraction";
			} else if (remaining === null && usedPercent !== null) {
				remaining = Math.max(0, 100 - usedPercent);
				limit = limit ?? 100;
				unit = unit ?? "percent";
			}
			windows.push({
				id: path || prefix,
				name: label || path || prefix,
				remaining,
				limit,
				unit,
				resetAt,
				source
			});
		}
		for (const [key, child] of Object.entries(node)) if (child && typeof child === "object" && !Array.isArray(child)) visit(child, path ? `${path}.${key}` : key, key);
	}
	visit(value, "", prefix);
	const unique = /* @__PURE__ */ new Map();
	for (const window of windows) unique.set(window.id, window);
	return [...unique.values()];
}
function selectPrimaryQuotaWindow(windows) {
	if (!windows?.length) return {};
	return windows.find((window) => /primary|weekly|five.?hour|5h/i.test(`${window.id} ${window.name}`)) ?? windows[0];
}
//#endregion
//#region vendor/dockyard/packages/oauth/src/browser-oauth-authorizer.mjs
const DEFAULT_TIMEOUT_MS$2 = 600 * 1e3;
const DEFAULT_CALLBACK_PATH = "/oauth/callback";
function base64Url(value) {
	return Buffer.from(value).toString("base64url");
}
function createPkce() {
	const verifier = base64Url(randomBytes(32));
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
function publicSession$3(session) {
	return {
		sessionId: session.sessionId,
		providerId: session.providerId,
		status: session.status,
		authorizationUrl: session.authorizationUrl,
		instructions: session.instructions,
		startedAt: session.startedAt,
		diagnostic: session.diagnostic ?? null,
		...session.browserOpened ? { browserOpened: true } : {},
		...session.authorizationCodeRequired ? { authorizationCodeRequired: true } : {}
	};
}
function missingSession(sessionId, providerId, instructions) {
	return {
		sessionId,
		providerId,
		status: "missing",
		instructions,
		diagnostic: "OAuth 登录会话不存在或已结束，请重新点击登录添加账号。"
	};
}
function extractCodeInput(input) {
	const text = String(input ?? "").trim();
	if (!text) return {
		code: "",
		state: ""
	};
	try {
		const url = new URL(text);
		return {
			code: url.searchParams.get("code") ?? "",
			state: url.searchParams.get("state") ?? "",
			error: url.searchParams.get("error") ?? ""
		};
	} catch {
		const [code, state] = text.split("#", 2);
		return {
			code: code.trim(),
			state: state?.trim() ?? ""
		};
	}
}
/**
* Provider-neutral browser OAuth controller. Providers supply only their
* registered OAuth endpoints and token/account adapters; this layer owns PKCE,
* state validation, loopback callbacks, manual code input, and cleanup.
*/
function createBrowserOAuthAuthorizer({ providerId, authorizationUrlBuilder, exchangeCode = null, pollSession = null, importCredentials, redirectUri, callbackPath = DEFAULT_CALLBACK_PATH, callbackHost = "localhost", callbackPort = null, instructions = "请在官方授权页面选择账号并完成授权。", timeoutMs = DEFAULT_TIMEOUT_MS$2, browserOpened = false, authorizationCodeRequired = false } = {}) {
	if (!providerId) throw new Error("Browser OAuth authorizer requires providerId");
	if (typeof authorizationUrlBuilder !== "function") throw new Error(`Browser OAuth authorizer requires an authorization URL builder for ${providerId}`);
	if (typeof exchangeCode !== "function" && typeof pollSession !== "function") throw new Error(`Browser OAuth authorizer requires a code exchange or session poller for ${providerId}`);
	if (typeof importCredentials !== "function") throw new Error(`Browser OAuth authorizer requires an import callback for ${providerId}`);
	if (!redirectUri && callbackPort === null && typeof pollSession !== "function") throw new Error(`Browser OAuth authorizer requires redirectUri or callbackPort for ${providerId}`);
	const sessions = /* @__PURE__ */ new Map();
	async function closeServer(session) {
		if (!session.server) return;
		const server = session.server;
		session.server = null;
		await new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		}).catch(() => {});
	}
	async function cleanup(session) {
		if (session.timer) clearTimeout(session.timer);
		await closeServer(session);
	}
	function responseHtml(res, title, message, statusCode = 200) {
		res.statusCode = statusCode;
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.setHeader("cache-control", "no-store, max-age=0");
		res.setHeader("pragma", "no-cache");
		res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("x-content-type-options", "nosniff");
		res.end(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title><p>${message}</p><p>可以关闭此页面并返回 Dockyard DSH。</p><script>history.replaceState(null,"","/")<\/script>`);
	}
	async function handleCallback(session, req, res) {
		const peer = String(req.socket?.remoteAddress ?? "").toLowerCase().replace(/^::ffff:/, "");
		if (!["127.0.0.1", "::1"].includes(peer)) {
			res.statusCode = 403;
			res.end("Forbidden");
			return;
		}
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		if (requestUrl.pathname !== session.callbackPath) {
			res.statusCode = 404;
			res.end("Not found");
			return;
		}
		const error = requestUrl.searchParams.get("error");
		const code = requestUrl.searchParams.get("code") ?? "";
		const state = requestUrl.searchParams.get("state") ?? "";
		if (state !== session.state) {
			responseHtml(res, "授权未完成", "安全校验失败；本次登录仍在等待正确的官方回调。", 400);
			return;
		}
		if (error) {
			session.callback = {
				error,
				state
			};
			responseHtml(res, "授权未完成", "官方授权被拒绝，可以关闭此页面。");
			return;
		}
		if (!code) {
			session.callback = {
				error: "授权回调没有返回 code",
				state
			};
			responseHtml(res, "授权未完成", "回调缺少授权码，可以关闭此页面。");
			return;
		}
		session.callback = {
			code,
			state
		};
		responseHtml(res, "授权成功", "已收到授权回调，正在返回 Dockyard DSH。");
	}
	async function openCallbackServer(session) {
		if (session.callbackPort === null || session.callbackPort === void 0) return;
		const server = createServer((req, res) => {
			handleCallback(session, req, res).catch((error) => {
				session.callback = { error: redactError(error) };
				res.statusCode = 500;
				res.end("OAuth callback failed");
			});
		});
		session.server = server;
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen({
				host: callbackHost,
				port: session.callbackPort
			});
		});
		server.unref?.();
		const address = server.address();
		session.redirectUri = session.redirectUri ?? `http://${callbackHost}:${address.port}${callbackPath}`;
	}
	async function finalize(session, context = {}) {
		if (session.result) return session.result;
		if (session.finalizing) return session.finalizing;
		session.finalizing = (async () => {
			try {
				const callback = session.callback;
				if (!callback && !session.credentials) return publicSession$3(session);
				if (callback?.error) throw new Error(callback.error);
				const accounts = await importCredentials(session.credentials ?? await exchangeCode({
					code: callback.code,
					state: callback.state,
					codeVerifier: session.codeVerifier,
					redirectUri: session.redirectUri,
					context
				}), context);
				if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("官方授权完成，但 provider 没有返回可接入的订阅账号");
				session.status = "completed";
				session.result = {
					...publicSession$3(session),
					accounts,
					diagnostic: null
				};
				return session.result;
			} catch (error) {
				session.status = "failed";
				session.diagnostic = redactError(error);
				return publicSession$3(session);
			} finally {
				await cleanup(session);
			}
		})();
		return session.finalizing;
	}
	async function begin() {
		const pkce = createPkce();
		const session = {
			sessionId: `${providerId}:browser:${randomUUID()}`,
			providerId,
			status: "pending",
			authorizationUrl: null,
			instructions,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			browserOpened,
			authorizationCodeRequired,
			callbackPath,
			callbackPort,
			redirectUri,
			state: base64Url(randomBytes(24)),
			codeVerifier: pkce.verifier,
			callback: null,
			server: null,
			timer: null,
			finalizing: null,
			result: null,
			diagnostic: null
		};
		sessions.set(session.sessionId, session);
		try {
			await openCallbackServer(session);
			session.nonce = base64Url(randomBytes(24));
			const built = await authorizationUrlBuilder({
				state: session.state,
				codeChallenge: pkce.challenge,
				redirectUri: session.redirectUri,
				nonce: session.nonce
			});
			session.authorizationUrl = typeof built === "string" ? built : built?.url;
			session.metadata = typeof built === "object" ? built.metadata ?? null : null;
			if (!session.authorizationUrl) throw new Error("官方 OAuth 没有返回授权页面地址");
			session.timer = setTimeout(() => {
				if (session.status !== "pending") return;
				session.status = "failed";
				session.diagnostic = "官方 OAuth 登录超时，请重新点击登录添加账号。";
				cleanup(session);
			}, timeoutMs);
			session.timer.unref?.();
		} catch (error) {
			session.status = "failed";
			session.diagnostic = `无法启动官方浏览器授权：${redactError(error)}`;
			await cleanup(session);
		}
		return publicSession$3(session);
	}
	async function poll(sessionId, context = {}) {
		const session = sessions.get(sessionId);
		if (!session) return missingSession(sessionId, providerId, instructions);
		if (session.status === "failed" || session.status === "completed") {
			const result = session.result ?? publicSession$3(session);
			sessions.delete(sessionId);
			return result;
		}
		if (!session.callback && typeof pollSession === "function") try {
			const credentials = await pollSession({
				metadata: session.metadata,
				context
			});
			if (credentials) session.credentials = credentials;
		} catch (error) {
			session.status = "failed";
			session.diagnostic = redactError(error);
			await cleanup(session);
			const result = publicSession$3(session);
			sessions.delete(sessionId);
			return result;
		}
		if (!session.callback && !session.credentials) return publicSession$3(session);
		const result = await finalize(session, context);
		if (!["pending", "processing"].includes(result.status)) sessions.delete(sessionId);
		return result;
	}
	async function submitAuthorizationCode(sessionId, input, context = {}) {
		const session = sessions.get(sessionId);
		if (!session) return missingSession(sessionId, providerId, instructions);
		const parsed = extractCodeInput(input);
		if (parsed.state !== session.state) session.callback = { error: "OAuth state 校验失败" };
		else if (parsed.error) session.callback = {
			error: parsed.error,
			state: parsed.state
		};
		else if (!parsed.code) {
			session.diagnostic = "请粘贴包含 state 的完整回调地址，或使用 code#state 格式。";
			return publicSession$3(session);
		} else session.callback = {
			code: parsed.code,
			state: parsed.state
		};
		return finalize(session, context);
	}
	async function dispose() {
		const active = [...sessions.values()];
		sessions.clear();
		await Promise.all(active.map((session) => cleanup(session)));
	}
	async function cancel(sessionId) {
		const session = sessions.get(sessionId);
		if (!session) return {
			sessionId,
			providerId,
			status: "missing"
		};
		await cleanup(session);
		sessions.delete(sessionId);
		return {
			sessionId,
			providerId,
			status: "cancelled"
		};
	}
	return Object.freeze({
		begin,
		poll,
		submitAuthorizationCode,
		cancel,
		dispose
	});
}
Object.freeze({
	defaultTimeoutMs: DEFAULT_TIMEOUT_MS$2,
	defaultCallbackPath: DEFAULT_CALLBACK_PATH
});
//#endregion
//#region vendor/dockyard/packages/providers/src/cli-agent-transport.mjs
function cliFailure$1(code, signal, output, errorOutput, providerId) {
	const error = /* @__PURE__ */ new Error(`${providerId ?? "provider"} CLI failed (${signal ?? code})`);
	error.code = code;
	error.detail = String(errorOutput || output || "").replace(/\s+/g, " ").trim().slice(0, 500);
	return error;
}
function parseJsonOutput$1(output) {
	if (output && typeof output === "object") return output;
	try {
		return JSON.parse(String(output));
	} catch {
		for (const line of String(output ?? "").split(/\r?\n/).reverse()) {
			if (!line.trim()) continue;
			try {
				return JSON.parse(line);
			} catch {}
		}
		return null;
	}
}
function runCliCommand(command, args, { env = process.env, cwd, timeoutMs = 3e4, signal, providerId } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env,
			...cwd ? { cwd } : {},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			...signal ? { signal } : {}
		});
		const stdout = [];
		const stderr = [];
		let timedOut = false;
		let forceTimer = null;
		let terminationRequested = false;
		const terminate = () => {
			if (terminationRequested) return;
			terminationRequested = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			forceTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, 1e3);
			forceTimer.unref?.();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", (error) => {
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			reject(error);
		});
		child.once("close", (code, closeSignal) => {
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			const output = Buffer.concat(stdout).toString("utf8");
			const errorOutput = Buffer.concat(stderr).toString("utf8");
			if (code === 0) {
				resolve({
					output,
					errorOutput
				});
				return;
			}
			reject(cliFailure$1(code, timedOut ? "SIGTERM" : closeSignal, output, errorOutput, providerId));
		});
	});
}
/** Return true when a DSH request contains a durable image content block. */
function contentHasImage(value) {
	if (Array.isArray(value)) return value.some((item) => contentHasImage(item));
	if (!value || typeof value !== "object") return false;
	if (value.type === "image") return true;
	return Object.values(value).some((item) => contentHasImage(item));
}
/**
* Detect an image in the turn being submitted now. Older session messages may
* still contain a failed image turn; a text-only CLI must be able to continue
* that session instead of failing every later text message again.
*/
function contentHasImageInCurrentTurn(request = {}) {
	const messages = Array.isArray(request.messages) ? request.messages : [];
	if (messages.length > 0) {
		const current = messages.at(-1)?.role === "user" ? messages.at(-1) : [...messages].reverse().find((message) => message?.role === "user") ?? messages.at(-1);
		return contentHasImage(current?.content ?? current?.text);
	}
	return contentHasImage(request.input);
}
function unsupportedContentError(providerId, detail) {
	const error = new Error(detail ?? `${providerId ?? "provider"} does not support this content through its native transport`);
	error.code = "UNSUPPORTED_CONTENT";
	error.providerId = providerId ?? null;
	return error;
}
Object.freeze({ defaultOutputFormat: "stream-json" });
//#endregion
//#region vendor/dockyard/packages/providers/src/session-source.mjs
/**
* Shared vocabulary for provider-owned sessions.
*
* A provider may obtain an official session from a CLI, a desktop client,
* browser OAuth, or an OAuth file. The transport and status reader remain
* provider-specific; this module only keeps the account contract neutral.
*/
const OFFICIAL_SESSION_AUTH_KIND = "official_session";
const LEGACY_OFFICIAL_SESSION_AUTH_KINDS = Object.freeze(["official_cli_session"]);
const OFFICIAL_SESSION_SOURCE_KINDS = Object.freeze({
	CLI: "cli",
	DESKTOP_APP: "desktop_app",
	BROWSER: "browser",
	OAUTH_FILE: "oauth_file",
	OTHER: "other"
});
function isOfficialSessionAuthKind(value) {
	const kind = typeof value === "string" ? value : value?.kind;
	return kind === "official_session" || LEGACY_OFFICIAL_SESSION_AUTH_KINDS.includes(kind);
}
/**
* Normalize a public status result returned by an injected official-client
* reader. Readers may return text, a JSON object, or { output, source }.
*/
function normalizeOfficialSessionResult(value, { source = "official_session", sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.OTHER } = {}) {
	if (value === null || value === void 0) return null;
	if (typeof value === "string") return {
		output: value,
		source,
		sourceKind
	};
	if (typeof value !== "object") return null;
	let payload = typeof value.output === "string" ? value.output : "";
	if (!payload) try {
		payload = JSON.stringify(value.status ?? value);
	} catch {
		payload = "";
	}
	return {
		...value,
		output: payload,
		source: value.source ?? source,
		sourceKind: value.sourceKind ?? sourceKind
	};
}
function officialSessionResources({ sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.OTHER, authSource = null, extra = {} } = {}) {
	return {
		accountScope: "active_official_session",
		sessionSource: sourceKind,
		...authSource ? { authSource } : {},
		...extra
	};
}
//#endregion
//#region vendor/dockyard/packages/providers/src/native-transport.mjs
/**
* Small provider-neutral helpers for native streaming transports.
*
* The provider modules still own request/response translation. This file only
* handles the boring wire concerns that are shared by SSE based APIs:
* bounded fetches, SSE framing, usage normalization, and safe provider
* errors. Keeping this separate makes it possible to test each adapter with a
* fake fetch implementation without starting a provider CLI.
*/
function numericStatus(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function isLoopbackHostname(hostname) {
	const normalized = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
/**
* Validate an endpoint before an OAuth/API credential is attached to it.
* Provider integrations may opt into a custom HTTPS origin, but plaintext
* HTTP is only safe for an explicitly local development service.
*/
function validateNativeEndpoint(value, { providerId = "provider" } = {}) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${providerId} endpoint is required`);
	let url;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`${providerId} endpoint is invalid`);
	}
	if (url.username || url.password) throw new Error(`${providerId} endpoint must not include embedded credentials`);
	if (url.hash) throw new Error(`${providerId} endpoint must not include a URL fragment`);
	const localHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
	if (url.protocol !== "https:" && !localHttp) throw new Error(`${providerId} endpoint must use HTTPS; HTTP is only allowed for loopback development`);
	return url.toString();
}
function diagnosticText(value) {
	if (typeof value === "string") return value;
	if (value === void 0 || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
function errorDetails(value) {
	if (value === void 0 || value === null) return {};
	if (typeof value === "string") {
		const text = value.replace(/\s+/g, " ").trim();
		if (!text) return {};
		try {
			return errorDetails(JSON.parse(value));
		} catch {
			return { message: text };
		}
	}
	if (typeof value !== "object") return { message: String(value) };
	const nested = value.error;
	const nestedObject = nested && typeof nested === "object" ? nested : null;
	const message = [
		nestedObject?.message,
		typeof nested === "string" ? nested : null,
		value.message,
		nestedObject?.status,
		value.status
	].find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
	const code = [
		nestedObject?.code,
		value.code,
		nestedObject?.status,
		value.status
	].find((candidate) => candidate !== void 0 && candidate !== null && candidate !== "");
	const status = [nestedObject?.status, value.status].find((candidate) => candidate !== void 0 && candidate !== null && candidate !== "");
	return {
		...message ? { message: String(message).replace(/\s+/g, " ").trim().slice(0, 500) } : {},
		...code !== void 0 ? { code } : {},
		...status !== void 0 ? { status } : {}
	};
}
function isAuthenticationFailure(message, body) {
	const text = `${diagnosticText(message)} ${diagnosticText(body)}`.toLowerCase().replace(/[_-]+/g, " ");
	return [
		/access token.{0,80}(?:could not be validated|invalid|expired|revok|not valid|unauthor)/,
		/(?:invalid|expired|revok|unauthor|not valid).{0,80}(?:access token|token|credential)/,
		/\b(?:unauthorized|authentication failed|login required)\b/,
		/\bcredentials?\b.{0,50}\b(?:invalid|expired|missing|unavailable)\b/
	].some((pattern) => pattern.test(text));
}
function nativeProviderError(providerId, message, { status, body, code } = {}) {
	const bodyDetails = errorDetails(body);
	const messageDetails = errorDetails(message);
	const resolvedMessage = messageDetails.message ?? bodyDetails.message ?? (message ? String(message) : null);
	const resolvedCode = code ?? messageDetails.code ?? bodyDetails.code;
	const upstreamStatus = messageDetails.status ?? bodyDetails.status;
	const statusCode = numericStatus(status);
	const codeText = String(upstreamStatus ?? resolvedCode ?? "").toUpperCase();
	const exhaustionText = `${resolvedMessage ?? ""} ${diagnosticText(body)} ${diagnosticText(upstreamStatus)} ${diagnosticText(resolvedCode)}`.toLowerCase();
	const quotaExhausted = codeText === "RESOURCE_EXHAUSTED" || /\bresources?\b[\s\S]{0,80}\bexhausted\b/.test(exhaustionText) || /\bquota\b[\s\S]{0,80}\b(?:exhausted|depleted|exceeded)\b/.test(exhaustionText) || /\bcapacity\b[\s\S]{0,80}\bexhausted\b/.test(exhaustionText);
	const rateLimited = statusCode === 429 || numericStatus(resolvedCode) === 429 || numericStatus(upstreamStatus) === 429 || codeText === "RESOURCE_EXHAUSTED" || codeText === "RATE_LIMITED" || quotaExhausted;
	const displayMessage = quotaExhausted ? "额度或上游资源已耗尽，请刷新额度、切换账号或稍后重试" : rateLimited ? "请求频率受限，请切换账号或稍后重试" : resolvedMessage;
	const error = /* @__PURE__ */ new Error(`${providerId ?? "provider"} native request failed${displayMessage ? `: ${displayMessage}` : ""}`);
	error.providerId = providerId ?? null;
	if (status !== void 0 && status !== null) error.status = status;
	if (resolvedCode !== void 0 && resolvedCode !== null) {
		error.code = resolvedCode;
		error.upstreamCode = resolvedCode;
	}
	if (resolvedMessage) error.upstreamMessage = resolvedMessage;
	if (upstreamStatus !== void 0 && upstreamStatus !== null) error.upstreamStatus = upstreamStatus;
	error.authExpired = statusCode === 401 || isAuthenticationFailure(resolvedMessage, body);
	error.authForbidden = !error.authExpired && statusCode === 403;
	error.quotaExhausted = quotaExhausted;
	error.rateLimited = rateLimited;
	if (body !== void 0) error.body = body;
	return error;
}
const nativeResponseControls = /* @__PURE__ */ new WeakMap();
async function fetchNativeResponse(url, init = {}, { providerId, timeoutMs = 3e5, fetchImpl = fetch } = {}) {
	const controller = new AbortController();
	let timedOut = false;
	let cleaned = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const upstreamSignal = init.signal;
	const abort = () => controller.abort(upstreamSignal?.reason);
	const timeoutError = nativeProviderError(providerId, "request timed out");
	timeoutError.code = "ETIMEDOUT";
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		clearTimeout(timer);
		upstreamSignal?.removeEventListener?.("abort", abort);
	};
	const control = {
		cleanup,
		get timedOut() {
			return timedOut;
		},
		timeoutError
	};
	let handedOff = false;
	if (upstreamSignal) if (upstreamSignal.aborted) abort();
	else upstreamSignal.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetchImpl(url, {
			...init,
			signal: controller.signal
		});
		if (response.ok === false || response.status !== void 0 && response.status >= 400) {
			let body = null;
			try {
				body = await response.text();
			} catch {}
			const details = errorDetails(body);
			throw nativeProviderError(providerId, details.message, {
				status: response.status,
				body,
				code: details.code
			});
		}
		nativeResponseControls.set(response, control);
		handedOff = true;
		return response;
	} catch (error) {
		if (error?.name === "AbortError" && timedOut && !error.providerId) throw timeoutError;
		throw error;
	} finally {
		if (!handedOff) cleanup();
	}
}
async function* responseChunks(response) {
	if (!response?.body) return;
	if (typeof response.body[Symbol.asyncIterator] === "function") {
		for await (const chunk of response.body) yield chunk;
		return;
	}
	const reader = response.body.getReader?.();
	if (!reader) return;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		reader.releaseLock?.();
	}
}
function parseSseEvent(lines) {
	let event = "message";
	const data = [];
	for (const line of lines) {
		if (!line || line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
		if (field === "event") event = value;
		if (field === "data") data.push(value);
	}
	if (data.length === 0) return null;
	const raw = data.join("\n");
	if (raw.trim() === "[DONE]") return {
		event,
		data: null,
		done: true
	};
	try {
		return {
			event,
			data: JSON.parse(raw),
			raw
		};
	} catch {
		return {
			event,
			data: raw,
			raw
		};
	}
}
/** Yield parsed Server-Sent Events from a fetch Response. */
async function* readSseEvents(response) {
	const control = nativeResponseControls.get(response);
	const decoder = new TextDecoder();
	let buffer = "";
	let lines = [];
	try {
		for await (const chunk of responseChunks(response)) {
			buffer += decoder.decode(chunk, { stream: true });
			const parts = buffer.split(/\r?\n/);
			buffer = parts.pop() ?? "";
			for (const line of parts) {
				if (line !== "") {
					lines.push(line);
					continue;
				}
				const parsed = parseSseEvent(lines);
				lines = [];
				if (parsed) {
					yield parsed;
					if (parsed.done) return;
				}
			}
		}
		buffer += decoder.decode();
		if (buffer) lines.push(buffer);
		const parsed = parseSseEvent(lines);
		if (parsed) yield parsed;
	} catch (error) {
		if (control?.timedOut && !error?.providerId) throw control.timeoutError;
		throw error;
	} finally {
		control?.cleanup();
		nativeResponseControls.delete(response);
	}
}
function normalizeUsage(value) {
	if (!value || typeof value !== "object") return null;
	const inputTokens = Number(value.input_tokens ?? value.inputTokens ?? value.prompt_tokens ?? value.promptTokens ?? value.promptTokenCount);
	const outputTokens = Number(value.output_tokens ?? value.outputTokens ?? value.completion_tokens ?? value.completionTokens ?? value.candidatesTokenCount);
	const totalTokens = Number(value.total_tokens ?? value.totalTokens ?? value.totalTokenCount);
	const cacheReadTokens = Number(value.cache_read_input_tokens ?? value.cacheReadInputTokens ?? value.cachedContentTokenCount);
	const cacheWriteTokens = Number(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens);
	const result = {};
	if (Number.isFinite(inputTokens)) result.inputTokens = inputTokens;
	if (Number.isFinite(outputTokens)) result.outputTokens = outputTokens;
	if (Number.isFinite(totalTokens)) result.totalTokens = totalTokens;
	if (Number.isFinite(cacheReadTokens)) result.cacheReadTokens = cacheReadTokens;
	if (Number.isFinite(cacheWriteTokens)) result.cacheWriteTokens = cacheWriteTokens;
	return Object.keys(result).length > 0 ? result : null;
}
function textFromContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => textFromContent(part)).filter(Boolean).join("");
	if (!content || typeof content !== "object") return "";
	if (content.type === "image") return "";
	if (content.type === "tool-result") return textFromContent(content.content ?? content.output ?? content.result ?? content.text);
	return content.text ?? content.value ?? content.content ?? content.delta ?? "";
}
function parseToolArguments(value) {
	if (value && typeof value === "object") return value;
	if (typeof value !== "string" || value.length === 0) return {};
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
function base64FromBytes(value) {
	if (typeof value === "string") return value;
	if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString("base64");
	return null;
}
function dataUrlParts(value) {
	if (typeof value !== "string") return null;
	const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
	if (!match) return null;
	return {
		mediaType: match[1] || "application/octet-stream",
		data: match[0].includes(";base64,") ? match[2] : (() => {
			try {
				return Buffer.from(decodeURIComponent(match[2]), "utf8").toString("base64");
			} catch {
				return Buffer.from(match[2], "utf8").toString("base64");
			}
		})()
	};
}
async function resolveImageData(content, attachments) {
	const directData = base64FromBytes(content?.data ?? content?.base64 ?? content?.source?.data);
	if (directData) return {
		mediaType: content.mediaType ?? content.mimeType ?? content.source?.media_type ?? "application/octet-stream",
		data: directData
	};
	const dataUrl = dataUrlParts(content?.url ?? content?.source?.url);
	if (dataUrl) return dataUrl;
	const reference = content?.attachment ?? content?.ref ?? content?.source;
	if (!reference || !attachments?.readImage) return null;
	const image = await attachments.readImage(reference);
	const data = base64FromBytes(image?.data ?? image?.bytes ?? image?.base64);
	if (!data) return null;
	return {
		mediaType: content.mediaType ?? content.mimeType ?? image?.ref?.mediaType ?? image?.mediaType ?? "application/octet-stream",
		data
	};
}
function finishReason(value, fallback = "stop") {
	const reason = String(value ?? fallback).toLowerCase();
	if (reason.includes("tool") || reason === "function_call" || reason === "tool_use") return { kind: "tool-calls" };
	if (reason.includes("length") || reason.includes("max")) return { kind: "length" };
	if (reason.includes("error") || reason.includes("cancel")) return { kind: "error" };
	return { kind: "stop" };
}
//#endregion
//#region vendor/dockyard/modules/provider-antigravity/src/native-transport.mjs
const PROVIDER_ID$7 = "antigravity";
const DEFAULT_ENDPOINT$3 = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const DEFAULT_QUOTA_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const ANTIGRAVITY_INFO_PATHS = ["/Applications/Antigravity.app/Contents/Info.plist", join(homedir(), "Applications/Antigravity.app/Contents/Info.plist")];
function normalizeAntigravityClientVersion(value) {
	const version = String(value ?? "").trim();
	return /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}
function detectAntigravityUserAgent() {
	for (const infoPath of ANTIGRAVITY_INFO_PATHS) try {
		const version = normalizeAntigravityClientVersion(execFileSync("/usr/libexec/PlistBuddy", [
			"-c",
			"Print :CFBundleShortVersionString",
			infoPath
		], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}));
		if (version) return `antigravity/hub/${version} ${process.platform}/${process.arch}`;
	} catch {}
	return null;
}
function firstString$7(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
function emailFromObject(value, depth = 0) {
	if (!value || typeof value !== "object" || depth > 5) return null;
	const direct = firstString$7(value.email, value.userEmail, value.email_address, value.account?.email);
	if (direct) return direct;
	const idToken = firstString$7(value.id_token, value.idToken);
	if (idToken) try {
		const fromClaims = firstString$7(decodeJwtPayload(idToken)?.email);
		if (fromClaims) return fromClaims;
	} catch {}
	for (const child of Object.values(value)) {
		const email = emailFromObject(child, depth + 1);
		if (email) return email;
	}
	return null;
}
function tokenFromObject(value, depth = 0) {
	if (!value || typeof value !== "object" || depth > 5) return null;
	const direct = firstString$7(value.access_token, value.accessToken);
	if (direct) return direct;
	for (const child of Object.values(value)) {
		const token = tokenFromObject(child, depth + 1);
		if (token) return token;
	}
	return null;
}
function readOfficialTokenFile(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const token = tokenFromObject(parsed);
		return token ? {
			token,
			kind: "oauth",
			email: emailFromObject(parsed)
		} : null;
	} catch {
		return null;
	}
}
/** Read only the OAuth token file from an explicitly selected profile. */
function readAntigravityTokenFile({ env = process.env, home = homedir() } = {}) {
	return readOfficialTokenFile(env.DOCKYARD_ANTIGRAVITY_TOKEN_FILE || join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
}
/** Resolve Antigravity's local OAuth token without spawning `agy -p`. */
function resolveAntigravityAccessToken({ credential, env = process.env, home = homedir() } = {}) {
	const stored = firstString$7(credential?.access, credential?.token);
	if (stored) return {
		token: stored,
		kind: "oauth",
		email: emailFromObject(credential)
	};
	const fromCredentialObject = tokenFromObject(credential);
	if (fromCredentialObject) return {
		token: fromCredentialObject,
		kind: "oauth",
		email: emailFromObject(credential)
	};
	const fromEnv = firstString$7(env.DOCKYARD_ANTIGRAVITY_ACCESS_TOKEN, env.GEMINI_ACCESS_TOKEN);
	if (fromEnv) return {
		token: fromEnv,
		kind: "oauth"
	};
	return readAntigravityTokenFile({
		env,
		home
	});
}
async function geminiParts(content, attachments) {
	const values = Array.isArray(content) ? content : [content];
	const parts = [];
	for (const part of values) {
		if (typeof part === "string") {
			if (part) parts.push({ text: part });
			continue;
		}
		if (!part || typeof part !== "object") continue;
		if (part.type === "image") {
			const image = await resolveImageData(part, attachments);
			if (!image) throw nativeProviderError(PROVIDER_ID$7, "image attachment could not be resolved");
			parts.push({ inlineData: {
				mimeType: image.mediaType,
				data: image.data
			} });
			continue;
		}
		if (part.type === "tool-result" || part.type === "tool_result") {
			parts.push({ text: `[Tool Result ${part.toolCallId ?? part.id ?? ""}]\n${textFromContent(part.content ?? part.output ?? part.result ?? part.text)}` });
			continue;
		}
		if (part.type === "tool-call" || part.type === "tool_call" || part.type === "function-call") {
			parts.push({ functionCall: {
				name: part.name ?? part.function?.name ?? "tool",
				args: parseToolArguments(part.arguments ?? part.input ?? part.function?.arguments)
			} });
			continue;
		}
		const text = textFromContent(part);
		if (text) parts.push({ text });
	}
	return parts;
}
async function buildGeminiContents(request, attachments) {
	const contents = [];
	for (const message of Array.isArray(request.messages) ? request.messages : []) {
		const parts = await geminiParts(message?.content ?? message?.text, attachments);
		if (parts.length === 0) continue;
		contents.push({
			role: message?.role === "assistant" ? "model" : "user",
			parts
		});
	}
	if (contents.length === 0) contents.push({
		role: "user",
		parts: [{ text: "Continue the conversation." }]
	});
	return contents;
}
function sanitizeSchema(value) {
	if (Array.isArray(value)) return value.map(sanitizeSchema);
	if (!value || typeof value !== "object") return value;
	const result = {};
	for (const [key, child] of Object.entries(value)) {
		if ([
			"$schema",
			"additionalProperties",
			"strict"
		].includes(key)) continue;
		result[key] = sanitizeSchema(child);
	}
	return result;
}
function buildGeminiTools(tools) {
	if (!Array.isArray(tools)) return void 0;
	const declarations = tools.map((tool) => ({
		name: tool?.name ?? tool?.function?.name ?? "tool",
		...tool?.description ? { description: String(tool.description) } : {},
		parameters: sanitizeSchema(tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? { type: "object" })
	}));
	return declarations.length > 0 ? [{ functionDeclarations: declarations }] : void 0;
}
async function buildAntigravityRequest(request = {}, context = {}) {
	const nativeRequest = { contents: await buildGeminiContents(request, context.attachments) };
	if (typeof request.system === "string" && request.system.length > 0) nativeRequest.systemInstruction = { parts: [{ text: request.system }] };
	nativeRequest.generationConfig = {
		temperature: request.temperature ?? .7,
		maxOutputTokens: request.maxTokens ?? 4096
	};
	const tools = buildGeminiTools(request.tools);
	if (tools) nativeRequest.tools = tools;
	return nativeRequest;
}
function responsePayload(value) {
	if (!value || typeof value !== "object") return null;
	return value.response && typeof value.response === "object" ? value.response : value;
}
async function* streamAntigravityResponse(response) {
	let text = "";
	let textIndex = 0;
	let textOpen = true;
	let nextIndex = 1;
	let usage = null;
	let stop = "stop";
	let reasoning = null;
	yield {
		type: "block-start",
		index: textIndex,
		blockType: "text"
	};
	for await (const event of readSseEvents(response)) {
		const payload = responsePayload(event.data);
		if (!payload) continue;
		if (payload.error) throw nativeProviderError(PROVIDER_ID$7, payload.error.message ?? "Antigravity returned an error", {
			status: payload.error.code,
			body: payload.error
		});
		usage = normalizeUsage(payload.usageMetadata ?? payload.usage) ?? usage;
		const candidate = payload.candidates?.[0] ?? payload.candidate ?? payload;
		stop = candidate.finishReason ?? stop;
		for (const part of candidate.content?.parts ?? candidate.parts ?? []) {
			if (part?.text) {
				if (part.thought === true || part.thoughtSignature) {
					if (textOpen) {
						yield {
							type: "block-end",
							index: textIndex,
							block: {
								type: "text",
								text
							}
						};
						textOpen = false;
					}
					if (!reasoning) {
						reasoning = {
							index: nextIndex++,
							text: ""
						};
						yield {
							type: "block-start",
							index: reasoning.index,
							blockType: "reasoning"
						};
					}
					reasoning.text += part.text;
					yield {
						type: "reasoning-delta",
						index: reasoning.index,
						text: part.text
					};
					continue;
				}
				if (reasoning) {
					yield {
						type: "block-end",
						index: reasoning.index,
						block: {
							type: "reasoning",
							text: reasoning.text
						}
					};
					reasoning = null;
				}
				if (!textOpen) {
					textIndex = nextIndex++;
					text = "";
					textOpen = true;
					yield {
						type: "block-start",
						index: textIndex,
						blockType: "text"
					};
				}
				text += part.text;
				yield {
					type: "text-delta",
					index: textIndex,
					text: part.text
				};
				continue;
			}
			const call = part?.functionCall ?? part?.function_call;
			if (!call) continue;
			if (reasoning) {
				yield {
					type: "block-end",
					index: reasoning.index,
					block: {
						type: "reasoning",
						text: reasoning.text
					}
				};
				reasoning = null;
			}
			if (textOpen) {
				yield {
					type: "block-end",
					index: textIndex,
					block: {
						type: "text",
						text
					}
				};
				textOpen = false;
			}
			const index = nextIndex++;
			const id = firstString$7(call.id, call.name, `tool-${index}`);
			const name = firstString$7(call.name, "tool");
			const argumentsValue = JSON.stringify(call.args ?? call.arguments ?? {});
			yield {
				type: "block-start",
				index,
				blockType: "tool-call"
			};
			yield {
				type: "tool-call-delta",
				index,
				id,
				name,
				argumentsDelta: argumentsValue
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "tool-call",
					id,
					name,
					arguments: argumentsValue
				}
			};
			stop = "tool_calls";
		}
	}
	if (reasoning) yield {
		type: "block-end",
		index: reasoning.index,
		block: {
			type: "reasoning",
			text: reasoning.text
		}
	};
	if (textOpen) yield {
		type: "block-end",
		index: textIndex,
		block: {
			type: "text",
			text
		}
	};
	if (usage) yield {
		type: "usage",
		usage
	};
	yield {
		type: "finish",
		reason: finishReason(stop)
	};
}
function createAntigravityNativeExecutor({ endpoint = process.env.DOCKYARD_ANTIGRAVITY_ENDPOINT || DEFAULT_ENDPOINT$3, project = process.env.DOCKYARD_ANTIGRAVITY_PROJECT || "default-cli-project", env = process.env, timeoutMs = 3e5, fetchImpl = fetch, tokenResolver = resolveAntigravityAccessToken, projectResolver = null, userAgent = process.env.DOCKYARD_ANTIGRAVITY_USER_AGENT || detectAntigravityUserAgent() } = {}) {
	const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID$7 });
	const executor = async ({ request = {}, invocation, context = {} } = {}) => {
		let credential = null;
		if (context.secretStore) {
			const ref = invocation?.auth?.credentialRef ?? invocation?.account?.auth?.credentialRef ?? invocation?.account?.credentialRef;
			if (ref) credential = await context.secretStore.read(ref);
		}
		const auth = await tokenResolver({
			credential,
			env: {
				...env,
				...context.env ?? {}
			},
			home: homedir()
		});
		if (!auth?.token) {
			const error = nativeProviderError(PROVIDER_ID$7, "Antigravity OAuth token is unavailable; authorize Antigravity first");
			error.authExpired = true;
			throw error;
		}
		const resolvedProject = typeof projectResolver === "function" ? await projectResolver({
			credential,
			account: invocation?.account,
			context
		}) : project;
		if (!resolvedProject) throw nativeProviderError(PROVIDER_ID$7, "Antigravity Code Assist project is unavailable for the selected account");
		const body = {
			project: resolvedProject,
			model: request.model,
			request: await buildAntigravityRequest(request, context)
		};
		const headers = {
			authorization: `Bearer ${auth.token}`,
			"content-type": "application/json"
		};
		const resolvedUserAgent = userAgent ?? context.env?.DOCKYARD_ANTIGRAVITY_USER_AGENT ?? detectAntigravityUserAgent();
		if (resolvedUserAgent) headers["user-agent"] = resolvedUserAgent;
		return streamAntigravityResponse(await fetchNativeResponse(safeEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: context.signal
		}, {
			providerId: PROVIDER_ID$7,
			timeoutMs,
			fetchImpl
		}));
	};
	executor.nativeTransport = "gemini-stream-generate-content";
	return executor;
}
/**
* Read the same first-party quota summary used by `agy /quota`, without
* starting a new CLI process. The response is intentionally returned raw;
* the provider driver owns the live quota schema and can keep it dynamic.
*/
function createAntigravityNativeQuotaReader({ endpoint = process.env.DOCKYARD_ANTIGRAVITY_QUOTA_ENDPOINT || DEFAULT_QUOTA_ENDPOINT, env = process.env, home = homedir(), timeoutMs = 2e4, fetchImpl = fetch, tokenResolver = resolveAntigravityAccessToken, project = env.DOCKYARD_ANTIGRAVITY_PROJECT, projectResolver = null, userAgent = env.DOCKYARD_ANTIGRAVITY_USER_AGENT || detectAntigravityUserAgent() } = {}) {
	const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID$7 });
	return async ({ credential = null, account = null, context = {} } = {}) => {
		const auth = await tokenResolver({
			credential,
			env: {
				...env,
				...context.env ?? {}
			},
			home
		});
		if (!auth?.token) {
			const error = nativeProviderError(PROVIDER_ID$7, "Antigravity OAuth token is unavailable; authorize Antigravity first");
			error.authExpired = true;
			throw error;
		}
		const resolvedProject = typeof projectResolver === "function" ? await projectResolver({
			credential,
			account,
			context
		}) : project;
		const body = resolvedProject ? { project: resolvedProject } : {};
		const resolvedUserAgent = userAgent ?? context.env?.DOCKYARD_ANTIGRAVITY_USER_AGENT ?? detectAntigravityUserAgent();
		const headers = {
			authorization: `Bearer ${auth.token}`,
			"content-type": "application/json",
			accept: "application/json"
		};
		if (resolvedUserAgent) headers["user-agent"] = resolvedUserAgent;
		const response = await fetchNativeResponse(safeEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: context.signal
		}, {
			providerId: PROVIDER_ID$7,
			timeoutMs,
			fetchImpl
		});
		const raw = typeof response.json === "function" ? await response.json() : JSON.parse(await response.text());
		if (!raw || typeof raw !== "object") throw nativeProviderError(PROVIDER_ID$7, "quota summary response was not an object");
		return raw;
	};
}
Object.freeze({
	providerId: PROVIDER_ID$7,
	endpoint: DEFAULT_ENDPOINT$3,
	quotaEndpoint: DEFAULT_QUOTA_ENDPOINT
});
//#endregion
//#region vendor/dockyard/modules/provider-antigravity/src/driver.mjs
const PROVIDER_ID$6 = "antigravity";
const DEFAULT_CLI = "agy";
const DEFAULT_CATALOG_TTL_MS$1 = 6e4;
const DEFAULT_AUTH_TIMEOUT_MS = 600 * 1e3;
const CREDENTIAL_SLOT$3 = Symbol("dockyard-antigravity-session");
const ANTIGRAVITY_BROWSER_CLIENT_ID = process.env.DOCKYARD_ANTIGRAVITY_CLIENT_ID || "";
const ANTIGRAVITY_BROWSER_CLIENT_SECRET = process.env.DOCKYARD_ANTIGRAVITY_CLIENT_SECRET || "";
const ANTIGRAVITY_BROWSER_AUTHORIZATION_URL = process.env.DOCKYARD_ANTIGRAVITY_AUTHORIZATION_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const ANTIGRAVITY_BROWSER_TOKEN_URL = process.env.DOCKYARD_ANTIGRAVITY_TOKEN_URL || "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_BROWSER_USERINFO_URL = process.env.DOCKYARD_ANTIGRAVITY_USERINFO_URL || "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const ANTIGRAVITY_BROWSER_REDIRECT_URI = process.env.DOCKYARD_ANTIGRAVITY_REDIRECT_URI || "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_ALLOWED_ORIGINS = /* @__PURE__ */ new Set([
	"https://accounts.google.com",
	"https://oauth2.googleapis.com",
	"https://www.googleapis.com"
]);
function validateAntigravityEndpoint(value, label, expectedOrigin) {
	const url = new URL(value);
	if (url.protocol !== "https:" || !ANTIGRAVITY_ALLOWED_ORIGINS.has(url.origin) || expectedOrigin && url.origin !== expectedOrigin) throw new Error(`Antigravity ${label} endpoint must use its allowlisted HTTPS origin`);
	if (url.username || url.password || url.hash) throw new Error(`Antigravity ${label} endpoint is invalid`);
	return url.toString();
}
function validateAntigravityRedirect(value) {
	const url = new URL(value);
	if (url.protocol !== "http:" || ![
		"localhost",
		"127.0.0.1",
		"::1"
	].includes(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("Antigravity OAuth redirect must use loopback HTTP");
	return url.toString();
}
const ANTIGRAVITY_BROWSER_SCOPES = process.env.DOCKYARD_ANTIGRAVITY_OAUTH_SCOPE || [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs"
].join(" ");
const OFFICIAL_ANTIGRAVITY_MODEL_METADATA = Object.freeze([Object.freeze({
	id: "gemini-3.7-flash",
	contextWindow: 1048576,
	maxTokens: 65536
})]);
const ANTIGRAVITY_PTY_SCRIPT = String.raw`
import os
import pty
import select
import signal
import sys

command = sys.argv[1]
command_args = sys.argv[1:]
child_pid, pty_fd = pty.fork()
if child_pid == 0:
    os.execvpe(command, command_args, os.environ)

def terminate(_signum, _frame):
    try:
        os.kill(child_pid, signal.SIGTERM)
    except OSError:
        pass
    os._exit(143)

signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
stdin_open = True
exit_code = 1
try:
    while True:
        inputs = [pty_fd]
        if stdin_open:
            inputs.append(0)
        ready, _, _ = select.select(inputs, [], [], 0.25)
        if pty_fd in ready:
            try:
                data = os.read(pty_fd, 8192)
            except OSError:
                data = b""
            if not data:
                break
            os.write(1, data)
        if stdin_open and 0 in ready:
            data = os.read(0, 8192)
            if data:
                os.write(pty_fd, data)
            else:
                stdin_open = False
        waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
        if waited_pid:
            exit_code = os.waitstatus_to_exitcode(status)
            break
finally:
    try:
        os.close(pty_fd)
    except OSError:
        pass
    try:
        os.kill(child_pid, signal.SIGTERM)
    except OSError:
        pass
sys.exit(exit_code)
`;
function hash$3(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
function normalizeEmail(value) {
	return String(value ?? "").trim().match(EMAIL_PATTERN)?.[0] ?? null;
}
function findEmailField(value, depth = 0, seen = /* @__PURE__ */ new Set()) {
	if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
	seen.add(value);
	for (const [key, nested] of Object.entries(value)) {
		if (/email/i.test(key)) {
			const direct = normalizeEmail(nested);
			if (direct) return direct;
		}
		const child = findEmailField(nested, depth + 1, seen);
		if (child) return child;
	}
	return null;
}
/**
* Antigravity's local token file has no account profile. The official CLI may
* still return the authenticated email in its structured/status output or
* stderr. Read only that identity field; never scrape or expose token text.
*/
function extractAntigravityAccountEmail(...values) {
	for (const value of values) {
		const direct = normalizeEmail(value?.email ?? value?.account?.email ?? value?.user?.email ?? value?.identity?.email ?? value?.accountEmail ?? value?.userEmail ?? value?.email_address ?? value?.command?.data?.email ?? value?.command?.data?.email_address);
		if (direct) return direct;
		const nested = findEmailField(value);
		if (nested) return nested;
		const explicit = (typeof value === "string" ? value : "").match(/(?:applyAuthResult:\s*)?email\s*=\s*([^\s,;]+)|authenticated\s+successfully\s+as\s+([^\s,;]+)/i);
		const matched = normalizeEmail(explicit?.[1] ?? explicit?.[2]);
		if (matched) return matched;
	}
	return null;
}
function sessionFingerprint(session) {
	const email = typeof session?.email === "string" && session.email.length > 0 ? session.email : null;
	const token = typeof session?.token === "string" && session.token.length > 0 ? session.token : null;
	if (email) return hash$3(`antigravity-session:email:${email.toLowerCase()}`).slice(0, 10).toUpperCase();
	return token ? hash$3(`antigravity-session:${token}`).slice(0, 10).toUpperCase() : null;
}
function activeSessionError$2(message, { mismatch = false } = {}) {
	const error = new Error(message);
	error.authExpired = true;
	if (mismatch) error.accountMismatch = true;
	return error;
}
function sameEmail(left, right) {
	const a = normalizeEmail(left)?.toLowerCase();
	const b = normalizeEmail(right)?.toLowerCase();
	return Boolean(a && b && a === b);
}
function tokenExpiresAt(tokens, now = /* @__PURE__ */ new Date()) {
	return isoFromEpoch(tokens?.expiresAt ?? tokens?.expires_at) ?? addSecondsIso(tokens?.expires_in ?? tokens?.expiresIn, now);
}
function tokenNeedsRefresh$1(credential, now, leewayMs = 6e4) {
	if (!credential?.refresh) return false;
	if (!credential.expiresAt) return true;
	const expiresAt = Date.parse(credential.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= now.getTime() + leewayMs;
}
function cliFailure(code, signal, output, errorOutput) {
	const error = /* @__PURE__ */ new Error(`Antigravity CLI failed (${signal ?? code})`);
	error.code = code;
	const structured = parseJsonOutput(output);
	const structuredDetail = structured?.error ?? structured?.response ?? structured?.result?.error ?? structured?.result?.response;
	error.detail = String(errorOutput || structuredDetail || "").replace(/\s+/g, " ").trim().slice(0, 300);
	return error;
}
function runCommand(command, args, { env = process.env, timeoutMs = 3e4, signal, includeAccountInfo = false } = {}) {
	return new Promise((resolve, reject) => {
		const childEnv = { ...env };
		if (includeAccountInfo) delete childEnv.AGY_CLI_HIDE_ACCOUNT_INFO;
		else childEnv.AGY_CLI_HIDE_ACCOUNT_INFO ??= "1";
		const child = spawn(command, args, {
			env: childEnv,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			...signal ? { signal } : {}
		});
		const stdout = [];
		const stderr = [];
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const output = Buffer.concat(stdout).toString("utf8");
			const errorOutput = Buffer.concat(stderr).toString("utf8");
			if (code === 0) {
				resolve({
					output,
					errorOutput
				});
				return;
			}
			reject(cliFailure(code, signal, output, errorOutput));
		});
	});
}
function parseJsonOutput(output) {
	try {
		return JSON.parse(output);
	} catch {
		for (const line of String(output).split(/\r?\n/).reverse()) {
			if (!line.trim()) continue;
			try {
				return JSON.parse(line);
			} catch {}
		}
		return null;
	}
}
function runStreamingCommand(command, args, { env = process.env, timeoutMs = 3e5, signal } = {}) {
	return (async function* lines() {
		const child = spawn(command, args, {
			env: {
				...env,
				AGY_CLI_HIDE_ACCOUNT_INFO: "1"
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true,
			...signal ? { signal } : {}
		});
		const stdout = [];
		const stderr = [];
		let spawnError = null;
		let timedOut = false;
		let closedResult = null;
		let forceTimer = null;
		let timer = null;
		let terminationRequested = false;
		const terminate = () => {
			if (closedResult || terminationRequested) return;
			terminationRequested = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			forceTimer = setTimeout(() => {
				if (!closedResult) try {
					child.kill("SIGKILL");
				} catch {}
			}, 1e3);
			forceTimer.unref?.();
		};
		timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", (error) => {
			spawnError = error;
		});
		const closed = new Promise((resolve) => {
			child.once("close", (code, closeSignal) => {
				closedResult = {
					code,
					signal: closeSignal
				};
				clearTimeout(timer);
				if (forceTimer) clearTimeout(forceTimer);
				resolve(closedResult);
			});
		});
		const reader = createInterface({ input: child.stdout });
		try {
			for await (const line of reader) {
				stdout.push(line);
				yield line;
			}
		} finally {
			reader.close();
			terminate();
			clearTimeout(timer);
		}
		const result = await closed;
		const output = stdout.join("\n");
		const errorOutput = Buffer.concat(stderr).toString("utf8");
		if (spawnError) throw spawnError;
		if (result.code !== 0) throw cliFailure(result.code, timedOut ? "SIGTERM" : result.signal, output, errorOutput);
	})();
}
function normalizeToken(value) {
	return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function modelTier(model) {
	const labelMatch = /\(([^()]+)\)\s*$/.exec(model.name ?? "");
	if (!labelMatch) return null;
	const id = model.id.split("-").at(-1);
	const label = labelMatch[1].trim();
	if (!id || !label || normalizeToken(id) !== normalizeToken(label)) return null;
	return {
		id,
		name: label
	};
}
/**
* Convert the provider's exact model rows into DSH model metadata. A reasoning
* selector is added only when the provider actually returned multiple rows in
* one dynamically discovered family; no model names or tier vocabulary are
* embedded in Dockyard.
*/
function parseAntigravityModelCatalog(output) {
	const rows = String(output).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^fetching available models/i.test(line)).map((line) => {
		const [id, ...nameParts] = line.split("	");
		return {
			id,
			name: nameParts.join("	") || id
		};
	}).filter((model) => model.id);
	const families = /* @__PURE__ */ new Map();
	for (const model of rows) {
		const tier = modelTier(model);
		if (!tier) continue;
		const familyId = model.id.slice(0, -(tier.id.length + 1));
		const family = families.get(familyId) ?? /* @__PURE__ */ new Map();
		family.set(tier.id, tier);
		families.set(familyId, family);
	}
	return rows.map((model) => {
		const tier = modelTier(model);
		if (!tier) return model;
		const familyId = model.id.slice(0, -(tier.id.length + 1));
		const family = families.get(familyId);
		if (!family || family.size < 2) return model;
		const efforts = [...family.values()];
		return {
			...model,
			reasoning: {
				efforts: efforts.map((effort) => ({
					id: effort.id,
					name: effort.name
				})),
				defaultEffort: tier.id
			}
		};
	});
}
function registryModels(value) {
	if (Array.isArray(value)) return value;
	if (Array.isArray(value?.models)) return value.models;
	return [];
}
function mergedAntigravityRegistry(registry) {
	const byId = new Map(OFFICIAL_ANTIGRAVITY_MODEL_METADATA.map((model) => [model.id, { ...model }]));
	for (const candidate of registryModels(registry)) {
		if (!candidate || typeof candidate.id !== "string" || candidate.id.length === 0) continue;
		const defined = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== void 0 && value !== null));
		byId.set(candidate.id, {
			...byId.get(candidate.id) ?? {},
			...defined
		});
	}
	return [...byId.values()];
}
function catalogScopeKey(accounts) {
	const accountIds = (Array.isArray(accounts) ? accounts : []).map((account) => typeof account?.accountId === "string" ? account.accountId : "").filter(Boolean).sort();
	return accountIds.length > 0 ? `accounts:${hash$3(accountIds.join("\n")).slice(0, 32)}` : "unscoped";
}
function defaultAntigravityCatalogCachePath({ env = process.env, home = homedir() } = {}) {
	return join(env.DOCKYARD_DSH_HOME || join(home, ".dockyard-dsh"), "antigravity-catalog.json");
}
function persistableCatalog(value) {
	return {
		models: Array.isArray(value?.models) ? value.models : [],
		source: typeof value?.source === "string" ? value.source : "official_antigravity_cli"
	};
}
async function readAntigravityCatalogCache(filePath) {
	if (!filePath) return {
		schema: 1,
		entries: {}
	};
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8"));
		return {
			schema: 1,
			entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {}
		};
	} catch {
		return {
			schema: 1,
			entries: {}
		};
	}
}
async function writeAntigravityCatalogCache(filePath, cache) {
	if (!filePath) return;
	await mkdir(dirname(filePath), {
		recursive: true,
		mode: 448
	});
	const entries = Object.entries(cache.entries ?? {}).slice(-8);
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, JSON.stringify({
			schema: 1,
			entries: Object.fromEntries(entries)
		}), {
			encoding: "utf8",
			mode: 384
		});
		await rename(tempPath, filePath);
	} finally {
		await rm(tempPath, { force: true }).catch(() => {});
	}
}
function registryMatch(model, registry) {
	const candidates = registryModels(registry).filter((candidate) => candidate && typeof candidate.id === "string" && candidate.id.length > 0).filter((candidate) => model.id === candidate.id || model.id.startsWith(`${candidate.id}-`)).sort((left, right) => right.id.length - left.id.length);
	const exact = candidates.find((candidate) => candidate.id === model.id);
	if (exact) return exact;
	const family = candidates[0];
	if (!family || !model.reasoning?.efforts?.length) return null;
	const suffix = model.id.slice(family.id.length + 1);
	return model.reasoning.efforts.some((effort) => normalizeToken(effort.id) === normalizeToken(suffix)) ? family : null;
}
/**
* Fill only metadata absent from the provider's live model rows. The live
* Antigravity catalog remains authoritative for ids, names, and reasoning
* tiers; a registry is used solely as a second, inspectable source for
* capacities/modalities when the CLI omits them.
*/
function enrichAntigravityModelCatalog(models, registry) {
	return (Array.isArray(models) ? models : []).map((model) => {
		const match = registryMatch(model, registry);
		if (!match) return model;
		const contextWindow = finiteNumber(model.contextWindow ?? match.contextWindow ?? match.context_window ?? match.context_length);
		const maxTokens = finiteNumber(model.maxTokens ?? match.maxTokens ?? match.max_tokens ?? match.max_output_tokens);
		const inputModalities = Array.isArray(model.inputModalities) ? model.inputModalities : Array.isArray(match.input) ? match.input : void 0;
		return {
			...model,
			...Number.isInteger(contextWindow) ? { contextWindow } : {},
			...Number.isInteger(maxTokens) ? { maxTokens } : {},
			...inputModalities?.length ? { inputModalities: [...inputModalities] } : {}
		};
	});
}
/** Cache live provider output, persist account-scoped metadata, and collapse concurrent reads. */
function createAntigravityCatalogLoader({ cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI, env = process.env, home = homedir(), cacheFilePath = env.DOCKYARD_ANTIGRAVITY_CATALOG_CACHE ?? defaultAntigravityCatalogCachePath({
	env,
	home
}), timeoutMs = 3e4, cacheTtlMs = Number(process.env.DOCKYARD_ANTIGRAVITY_CATALOG_TTL_MS) || DEFAULT_CATALOG_TTL_MS$1, commandRunner = runCommand, registryLoader = null } = {}) {
	const cached = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const pendingRefreshes = /* @__PURE__ */ new Set();
	let persistentPromise = null;
	let persistentCache = null;
	let persistWrite = Promise.resolve();
	const loadPersistent = () => {
		persistentPromise ??= readAntigravityCatalogCache(cacheFilePath).then((value) => {
			persistentCache = value;
			return value;
		});
		return persistentPromise;
	};
	const persist = (scope, value) => {
		if (!cacheFilePath || !Array.isArray(value?.models) || value.models.length === 0) return Promise.resolve();
		persistWrite = persistWrite.then(async () => {
			const cache = await loadPersistent();
			cache.entries[scope] = {
				fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
				value: persistableCatalog(value)
			};
			const scopes = Object.keys(cache.entries);
			if (scopes.length > 8) for (const staleScope of scopes.slice(0, scopes.length - 8)) delete cache.entries[staleScope];
			await writeAntigravityCatalogCache(cacheFilePath, cache);
		}).catch(() => {});
		return persistWrite;
	};
	const refresh = (scope) => {
		if (pending.has(scope)) return pending.get(scope);
		const promise = Promise.resolve(commandRunner(cliPath, ["models"], {
			env,
			timeoutMs
		})).then(async (result) => {
			let registry = [];
			if (typeof registryLoader === "function") try {
				registry = await registryLoader();
			} catch {}
			const liveModels = parseAntigravityModelCatalog(result.output);
			const models = enrichAntigravityModelCatalog(liveModels, mergedAntigravityRegistry(registry));
			const value = {
				models,
				source: models.some((model, index) => {
					const original = liveModels[index];
					return model.contextWindow !== original?.contextWindow || model.maxTokens !== original?.maxTokens;
				}) ? "official_antigravity_cli+model_registry" : "official_antigravity_cli"
			};
			cached.set(scope, {
				value,
				cachedAt: Date.now()
			});
			await persist(scope, value);
			return value;
		}).catch((error) => {
			const previous = cached.get(scope)?.value;
			if (previous?.models?.length) return {
				...previous,
				source: `${previous.source ?? "official_antigravity_cli"}_stale`,
				diagnostics: [redactError(error)]
			};
			const unavailable = {
				models: [],
				source: error?.code === "ENOENT" ? "antigravity_cli_not_found" : "antigravity_cli_unavailable",
				diagnostics: [redactError(error)]
			};
			cached.set(scope, {
				value: unavailable,
				cachedAt: Date.now()
			});
			return unavailable;
		}).finally(() => {
			pending.delete(scope);
		});
		pendingRefreshes.add(promise);
		promise.finally(() => pendingRefreshes.delete(promise)).catch(() => {});
		pending.set(scope, promise);
		return promise;
	};
	const loadCatalog = async function loadCatalog({ force = false, accounts = [] } = {}) {
		const scope = catalogScopeKey(accounts);
		let entry = cached.get(scope);
		if (!entry) {
			const persisted = await loadPersistent();
			const stored = persistentCache?.entries?.[scope] ?? persisted.entries?.[scope];
			if (stored?.value && Array.isArray(stored.value.models)) {
				entry = {
					value: {
						...stored.value,
						source: `${stored.value.source ?? "official_antigravity_cli"}_persistent_cache`
					},
					cachedAt: 0
				};
				cached.set(scope, entry);
			}
		}
		const fresh = entry && entry.cachedAt > 0 && Date.now() - entry.cachedAt < cacheTtlMs;
		if (!force && fresh) return entry.value;
		if (!force && entry) {
			refresh(scope).catch(() => {});
			return entry.value;
		}
		return refresh(scope);
	};
	loadCatalog.whenIdle = async () => {
		await Promise.allSettled([...pendingRefreshes]);
		await persistWrite.catch(() => {});
	};
	return loadCatalog;
}
function familyPrefixForModel(model) {
	const defaultEffort = model?.reasoning?.defaultEffort;
	if (typeof defaultEffort !== "string" || defaultEffort.length === 0) return null;
	const suffix = `-${defaultEffort}`;
	return model.id.endsWith(suffix) ? model.id.slice(0, -suffix.length) : null;
}
/**
* Antigravity exposes tiered Gemini rows as exact model IDs. Resolve a DSH
* model+effort pair to the exact returned row and omit --effort; the CLI
* rejects passing an encoded tier together with a different effort flag.
*/
async function resolveAntigravityInvocationModel({ catalogLoader, model, reasoningEffort } = {}) {
	if (typeof model !== "string" || typeof reasoningEffort !== "string" || !catalogLoader) return {
		model,
		reasoningEffort
	};
	try {
		const catalog = await catalogLoader();
		const selected = catalog?.models?.find((candidate) => candidate?.id === model);
		const prefix = familyPrefixForModel(selected);
		if (!selected || !prefix) return {
			model,
			reasoningEffort
		};
		const target = catalog.models.find((candidate) => {
			return candidate?.id?.startsWith(`${prefix}-`) && candidate.reasoning?.defaultEffort === reasoningEffort;
		});
		if (!target) return {
			model,
			reasoningEffort
		};
		return {
			model: target.id,
			reasoningEffort: void 0
		};
	} catch {
		return {
			model,
			reasoningEffort
		};
	}
}
function contentText(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
	if (!value || typeof value !== "object") return "";
	if (typeof value.text === "string") return value.text;
	if (typeof value.content === "string" || Array.isArray(value.content)) return contentText(value.content);
	if (value.type === "image") return "[previous image attachment omitted by Antigravity CLI]";
	if (value.type === "tool-call") return `[tool call: ${value.name ?? "unknown"}] ${value.arguments ?? ""}`;
	if (value.type === "tool-result") return contentText(value.content);
	return "";
}
function estimatedTokens(value) {
	const text = String(value ?? "");
	if (!text) return 0;
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
function messageText(message) {
	return contentText(message?.content ?? message?.text);
}
function messagesWithinContext(request) {
	const messages = Array.isArray(request.messages) ? request.messages : [];
	const contextWindow = finiteNumber(request.modelContext?.contextWindow);
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) return messages;
	const outputBudget = finiteNumber(request.maxTokens ?? request.modelContext?.maxTokens);
	const inputBudget = contextWindow - (Number.isInteger(outputBudget) ? outputBudget : 0);
	if (inputBudget <= 0) return messages.slice(-1);
	const systemMessages = messages.filter((message) => message?.role === "system");
	const otherMessages = messages.filter((message) => message?.role !== "system");
	let used = estimatedTokens(request.system);
	for (const message of systemMessages) used += estimatedTokens(messageText(message));
	if (used + otherMessages.reduce((sum, message) => sum + estimatedTokens(messageText(message)), 0) <= inputBudget) return messages;
	const selected = [];
	for (let index = otherMessages.length - 1; index >= 0; index -= 1) {
		const message = otherMessages[index];
		const cost = estimatedTokens(messageText(message));
		if (selected.length === 0 || used + cost <= inputBudget) {
			selected.unshift(message);
			used += cost;
		}
	}
	return [...systemMessages, ...selected];
}
function antigravityRequestPrompt(request = {}) {
	const sections = [];
	if (typeof request.system === "string" && request.system.length > 0) sections.push(`system:\n${request.system}`);
	for (const message of messagesWithinContext(request)) {
		const text = messageText(message);
		if (!text) continue;
		sections.push(`${message?.role ?? "message"}:\n${text}`);
	}
	return sections.join("\n\n") || "Continue the conversation.";
}
function usageFromResponse(usage) {
	if (!usage || typeof usage !== "object") return null;
	const inputTokens = Number(usage.input_tokens ?? usage.inputTokens);
	const outputTokens = Number(usage.output_tokens ?? usage.outputTokens);
	if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
	return {
		inputTokens,
		outputTokens,
		...Number.isFinite(Number(usage.reasoning_tokens ?? usage.reasoningTokens)) ? { reasoningTokens: Number(usage.reasoning_tokens ?? usage.reasoningTokens) } : {}
	};
}
function streamEventTexts(payload) {
	if (!payload || typeof payload !== "object") return [];
	const eventName = String(payload.event ?? payload.type ?? "").toLowerCase();
	const allowText = /delta|message|text|content/.test(eventName) && !/command_result|result/.test(eventName);
	const texts = [];
	function visit(value, allowNestedText = false, key = "") {
		if (typeof value === "string") {
			if (allowNestedText && key !== "event" && key !== "type") texts.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, allowNestedText, key);
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const [childKey, child] of Object.entries(value)) {
			const normalizedKey = childKey.toLowerCase().replace(/[-_]/g, "");
			if (normalizedKey === "textdelta" || normalizedKey === "contentdelta") {
				if (typeof child === "string") texts.push(child);
				else visit(child, true, childKey);
				continue;
			}
			if (normalizedKey === "delta") {
				if (typeof child === "string") texts.push(child);
				else visit(child, true, childKey);
				continue;
			}
			if (normalizedKey === "response" || normalizedKey === "error" || normalizedKey === "usage") continue;
			if (normalizedKey === "text" && (allowNestedText || allowText)) {
				if (typeof child === "string") texts.push(child);
				continue;
			}
			if (child && typeof child === "object") visit(child, allowNestedText || normalizedKey.includes("content") || normalizedKey.includes("message"), childKey);
		}
	}
	visit(payload, allowText);
	return texts;
}
function streamEventResult(payload) {
	if (!payload || typeof payload !== "object") return null;
	const result = payload.result ?? payload.response;
	if (typeof result === "string") return {
		text: result,
		usage: payload.usage
	};
	if (!result || typeof result !== "object") return null;
	return {
		text: typeof result.response === "string" ? result.response : contentText(result.response),
		usage: result.usage ?? payload.usage,
		status: result.status,
		error: result.error
	};
}
function requestTool(request, providerToolName) {
	const tools = Array.isArray(request?.tools) ? request.tools : [];
	const exact = tools.find((tool) => tool?.name === providerToolName);
	if (exact) return {
		name: exact.name,
		definition: exact
	};
	if (providerToolName === "run_command") {
		const bash = tools.find((tool) => tool?.name === "bash");
		if (bash) return {
			name: bash.name,
			definition: bash
		};
	}
	return null;
}
function toolCallFromEvent(payload, request) {
	const update = payload?.step_update;
	if (!update || String(update.state ?? "").toUpperCase() !== "ACTIVE" || update.step_type !== "tool") return null;
	const providerName = String(update.tool_name ?? update.tool_info?.name ?? "");
	if (!providerName) return null;
	const target = requestTool(request, providerName);
	if (!target) return null;
	const raw = update.tool_info?.parameters;
	const parameters = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
	if (providerName === "run_command" && target.name === "bash") {
		const command = parameters.command ?? parameters.CommandLine;
		if (typeof command === "string" && command.length > 0) return {
			name: target.name,
			arguments: {
				command,
				description: parameters.description ?? parameters.Description ?? "Run the requested command",
				...parameters.workdir ?? parameters.Cwd ? { workdir: parameters.workdir ?? parameters.Cwd } : {},
				...parameters.timeoutMs ?? parameters.TimeoutMs ? { timeoutMs: parameters.timeoutMs ?? parameters.TimeoutMs } : {}
			},
			id: String(update.tool_info?.call_id ?? update.call_id ?? `agy-${hash$3(JSON.stringify({
				update,
				requestId: request.requestId ?? ""
			})).slice(0, 20)}`)
		};
	}
	return {
		name: target.name,
		arguments: parameters,
		id: String(update.tool_info?.call_id ?? update.call_id ?? `agy-${hash$3(JSON.stringify({
			update,
			requestId: request.requestId ?? ""
		})).slice(0, 20)}`)
	};
}
function appendDelta(current, next) {
	if (!next) return "";
	if (!current) return next;
	if (next.startsWith(current)) return next.slice(current.length);
	if (current.endsWith(next)) return "";
	return next;
}
/** Execute text turns through the installed official Antigravity CLI. */
function createAntigravityCliExecutor({ cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI, env = process.env, timeoutMs = 3e5, commandRunner = runCommand, catalogLoader = null, streamCommandRunner = runStreamingCommand } = {}) {
	return async function executeAntigravity({ request = {} } = {}) {
		if (contentHasImageInCurrentTurn(request)) throw unsupportedContentError(PROVIDER_ID$6, "Antigravity CLI 当前没有暴露可接收 DSH 图片附件的原生输入通道");
		const resolved = await resolveAntigravityInvocationModel({
			catalogLoader,
			model: request.model,
			reasoningEffort: request.reasoningEffort
		});
		return (async function* responseStream() {
			const args = ["-p", antigravityRequestPrompt(request)];
			if (typeof resolved.model === "string" && resolved.model.length > 0) args.push("--model", resolved.model);
			if (typeof resolved.reasoningEffort === "string" && resolved.reasoningEffort.length > 0) args.push("--effort", resolved.reasoningEffort);
			args.push("--sandbox", "--output-format", "stream-json");
			yield {
				type: "block-start",
				index: 0,
				blockType: "text"
			};
			let text = "";
			let usage = null;
			const handledTools = /* @__PURE__ */ new Set();
			for await (const line of streamCommandRunner(cliPath, args, {
				env,
				timeoutMs,
				signal: request.signal
			})) {
				const parsed = parseJsonOutput(line);
				if (!parsed) continue;
				const tool = toolCallFromEvent(parsed, request);
				if (tool) {
					const key = `${tool.id}:${tool.name}:${JSON.stringify(tool.arguments)}`;
					if (handledTools.has(key)) continue;
					handledTools.add(key);
					yield {
						type: "block-end",
						index: 0,
						block: {
							type: "text",
							text
						}
					};
					yield {
						type: "block-start",
						index: 1,
						blockType: "tool-call"
					};
					yield {
						type: "block-end",
						index: 1,
						block: {
							type: "tool-call",
							id: tool.id,
							name: tool.name,
							arguments: JSON.stringify(tool.arguments)
						}
					};
					yield {
						type: "finish",
						reason: { kind: "tool-calls" }
					};
					return;
				}
				for (const delta of streamEventTexts(parsed)) {
					const next = appendDelta(text, delta);
					if (!next) continue;
					text += next;
					yield {
						type: "text-delta",
						index: 0,
						text: next
					};
				}
				const final = streamEventResult(parsed);
				if (final) {
					if (final.status && final.status !== "SUCCESS") {
						const error = /* @__PURE__ */ new Error("Antigravity CLI request did not complete");
						error.detail = final.error ?? final.text ?? null;
						throw error;
					}
					const next = appendDelta(text, final.text);
					if (next) {
						text += next;
						yield {
							type: "text-delta",
							index: 0,
							text: next
						};
					}
					usage = usageFromResponse(final.usage) ?? usage;
				}
				usage = usageFromResponse(parsed.usage) ?? usage;
			}
			yield {
				type: "block-end",
				index: 0,
				block: {
					type: "text",
					text
				}
			};
			if (usage) yield {
				type: "usage",
				usage
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		})();
	};
}
function quotaGroups(data) {
	if (!data || typeof data !== "object") return [];
	if (Array.isArray(data.groups)) return data.groups;
	if (Array.isArray(data.quota_groups)) return data.quota_groups;
	if (Array.isArray(data.quotaGroups)) return data.quotaGroups;
	return [];
}
function findQuotaData(value, depth = 0, seen = /* @__PURE__ */ new Set()) {
	if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
	seen.add(value);
	if (quotaGroups(value).length > 0) return value;
	for (const key of [
		"command",
		"data",
		"response",
		"quota_summary",
		"quotaSummary",
		"result"
	]) {
		const found = findQuotaData(value[key], depth + 1, seen);
		if (found) return found;
	}
	return null;
}
function findCreditsData(value, depth = 0, seen = /* @__PURE__ */ new Set()) {
	if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
	seen.add(value);
	if (Object.hasOwn(value, "remaining_credits") || Object.hasOwn(value, "remainingCredits")) return value;
	for (const child of Object.values(value)) {
		const found = findCreditsData(child, depth + 1, seen);
		if (found) return found;
	}
	return null;
}
function parseQuotaData(data, now = /* @__PURE__ */ new Date(), source = "antigravity_cli") {
	const windows = [];
	for (const group of quotaGroups(data)) for (const bucket of group?.buckets ?? []) {
		const fraction = finiteNumber(bucket.remaining_fraction ?? bucket.remainingFraction);
		const percent = finiteNumber(bucket.remaining_percent ?? bucket.remainingPercent);
		const remaining = fraction ?? (percent === null ? null : percent / 100);
		windows.push({
			id: stringValue(bucket.id) ?? `${group.name ?? "group"}:${bucket.name ?? "window"}`,
			name: [group.name, bucket.name].filter(Boolean).join(" / ") || null,
			remaining,
			limit: remaining === null ? null : 1,
			unit: remaining === null ? null : "fraction",
			resetAt: isoFromEpoch(bucket.reset_time ?? bucket.resetTime),
			updatedAt: now.toISOString(),
			source
		});
	}
	return windows;
}
function parseQuotaText(text, now = /* @__PURE__ */ new Date(), source = "antigravity_cli") {
	const windows = [];
	for (const line of text.split(/\r?\n/)) {
		const parts = line.split("	");
		if (parts.length < 3 || !/%$/.test(parts[2])) continue;
		const remaining = finiteNumber(parts[2].replace(/%$/, ""));
		if (remaining === null) continue;
		windows.push({
			id: `${parts[0]}:${parts[1]}`,
			name: `${parts[0]} / ${parts[1]}`,
			remaining,
			limit: 100,
			unit: "percent",
			resetAt: isoFromEpoch(parts[3]),
			updatedAt: now.toISOString(),
			source
		});
	}
	return windows;
}
/** Normalize the live first-party quota summary without embedding its rows. */
function parseAntigravityNativeQuota(value, now = /* @__PURE__ */ new Date()) {
	let windows = parseQuotaData(findQuotaData(value), now, "antigravity_native");
	if (windows.length === 0) windows = recursiveQuotaWindows(value, {
		source: "antigravity_native",
		now,
		prefix: "antigravity"
	});
	const credits = findCreditsData(value);
	return {
		windows,
		credits: credits ? {
			remaining: finiteNumber(credits.remaining_credits ?? credits.remainingCredits),
			upgradeUri: stringValue(credits.upgrade_uri ?? credits.upgradeUri)
		} : null
	};
}
function candidate(now, { email = null, session = null, existingAccounts = [], source = "official_antigravity_cli", sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.CLI } = {}) {
	const normalizedEmail = normalizeEmail(email);
	const capturedSession = normalizedEmail && session && !session.email ? {
		...session,
		email: normalizedEmail
	} : session;
	const fingerprint = sessionFingerprint(capturedSession);
	const stableAccountId = normalizedEmail ? `antigravity:google:${hash$3(`email:${normalizedEmail.toLowerCase()}`).slice(0, 20)}` : fingerprint ? `antigravity:session:${hash$3(`fingerprint:${fingerprint}`).slice(0, 20)}` : "antigravity:active";
	const known = existingAccounts.find((account) => fingerprint && account?.resources?.sessionFingerprint === fingerprint || sameEmail(account?.email, normalizedEmail));
	const legacy = existingAccounts.find((account) => account?.accountId === "antigravity:active");
	const accountId = known?.accountId ?? (legacy && !legacy.resources?.sessionFingerprint && stableAccountId !== "antigravity:active" ? legacy.accountId : stableAccountId);
	const identityLabel = normalizedEmail ?? (fingerprint ? `Antigravity 官方会话 · ${fingerprint}` : "Antigravity 官方当前会话");
	const identitySource = normalizedEmail ? "official_cli_auth_status" : fingerprint ? "local_oauth_session_fingerprint" : "official_active_session";
	const credentialRef = createCredentialRef(PROVIDER_ID$6, accountId);
	const value = {
		candidateId: `antigravity:${hash$3(accountId).slice(0, 20)}`,
		providerId: PROVIDER_ID$6,
		source,
		accountId,
		displayName: identityLabel,
		email: normalizedEmail,
		subscription: {
			plan: null,
			status: null,
			expiresAt: null
		},
		refresh: {
			accessTokenExpiresAt: capturedSession?.expiresAt ?? null,
			nextRefreshAt: null,
			lastRefreshedAt: capturedSession?.lastRefreshedAt ?? null,
			refreshable: capturedSession?.refreshToken ? true : null
		},
		imported: false,
		status: "available",
		diagnostic: null,
		credentialRef,
		resources: {
			...officialSessionResources({
				sourceKind,
				authSource: source
			}),
			identitySource,
			identityLabel,
			...fingerprint ? { sessionFingerprint: fingerprint } : {},
			identityNote: normalizedEmail ? "账号邮箱来自官方 Antigravity 登录态" : fingerprint ? "官方登录态未返回邮箱；使用会话指纹区分账号" : "官方只返回当前会话；切换账号后请重新扫描",
			sessionPersistence: capturedSession?.token ? "captured" : "active"
		}
	};
	Object.defineProperty(value, CREDENTIAL_SLOT$3, {
		value: {
			type: OFFICIAL_SESSION_AUTH_KIND,
			providerId: PROVIDER_ID$6,
			...capturedSession?.token ? { access: capturedSession.token } : {},
			...capturedSession?.refreshToken ? { refresh: capturedSession.refreshToken } : {},
			...normalizedEmail ? { email: normalizedEmail } : {},
			...capturedSession?.expiresAt ? { expiresAt: capturedSession.expiresAt } : {},
			...capturedSession?.lastRefreshedAt ? { lastRefreshedAt: capturedSession.lastRefreshedAt } : {}
		},
		enumerable: false
	});
	return value;
}
function summarizeAntigravityCandidate(value) {
	return {
		providerId: PROVIDER_ID$6,
		candidateId: value.candidateId,
		source: value.source,
		accountId: value.accountId,
		displayName: value.displayName,
		email: value.email,
		subscription: { ...value.subscription },
		refresh: { ...value.refresh },
		resources: { ...value.resources },
		imported: Boolean(value.imported),
		status: value.status ?? "available",
		diagnostic: value.diagnostic ?? null
	};
}
const ANTIGRAVITY_AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/(?:o\/oauth2\/auth|o\/oauth2\/v2\/auth|signin\/oauth)\?[^\s"'<>]+/i;
function cleanAntigravityAuthUrl(value) {
	return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[),.;]+$/, "");
}
function publicAntigravityAuthSession(session) {
	return {
		sessionId: session.sessionId,
		providerId: PROVIDER_ID$6,
		status: session.status ?? (session.exitCode === null ? "pending" : "processing"),
		authorizationUrl: session.authorizationUrl,
		instructions: session.instructions,
		startedAt: session.startedAt,
		...session.browserOpened ? { browserOpened: true } : {},
		...session.inputRequired ? { inputRequired: true } : {},
		diagnostic: session.diagnostic ?? null
	};
}
/**
* Start agy's own Google OAuth flow in a temporary profile.
*
* agy has no separate login subcommand: its normal `agy -p` command starts
* the official OAuth flow when that profile is unauthenticated. Running it
* with an isolated HOME lets DSH add another Google account without touching
* the user's active CLI session. The child is never attached to a terminal;
* only the authorization URL and the resulting token are used.
*/
function createAntigravityOAuthAuthorizer({ cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI, environment = process.env, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS, prompt = "Reply with OK", spawnImpl = spawn, tokenReader = readAntigravityTokenFile, usePty = process.platform === "darwin", ptyPythonPath = process.env.DOCKYARD_ANTIGRAVITY_PTY_PYTHON || "python3", instructions = "已打开 Google 官方验证页；选择账号并完成验证后，DSH 会自动接入。" } = {}) {
	if (!cliPath) throw new Error("Antigravity OAuth authorizer requires an agy CLI path");
	if (typeof spawnImpl !== "function") throw new Error("Antigravity OAuth authorizer requires a process spawner");
	if (typeof tokenReader !== "function") throw new Error("Antigravity OAuth authorizer requires a token reader");
	const sessions = /* @__PURE__ */ new Map();
	async function cleanup(session) {
		if (!session.profileDir) return;
		await rm(session.profileDir, {
			recursive: true,
			force: true
		}).catch(() => {});
		session.profileDir = null;
	}
	function capture(session, chunk) {
		session.output = `${session.output}${String(chunk ?? "")}`.slice(-32e3);
		if (!session.authorizationUrl) {
			const match = session.output.match(ANTIGRAVITY_AUTH_URL_PATTERN);
			if (match?.[0]) session.authorizationUrl = cleanAntigravityAuthUrl(match[0]);
		}
		if (/authorization code|redirect URL/i.test(session.output)) session.inputRequired = true;
	}
	function readToken(session) {
		try {
			return tokenReader({
				env: session.childEnv,
				home: session.profileDir
			});
		} catch {
			return null;
		}
	}
	async function finalize(session, context, credential = null) {
		if (session.result) return session.result;
		if (session.finalizing) return session.finalizing;
		session.finalizing = (async () => {
			try {
				const auth = credential ?? readToken(session);
				if (!auth?.token) {
					if (session.exitCode === null) return publicAntigravityAuthSession(session);
					session.status = "failed";
					session.diagnostic = session.timedOut ? "Google 验证超时，请重新点击登录添加账号。" : session.launchError ? `无法启动 agy 官方验证：${session.launchError}` : `agy 官方验证未完成（退出码 ${session.exitCode ?? "unknown"}）。`;
					return publicAntigravityAuthSession(session);
				}
				if (session.child && session.exitCode === null) session.child.kill("SIGTERM");
				const account = candidate(context?.now instanceof Date ? context.now : /* @__PURE__ */ new Date(), {
					email: extractAntigravityAccountEmail(session.output),
					session: auth,
					existingAccounts: context?.accounts ?? [],
					source: "official_antigravity_browser_oauth",
					sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER
				});
				session.status = "completed";
				session.result = {
					...publicAntigravityAuthSession(session),
					status: "completed",
					accounts: [account],
					diagnostic: null
				};
				return session.result;
			} catch (error) {
				session.status = "failed";
				session.diagnostic = redactError(error);
				return publicAntigravityAuthSession(session);
			} finally {
				if (session.status === "completed" || session.status === "failed") {
					if (session.timer) clearTimeout(session.timer);
					await cleanup(session);
				}
			}
		})();
		return session.finalizing;
	}
	async function begin() {
		const profileDir = await mkdtemp(join(tmpdir(), "dockyard-antigravity-oauth-"));
		const tokenPath = join(profileDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
		const childEnv = {
			...environment,
			HOME: profileDir,
			XDG_CONFIG_HOME: join(profileDir, ".config"),
			DOCKYARD_ANTIGRAVITY_TOKEN_FILE: tokenPath
		};
		delete childEnv.AGY_CLI_HIDE_ACCOUNT_INFO;
		const session = {
			sessionId: `${PROVIDER_ID$6}:${randomUUID()}`,
			providerId: PROVIDER_ID$6,
			profileDir,
			childEnv,
			status: "pending",
			authorizationUrl: null,
			instructions,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			browserOpened: true,
			exitCode: null,
			launchError: null,
			output: "",
			inputRequired: false,
			timedOut: false,
			child: null,
			timer: null,
			finalizing: null,
			result: null,
			diagnostic: null
		};
		sessions.set(session.sessionId, session);
		try {
			const child = spawnImpl(usePty ? ptyPythonPath : cliPath, usePty ? [
				"-u",
				"-c",
				ANTIGRAVITY_PTY_SCRIPT,
				cliPath,
				"-p",
				prompt,
				"--output-format",
				"json"
			] : [
				"-p",
				prompt,
				"--output-format",
				"json"
			], {
				env: childEnv,
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				],
				windowsHide: true
			});
			session.child = child;
			child.stdout?.on("data", (chunk) => capture(session, chunk));
			child.stderr?.on("data", (chunk) => capture(session, chunk));
			child.once("error", (error) => {
				session.launchError = redactError(error);
				session.exitCode = -1;
			});
			child.once("close", (code) => {
				session.exitCode = typeof code === "number" ? code : -1;
			});
			session.timer = setTimeout(() => {
				if (session.exitCode !== null) return;
				session.timedOut = true;
				child.kill("SIGTERM");
			}, timeoutMs);
			session.timer.unref?.();
		} catch (error) {
			session.launchError = redactError(error);
			session.exitCode = -1;
		}
		return publicAntigravityAuthSession(session);
	}
	async function poll(sessionId, context = {}) {
		const session = sessions.get(sessionId);
		if (!session) return {
			sessionId,
			providerId: PROVIDER_ID$6,
			status: "missing",
			instructions,
			diagnostic: "验证会话不存在或已结束，请重新点击登录添加账号。"
		};
		if (session.result) return session.result;
		const credential = readToken(session);
		if (!credential?.token && session.exitCode === null) return publicAntigravityAuthSession(session);
		const result = await finalize(session, context, credential);
		if (!["pending", "processing"].includes(result.status)) sessions.delete(sessionId);
		return result;
	}
	async function submitAuthorizationCode(sessionId, value) {
		const session = sessions.get(sessionId);
		if (!session) throw new Error("验证会话不存在或已结束，请重新点击登录添加账号");
		const code = String(value ?? "").trim();
		if (!code) throw new Error("请输入 Google 验证码或回调地址");
		if (code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) throw new Error("Google 验证码或回调地址格式无效");
		if (!session.child || session.exitCode !== null || !session.child.stdin?.writable) throw new Error("agy 验证进程已结束，请重新点击登录添加账号");
		session.child.stdin.write(`${code}\n`);
		session.inputRequired = false;
		session.status = "processing";
		session.instructions = "授权码已提交，正在等待官方登录完成。";
		return publicAntigravityAuthSession(session);
	}
	async function dispose() {
		const active = [...sessions.values()];
		sessions.clear();
		await Promise.all(active.map(async (session) => {
			if (session.timer) clearTimeout(session.timer);
			if (session.child && session.exitCode === null) session.child.kill("SIGTERM");
			await cleanup(session);
		}));
	}
	async function cancel(sessionId) {
		const session = sessions.get(sessionId);
		if (!session) return {
			sessionId,
			providerId: PROVIDER_ID$6,
			status: "missing"
		};
		if (session.timer) clearTimeout(session.timer);
		if (session.child && session.exitCode === null) session.child.kill("SIGTERM");
		await cleanup(session);
		sessions.delete(sessionId);
		return {
			sessionId,
			providerId: PROVIDER_ID$6,
			status: "cancelled"
		};
	}
	return Object.freeze({
		begin,
		poll,
		cancel,
		submitAuthorizationCode,
		dispose
	});
}
var AntigravityOfficialSessionDriver = class {
	constructor({ cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI, env = process.env, timeoutMs = 3e4, commandRunner = runCommand, requestExecutor = null, catalogLoader = null, quotaReader = null, tokenResolver = resolveAntigravityAccessToken, identityFromOfficialCli = true, identityFromOfficialSession = identityFromOfficialCli, oauthAuthorizer = null, browserAuthorizer = null, browserOAuth = env.DOCKYARD_ANTIGRAVITY_BROWSER_OAUTH !== "0", authorizationUrl = env.DOCKYARD_ANTIGRAVITY_AUTHORIZATION_URL || ANTIGRAVITY_BROWSER_AUTHORIZATION_URL, tokenUrl = env.DOCKYARD_ANTIGRAVITY_TOKEN_URL || ANTIGRAVITY_BROWSER_TOKEN_URL, userInfoUrl = env.DOCKYARD_ANTIGRAVITY_USERINFO_URL || ANTIGRAVITY_BROWSER_USERINFO_URL, clientId = env.DOCKYARD_ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_BROWSER_CLIENT_ID, clientSecret = env.DOCKYARD_ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_BROWSER_CLIENT_SECRET, oauthScope = env.DOCKYARD_ANTIGRAVITY_OAUTH_SCOPE || ANTIGRAVITY_BROWSER_SCOPES, redirectUri = env.DOCKYARD_ANTIGRAVITY_REDIRECT_URI || ANTIGRAVITY_BROWSER_REDIRECT_URI, fetchImpl = fetch, authorizationTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS } = {}) {
		this.cliPath = cliPath;
		this.env = env;
		this.timeoutMs = timeoutMs;
		this.commandRunner = commandRunner;
		this.fetchImpl = fetchImpl;
		authorizationUrl = validateAntigravityEndpoint(authorizationUrl, "authorization", "https://accounts.google.com");
		tokenUrl = validateAntigravityEndpoint(tokenUrl, "token", "https://oauth2.googleapis.com");
		userInfoUrl = validateAntigravityEndpoint(userInfoUrl, "userinfo", "https://www.googleapis.com");
		redirectUri = validateAntigravityRedirect(redirectUri);
		this.browserTokenUrl = tokenUrl;
		this.browserUserInfoUrl = userInfoUrl;
		this.browserClientId = clientId;
		this.browserClientSecret = clientSecret;
		this.requestExecutor = requestExecutor;
		this.quotaReader = quotaReader;
		this.tokenResolver = tokenResolver;
		this.identityFromOfficialSession = identityFromOfficialSession;
		this.cliOAuthAuthorizer = createAntigravityOAuthAuthorizer({
			cliPath,
			environment: env,
			timeoutMs: authorizationTimeoutMs
		});
		const browserOAuthConfigured = Boolean(clientId && clientSecret);
		this.browserAuthorizer = browserAuthorizer ?? (browserOAuth && browserOAuthConfigured ? createBrowserOAuthAuthorizer({
			providerId: PROVIDER_ID$6,
			redirectUri,
			callbackPath: new URL(redirectUri).pathname,
			callbackHost: new URL(redirectUri).hostname,
			callbackPort: Number(new URL(redirectUri).port || 51121),
			instructions: "请在 Google 官方授权页面选择账号并完成授权；完成后会自动返回 Dockyard DSH。",
			authorizationUrlBuilder: ({ state, codeChallenge, redirectUri: callback }) => `${authorizationUrl}?${new URLSearchParams({
				access_type: "offline",
				client_id: clientId,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				prompt: "consent",
				redirect_uri: callback,
				response_type: "code",
				scope: oauthScope,
				state
			})}`,
			exchangeCode: async ({ code, codeVerifier, redirectUri, context }) => {
				const response = await this.fetchImpl(tokenUrl, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: clientId,
						client_secret: clientSecret,
						code,
						code_verifier: codeVerifier,
						grant_type: "authorization_code",
						redirect_uri: redirectUri
					}),
					...context.signal ? { signal: context.signal } : {}
				});
				const body = await response.json().catch(() => ({}));
				if (!response.ok || !body.access_token) throw new Error(`Antigravity Google token exchange failed (${response.status})`);
				return body;
			},
			importCredentials: async (tokens, context) => {
				const access = tokens?.access_token ?? tokens?.accessToken;
				const refresh = tokens?.refresh_token ?? tokens?.refreshToken;
				if (!access) throw new Error("Antigravity Google OAuth did not return an access token");
				let profile = null;
				try {
					const response = await this.fetchImpl(userInfoUrl, {
						headers: { authorization: `Bearer ${access}` },
						...context.signal ? { signal: context.signal } : {}
					});
					if (response.ok) profile = await response.json().catch(() => null);
				} catch {}
				const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
				const candidateValue = candidate(now, {
					email: profile?.email,
					session: {
						token: access,
						refreshToken: refresh,
						expiresAt: tokenExpiresAt(tokens, now),
						lastRefreshedAt: now.toISOString()
					},
					existingAccounts: context.accounts ?? [],
					source: "official_antigravity_browser_oauth",
					sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER
				});
				return [await this.importAccount(candidateValue, context)];
			}
		}) : null);
		this.oauthAuthorizer = oauthAuthorizer ?? this.browserAuthorizer ?? this.cliOAuthAuthorizer;
		this.catalogLoader = catalogLoader ?? createAntigravityCatalogLoader({
			cliPath,
			env,
			timeoutMs,
			commandRunner
		});
	}
	async #slash(command, signal) {
		const result = await this.commandRunner(this.cliPath, [
			"-p",
			command,
			"--output-format",
			"json"
		], {
			env: this.env,
			timeoutMs: this.timeoutMs,
			includeAccountInfo: true,
			...signal ? { signal } : {}
		});
		const parsed = parseJsonOutput(result.output);
		return {
			...result,
			parsed
		};
	}
	async #resolveSessionEmail(session, context = {}) {
		const direct = extractAntigravityAccountEmail(session);
		if (direct) return direct;
		if (!session?.token || typeof this.fetchImpl !== "function" || !this.browserUserInfoUrl) return null;
		try {
			const response = await this.fetchImpl(this.browserUserInfoUrl, {
				headers: { authorization: `Bearer ${session.token}` },
				...context.signal ? { signal: context.signal } : {}
			});
			if (!response?.ok) return null;
			return extractAntigravityAccountEmail(await response.json().catch(() => null));
		} catch {
			return null;
		}
	}
	async #assertActiveSession(account, context = {}) {
		if (!isOfficialSessionAuthKind(account?.auth?.kind)) return;
		if (account.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER) return;
		const expectedFingerprint = account.resources?.sessionFingerprint;
		if (expectedFingerprint) {
			let current;
			try {
				current = await this.tokenResolver({ env: this.env });
			} catch {
				throw activeSessionError$2("Antigravity OAuth session is unavailable; authorize again");
			}
			if (!current?.token || sessionFingerprint(current) !== expectedFingerprint) {
				const currentEmail = await this.#resolveSessionEmail(current, context);
				if (currentEmail && account.email && sameEmail(currentEmail, account.email)) return;
				throw activeSessionError$2("Antigravity selected account is not the active local session; authorize it again", { mismatch: true });
			}
			return;
		}
		if (account.accountId === "antigravity:active" && !account.email) return;
		let result;
		try {
			result = await this.#slash("/quota", context.signal);
		} catch {
			throw activeSessionError$2("Antigravity active session could not be verified; authorize again");
		}
		const email = extractAntigravityAccountEmail(result.parsed, result.output, result.errorOutput);
		if (account.email && email && sameEmail(account.email, email)) return;
		throw activeSessionError$2("Antigravity selected account is not the active local session; authorize it again", { mismatch: true });
	}
	async #refreshBrowserCredential(account, context = {}) {
		if (account?.resources?.sessionSource !== OFFICIAL_SESSION_SOURCE_KINDS.BROWSER) return null;
		const credentialRef = account?.auth?.credentialRef ?? account?.credentialRef;
		if (!credentialRef || typeof context.secretStore?.read !== "function") throw activeSessionError$2("Antigravity browser OAuth credential is unavailable; authorize again");
		const credential = await context.secretStore.read(credentialRef);
		if (!credential?.access) throw activeSessionError$2("Antigravity browser OAuth credential is missing; authorize again");
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		if (!tokenNeedsRefresh$1(credential, now)) return credential;
		if (!credential.refresh) throw activeSessionError$2("Antigravity browser OAuth token expired; authorize again");
		let response;
		try {
			response = await this.fetchImpl(this.browserTokenUrl, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.browserClientId,
					client_secret: this.browserClientSecret,
					grant_type: "refresh_token",
					refresh_token: credential.refresh
				}),
				...context.signal ? { signal: context.signal } : {}
			});
		} catch (error) {
			const wrapped = activeSessionError$2(`Antigravity Google OAuth refresh failed: ${redactError(error)}`);
			wrapped.cause = error;
			throw wrapped;
		}
		const body = await response.json().catch(() => ({}));
		if (!response.ok || !body.access_token) {
			const error = activeSessionError$2("Antigravity Google OAuth refresh failed; authorize again");
			error.status = response.status;
			throw error;
		}
		const updated = {
			...credential,
			access: body.access_token,
			refresh: body.refresh_token ?? credential.refresh,
			expiresAt: tokenExpiresAt(body, now) ?? credential.expiresAt ?? null,
			lastRefreshedAt: now.toISOString()
		};
		await context.secretStore.write(credentialRef, updated);
		return updated;
	}
	async #nativeQuota(account, context, now) {
		if (typeof this.quotaReader !== "function") return null;
		let credential = null;
		const credentialRef = account?.auth?.credentialRef;
		if (account?.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER) credential = await this.#refreshBrowserCredential(account, context);
		else if (credentialRef && context.secretStore && typeof context.secretStore.read === "function") credential = await context.secretStore.read(credentialRef);
		const parsed = parseAntigravityNativeQuota(await this.quotaReader({
			account,
			credential,
			context
		}), now);
		if (parsed.windows.length === 0 && !parsed.credits) return null;
		return parsed;
	}
	async discover(context = {}) {
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		try {
			let session = null;
			try {
				session = typeof this.tokenResolver === "function" ? await this.tokenResolver({ env: this.env }) : null;
			} catch {}
			let windows = [];
			let source = "official_antigravity_cli";
			try {
				windows = (await this.#nativeQuota(null, context, now))?.windows ?? [];
				if (windows.length > 0) source = "antigravity_native";
			} catch {}
			let result = null;
			let cliIdentityError = null;
			if (windows.length === 0 || this.identityFromOfficialSession) try {
				result = await this.#slash("/quota", context.signal);
				const data = result.parsed?.command?.data;
				if (windows.length === 0) {
					windows = parseQuotaData(data, now);
					if (windows.length === 0) windows = parseQuotaText(result.parsed?.response ?? "", now);
				}
			} catch (error) {
				cliIdentityError = error;
				if (windows.length === 0) throw error;
			}
			const found = candidate(now, {
				email: extractAntigravityAccountEmail(result?.parsed, result?.output, result?.errorOutput) ?? await this.#resolveSessionEmail(session, context),
				session,
				existingAccounts: context.accounts ?? [],
				source,
				sourceKind: source === "antigravity_native" ? session?.sourceKind ?? OFFICIAL_SESSION_SOURCE_KINDS.OAUTH_FILE : OFFICIAL_SESSION_SOURCE_KINDS.CLI
			});
			found.status = windows.length ? "available" : "degraded";
			found.diagnostic = windows.length ? null : source === "antigravity_native" ? "官方会话已读取，但没有返回结构化 quota 窗口" : "官方 CLI 已启动，但没有返回结构化 quota 窗口";
			return {
				candidates: [found],
				source,
				diagnostics: [...result?.parsed?.status === "SUCCESS" || !result ? [] : ["Antigravity CLI 返回了非成功状态"], ...cliIdentityError && windows.length ? ["官方 CLI 账号身份暂未返回；已使用本地会话标识"] : []]
			};
		} catch (error) {
			return {
				candidates: [],
				source: "official_antigravity_cli",
				diagnostics: [`无法读取 Antigravity 官方会话：${redactError(error)}`]
			};
		}
	}
	async importAccount(value, context = {}) {
		const session = value?.[CREDENTIAL_SLOT$3];
		if (!session) throw new Error("Antigravity candidate is no longer available; scan again");
		if (!context.secretStore) throw new Error("A secure credential store is required");
		await context.secretStore.write(value.credentialRef, session);
		return {
			providerId: PROVIDER_ID$6,
			accountId: value.accountId,
			credentialRef: value.credentialRef,
			displayName: value.displayName,
			email: value.email ?? null,
			auth: {
				kind: OFFICIAL_SESSION_AUTH_KIND,
				scopes: []
			},
			subscription: {
				plan: null,
				status: null,
				expiresAt: null
			},
			refresh: {
				accessTokenExpiresAt: session.expiresAt ?? null,
				nextRefreshAt: null,
				lastRefreshedAt: session.lastRefreshedAt ?? null,
				refreshable: session.refresh ? true : null
			},
			resources: {
				...officialSessionResources({
					sourceKind: value.resources?.sessionSource ?? OFFICIAL_SESSION_SOURCE_KINDS.CLI,
					authSource: value.source ?? "official_antigravity_cli_session"
				}),
				transport: "gemini_stream_generate_content_sse",
				quotaSource: value.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP ? "official_client_status" : value.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER ? "antigravity_browser_oauth" : "antigravity_cli_status",
				...value.resources ?? {}
			}
		};
	}
	async getActiveSession(context = {}) {
		try {
			const candidateValue = (await this.discover(context))?.candidates?.[0];
			if (!candidateValue) return null;
			const account = await this.importAccount(candidateValue, context);
			return {
				status: "completed",
				providerId: PROVIDER_ID$6,
				instructions: "已检测到 Antigravity 官方会话，当前账号已接入 Dockyard DSH。",
				accounts: [account],
				diagnostic: null
			};
		} catch {
			return null;
		}
	}
	async dispose() {
		const authorizers = /* @__PURE__ */ new Set([
			this.oauthAuthorizer,
			this.browserAuthorizer,
			this.cliOAuthAuthorizer
		]);
		await Promise.all([...authorizers].filter(Boolean).map((authorizer) => authorizer.dispose?.()));
	}
	async startAuthorization(context = {}) {
		if (this.oauthAuthorizer !== this.browserAuthorizer || !this.browserAuthorizer) return this.oauthAuthorizer.begin(context);
		const started = await this.browserAuthorizer.begin(context);
		if (started.status === "failed") return this.cliOAuthAuthorizer.begin(context);
		return started;
	}
	#authorizationAuthorizer(sessionId) {
		if (sessionId?.includes(":browser:")) return this.browserAuthorizer;
		return this.oauthAuthorizer === this.browserAuthorizer ? this.cliOAuthAuthorizer : this.oauthAuthorizer;
	}
	async pollAuthorization(sessionId, context = {}) {
		return this.#authorizationAuthorizer(sessionId).poll(sessionId, context);
	}
	async submitAuthorizationCode(sessionId, code, context = {}) {
		return this.#authorizationAuthorizer(sessionId).submitAuthorizationCode(sessionId, code, context);
	}
	async cancelAuthorization(sessionId, context = {}) {
		return this.#authorizationAuthorizer(sessionId).cancel(sessionId, context);
	}
	async refreshAccount(account, context = {}) {
		await this.#refreshBrowserCredential(account, context);
		await this.#assertActiveSession(account, context);
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		let session = null;
		try {
			session = await this.tokenResolver({ env: this.env });
		} catch {}
		const sessionEmail = await this.#resolveSessionEmail(session, context);
		const fingerprint = sessionFingerprint(sessionEmail && session && !session.email ? {
			...session,
			email: sessionEmail
		} : session);
		const fingerprintResources = fingerprint ? { sessionFingerprint: fingerprint } : {};
		const identityPatch = sessionEmail ? { email: sessionEmail } : {};
		let nativeError = null;
		try {
			const native = await this.#nativeQuota(account, context, now);
			if (native) {
				const primary = selectPrimaryQuotaWindow(native.windows);
				return {
					...identityPatch,
					quota: {
						...primary,
						windows: native.windows,
						updatedAt: now.toISOString(),
						source: "antigravity_native"
					},
					credits: native.credits,
					resources: {
						quotaSource: "antigravity_native",
						...fingerprintResources
					},
					refresh: {
						accessTokenExpiresAt: null,
						nextRefreshAt: null,
						lastRefreshedAt: now.toISOString(),
						refreshable: null
					}
				};
			}
		} catch (error) {
			nativeError = error;
		}
		if (typeof this.quotaReader === "function" && account?.auth?.credentialRef && account?.resources?.sessionPersistence !== "active") throw nativeError ?? /* @__PURE__ */ new Error("Antigravity native quota did not return data for the selected account");
		const [result, creditsResult] = await Promise.all([this.#slash("/quota", context.signal), this.#slash("/credits", context.signal).catch(() => null)]);
		if (result.parsed?.status && result.parsed.status !== "SUCCESS") throw new Error("Antigravity official quota command did not complete");
		const windows = parseQuotaData(result.parsed?.command?.data, now);
		const fallbackWindows = windows.length ? windows : parseQuotaText(result.parsed?.response ?? "", now);
		const primary = selectPrimaryQuotaWindow(fallbackWindows);
		return {
			...identityPatch,
			quota: {
				...primary,
				windows: fallbackWindows,
				updatedAt: now.toISOString(),
				source: "antigravity_cli"
			},
			credits: creditsResult?.parsed?.command?.data ? {
				remaining: finiteNumber(creditsResult.parsed.command.data.remaining_credits),
				upgradeUri: stringValue(creditsResult.parsed.command.data.upgrade_uri)
			} : null,
			resources: fingerprintResources,
			refresh: {
				accessTokenExpiresAt: null,
				nextRefreshAt: null,
				lastRefreshedAt: now.toISOString(),
				refreshable: null
			}
		};
	}
	async getQuota(account, context = {}) {
		await this.#assertActiveSession(account, context);
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		let nativeError = null;
		try {
			const native = await this.#nativeQuota(account, context, now);
			if (native) return {
				quota: {
					...selectPrimaryQuotaWindow(native.windows),
					windows: native.windows,
					updatedAt: now.toISOString(),
					source: "antigravity_native"
				},
				credits: native.credits,
				resources: { quotaSource: "antigravity_native" },
				refresh: {
					accessTokenExpiresAt: null,
					nextRefreshAt: null,
					lastRefreshedAt: now.toISOString(),
					refreshable: null
				}
			};
		} catch (error) {
			nativeError = error;
		}
		if (typeof this.quotaReader === "function" && account?.auth?.credentialRef && account?.resources?.sessionPersistence !== "active") throw nativeError ?? /* @__PURE__ */ new Error("Antigravity native quota did not return data for the selected account");
		const [quotaResult, creditsResult] = await Promise.all([this.#slash("/quota", context.signal), this.#slash("/credits", context.signal).catch(() => null)]);
		const data = quotaResult.parsed?.command?.data;
		const windows = parseQuotaData(data, now);
		const fallbackWindows = windows.length ? windows : parseQuotaText(quotaResult.parsed?.response ?? "", now);
		const credits = creditsResult?.parsed?.command?.data ?? null;
		return {
			quota: {
				...selectPrimaryQuotaWindow(fallbackWindows),
				windows: fallbackWindows,
				updatedAt: now.toISOString(),
				source: "antigravity_cli"
			},
			credits: credits ? {
				remaining: finiteNumber(credits.remaining_credits),
				upgradeUri: stringValue(credits.upgrade_uri)
			} : null,
			refresh: {
				accessTokenExpiresAt: null,
				nextRefreshAt: null,
				lastRefreshedAt: now.toISOString(),
				refreshable: null
			}
		};
	}
	async getCatalog(context = {}) {
		return this.catalogLoader({
			force: Boolean(context.force),
			accounts: context.accounts
		});
	}
	async invoke(request, invocation, context = {}) {
		await this.#refreshBrowserCredential(invocation?.account, context);
		await this.#assertActiveSession(invocation?.account, context);
		const executor = context.requestExecutor ?? this.requestExecutor;
		if (typeof executor !== "function") throw new Error("Antigravity native invocation transport is not mounted");
		return executor({
			request,
			invocation,
			context
		});
	}
	async stream(request, invocation, context = {}) {
		return this.invoke(request, invocation, context);
	}
};
function createAntigravityDriver(options = {}) {
	return new AntigravityOfficialSessionDriver(options);
}
Object.freeze({ providerId: PROVIDER_ID$6 });
//#endregion
//#region vendor/dockyard/modules/provider-antigravity/src/index.mjs
function createAntigravityModule({ driver = {} } = {}) {
	return defineProviderModule({
		id: "antigravity",
		displayName: "Antigravity",
		capabilities: [
			"oauth_discovery",
			"oauth_import",
			"oauth_authorization",
			"oauth_refresh",
			"quota",
			"catalog",
			"invoke",
			"stream"
		],
		driver
	});
}
//#endregion
//#region vendor/dockyard/packages/oauth/src/cli-oauth-authorizer.mjs
const URL_PATTERN$1 = /https?:\/\/[^\s"'<>]+/gi;
const DEFAULT_TIMEOUT_MS$1 = 600 * 1e3;
const CHILD_STOP_GRACE_MS$1 = 2e3;
function cleanUrl$1(value) {
	return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f].*$/, "").replace(/[),.;]+$/, "");
}
function publicSession$2(session) {
	return {
		sessionId: session.sessionId,
		providerId: session.providerId,
		status: session.status ?? (session.exitCode === null ? "pending" : "processing"),
		authorizationUrl: session.authorizationUrl,
		instructions: session.instructions,
		startedAt: session.startedAt,
		diagnostic: session.diagnostic ?? null,
		...session.browserOpened ? { browserOpened: true } : {}
	};
}
function stopChild$1(session) {
	const child = session.child;
	if (!child || session.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (session.exitCode === null) session.exitCode = -1;
			resolve();
		};
		child.once("close", finish);
		if (session.exitCode !== null) {
			finish();
			return;
		}
		try {
			child.kill("SIGTERM");
		} catch {
			finish();
			return;
		}
		timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish();
		}, CHILD_STOP_GRACE_MS$1);
		timer.unref?.();
	});
}
/**
* Run a provider's own OAuth login command.
*
* The provider owns the command, environment key, auth-file format, and
* credential import callback. This package never parses or forwards tokens;
* it only tracks the local login process and hands its completed auth file
* back to the provider module. By default the command receives an isolated
* temporary profile. Providers whose CLI owns its normal browser flow can
* opt into a provider-owned profile and tell the caller that the browser has
* already been opened by the CLI.
*/
function createCliOAuthAuthorizer({ providerId, cliPath, loginArgs, environmentKey, authFileName = "auth.json", environment = process.env, profilePrefix = `dockyard-${providerId ?? "provider"}-oauth-`, instructions = "请在官方授权页面完成登录，完成后回到 Dockyard DSH。", timeoutMs = DEFAULT_TIMEOUT_MS$1, importCredentials, profileDirectory = null, browserOpened = false } = {}) {
	if (!providerId) throw new Error("CLI OAuth authorizer requires providerId");
	if (!cliPath) throw new Error(`CLI OAuth authorizer requires a ${providerId} CLI path`);
	if (!Array.isArray(loginArgs) || loginArgs.length === 0) throw new Error(`CLI OAuth authorizer requires login arguments for ${providerId}`);
	if (!environmentKey) throw new Error(`CLI OAuth authorizer requires an environment key for ${providerId}`);
	if (typeof importCredentials !== "function") throw new Error(`CLI OAuth authorizer requires an import callback for ${providerId}`);
	const sessions = /* @__PURE__ */ new Map();
	async function cleanup(session) {
		if (session.cleanupProfile && session.profileDir) {
			await rm(session.profileDir, {
				recursive: true,
				force: true
			}).catch(() => {});
			session.profileDir = null;
		}
	}
	function captureOutput(session, chunk) {
		const text = String(chunk ?? "");
		session.output = `${session.output}${text}`.slice(-32e3);
		if (!session.authorizationUrl) {
			const match = session.output.match(URL_PATTERN$1);
			if (match?.[0]) session.authorizationUrl = cleanUrl$1(match[0]);
		}
	}
	async function finalize(session, context) {
		if (session.result) return session.result;
		if (session.finalizing) return session.finalizing;
		session.finalizing = (async () => {
			try {
				if (session.timedOut) {
					session.status = "failed";
					session.diagnostic = "官方 OAuth 登录超时，请重新点击登录添加账号。";
					return publicSession$2(session);
				}
				if (session.launchError) {
					session.status = "failed";
					session.diagnostic = `无法启动官方登录命令：${session.launchError}`;
					return publicSession$2(session);
				}
				if (session.exitCode !== 0) {
					session.status = "failed";
					session.diagnostic = `官方 OAuth 登录未完成（退出码 ${session.exitCode ?? "unknown"}）。`;
					return publicSession$2(session);
				}
				let raw;
				try {
					raw = JSON.parse(await readFile(join(session.profileDir, authFileName), "utf8"));
				} catch (error) {
					session.status = "failed";
					session.diagnostic = `官方登录完成，但没有找到可读取的 OAuth 状态：${redactError(error)}`;
					return publicSession$2(session);
				}
				const accounts = await importCredentials(raw, context);
				if (!Array.isArray(accounts) || accounts.length === 0) {
					session.status = "failed";
					session.diagnostic = "官方登录完成，但 provider 没有返回可接入的账号。";
					return publicSession$2(session);
				}
				session.status = "completed";
				session.result = {
					...publicSession$2(session),
					accounts,
					diagnostic: null
				};
				return session.result;
			} catch (error) {
				session.status = "failed";
				session.diagnostic = redactError(error);
				return publicSession$2(session);
			} finally {
				await cleanup(session);
			}
		})();
		return session.finalizing;
	}
	async function begin() {
		const cleanupProfile = !profileDirectory;
		const profileDir = profileDirectory ?? await mkdtemp(join(tmpdir(), profilePrefix));
		if (!cleanupProfile) await mkdir(profileDir, { recursive: true });
		const session = {
			sessionId: `${providerId}:${randomUUID()}`,
			providerId,
			profileDir,
			cleanupProfile,
			browserOpened,
			status: "pending",
			authorizationUrl: null,
			instructions,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			exitCode: null,
			launchError: null,
			output: "",
			timedOut: false,
			child: null,
			timer: null,
			finalizing: null,
			result: null,
			diagnostic: null
		};
		sessions.set(session.sessionId, session);
		try {
			const child = spawn(cliPath, loginArgs, {
				env: {
					...environment,
					[environmentKey]: profileDir
				},
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
			session.child = child;
			child.stdout?.on("data", (chunk) => captureOutput(session, chunk));
			child.stderr?.on("data", (chunk) => captureOutput(session, chunk));
			child.once("error", (error) => {
				session.launchError = redactError(error);
				session.exitCode = -1;
			});
			child.once("close", (code) => {
				session.exitCode = typeof code === "number" ? code : -1;
			});
			session.timer = setTimeout(() => {
				if (session.exitCode !== null) return;
				session.timedOut = true;
				stopChild$1(session);
			}, timeoutMs);
			session.timer.unref?.();
		} catch (error) {
			session.launchError = redactError(error);
			session.exitCode = -1;
		}
		return publicSession$2(session);
	}
	async function poll(sessionId, context) {
		const session = sessions.get(sessionId);
		if (!session) return {
			sessionId,
			providerId,
			status: "missing",
			instructions,
			diagnostic: "OAuth 登录会话不存在或已结束，请重新点击登录添加账号。"
		};
		if (session.exitCode === null) return publicSession$2(session);
		if (session.timer) clearTimeout(session.timer);
		const result = await finalize(session, context);
		if (result.status !== "pending" && result.status !== "processing") sessions.delete(sessionId);
		return result;
	}
	async function cancel(sessionId) {
		const session = sessions.get(sessionId);
		if (!session) return {
			sessionId,
			providerId,
			status: "missing"
		};
		if (session.timer) clearTimeout(session.timer);
		await stopChild$1(session);
		await cleanup(session);
		sessions.delete(sessionId);
		return {
			sessionId,
			providerId,
			status: "cancelled"
		};
	}
	return Object.freeze({
		begin,
		poll,
		cancel
	});
}
Object.freeze({ defaultTimeoutMs: DEFAULT_TIMEOUT_MS$1 });
//#endregion
//#region vendor/dockyard/modules/provider-grok/src/driver.mjs
const PROVIDER_ID$5 = "grok";
const DEFAULT_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/authorize";
const DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEFAULT_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
join(homedir(), ".grok");
const DEFAULT_CATALOG_TTL_MS = 6e4;
const DEFAULT_GROK_USAGE_URL = "https://grok.com/?_s=usage";
const DEFAULT_GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const DEFAULT_GROK_TOKEN_HEADER = "xai-grok-cli";
const DEFAULT_GROK_CLIENT_VERSION = "0.2.112";
const GROK_ALLOWED_ORIGINS = /* @__PURE__ */ new Set(["https://auth.x.ai", "https://cli-chat-proxy.grok.com"]);
function validateGrokEndpoint(value, label, expectedOrigin) {
	const url = new URL(value);
	if (url.protocol !== "https:" || !GROK_ALLOWED_ORIGINS.has(url.origin) || expectedOrigin && url.origin !== expectedOrigin) throw new Error(`Grok ${label} endpoint must use its allowlisted HTTPS origin`);
	if (url.username || url.password || url.hash) throw new Error(`Grok ${label} endpoint is invalid`);
	return url.toString();
}
const CREDENTIAL_SLOT$2 = Symbol("dockyard-grok-credential");
function hash$2(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}
function firstString$6(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
function grokHomePath({ env = process.env, home = homedir(), grokHome } = {}) {
	return grokHome ?? env.GROK_HOME ?? join(home, ".grok");
}
function grokCommandEnvironment(env, grokHome) {
	return {
		...env,
		GROK_HOME: grokHome
	};
}
function authRecords(raw) {
	if (!raw || typeof raw !== "object") return [];
	if (typeof raw.key === "string" || typeof raw.access_token === "string" || typeof raw.accessToken === "string") return [{
		scopeKey: "default",
		value: raw
	}];
	return Object.entries(raw).filter(([, value]) => value && typeof value === "object").map(([scopeKey, value]) => ({
		scopeKey,
		value
	}));
}
/** Parse local Grok OAuth metadata while keeping token values private. */
function parseGrokAuth(raw) {
	return authRecords(raw).map(({ scopeKey, value }) => {
		const access = firstString$6(value.key, value.access_token, value.accessToken);
		if (!access) return null;
		const accessPayload = decodeJwtPayload(access) ?? {};
		const expiresAt = firstString$6(value.expires_at, value.expiresAt, isoFromEpoch(accessPayload.exp));
		const accountId = firstString$6(value.user_id, value.userId, value.principal_id, value.principalId, value.team_id, value.teamId, accessPayload.sub, accessPayload.user_id, accessPayload.userId) ?? `${scopeKey}:${hash$2(access).slice(0, 20)}`;
		const email = firstString$6(value.email, value.user_email, value.userEmail, accessPayload.email);
		return {
			access,
			refresh: firstString$6(value.refresh_token, value.refreshToken),
			accountId,
			email,
			displayName: firstString$6(value.first_name, value.firstName, value.name, accessPayload.name, email, accountId),
			plan: firstString$6(value.subscription_level, value.subscriptionLevel),
			expiresAt,
			createdAt: firstString$6(value.create_time, value.createdAt),
			scopes: Array.isArray(value.scopes) ? value.scopes.map(String) : typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : [],
			issuer: firstString$6(value.oidc_issuer, value.oidcIssuer, scopeKey.split("::")[0]),
			clientId: firstString$6(value.oidc_client_id, value.oidcClientId),
			authMode: firstString$6(value.auth_mode, value.authMode),
			scopeKey
		};
	}).filter(Boolean);
}
function accountInput(tokens, credentialRef, now = /* @__PURE__ */ new Date(), { source = "official_grok_oauth" } = {}) {
	return {
		providerId: PROVIDER_ID$5,
		accountId: tokens.accountId,
		credentialRef,
		displayName: tokens.displayName,
		email: tokens.email,
		auth: {
			kind: "oauth",
			scopes: tokens.scopes
		},
		subscription: {
			plan: tokens.plan,
			status: null,
			expiresAt: null
		},
		refresh: {
			accessTokenExpiresAt: tokens.expiresAt,
			nextRefreshAt: null,
			lastRefreshedAt: tokens.createdAt ?? now.toISOString(),
			refreshable: Boolean(tokens.refresh)
		},
		resources: {
			transport: "xai_chat_completions_sse",
			accountScope: "oauth_account",
			sessionSource: source.includes("browser") ? OFFICIAL_SESSION_SOURCE_KINDS.BROWSER : OFFICIAL_SESSION_SOURCE_KINDS.OAUTH_FILE,
			authSource: source,
			quotaSource: source.includes("browser") ? "official_browser_session" : "official_grok_session",
			quotaUrl: DEFAULT_GROK_USAGE_URL
		}
	};
}
function attachCredential(candidate, tokens) {
	Object.defineProperty(candidate, CREDENTIAL_SLOT$2, {
		value: tokens,
		enumerable: false,
		configurable: false
	});
	return candidate;
}
function candidateFromTokens(tokens, { source, now = /* @__PURE__ */ new Date() } = {}) {
	const expired = tokens.expiresAt && new Date(tokens.expiresAt).getTime() <= now.getTime();
	return attachCredential({
		candidateId: `grok:${hash$2(tokens.accountId).slice(0, 20)}`,
		providerId: PROVIDER_ID$5,
		source,
		accountId: tokens.accountId,
		displayName: tokens.displayName ?? tokens.email ?? tokens.accountId,
		email: tokens.email,
		subscription: {
			plan: tokens.plan,
			status: null,
			expiresAt: null
		},
		refresh: {
			accessTokenExpiresAt: tokens.expiresAt,
			nextRefreshAt: null,
			lastRefreshedAt: tokens.createdAt ?? now.toISOString(),
			refreshable: Boolean(tokens.refresh)
		},
		credentialRef: createCredentialRef(PROVIDER_ID$5, tokens.accountId),
		imported: false,
		status: expired ? "degraded" : "available",
		diagnostic: expired ? "Grok OAuth access token 已过期，导入后需要官方 OAuth 刷新" : null
	}, tokens);
}
function summarizeGrokCandidate(candidate) {
	return {
		providerId: PROVIDER_ID$5,
		candidateId: candidate.candidateId,
		source: candidate.source,
		accountId: candidate.accountId,
		displayName: candidate.displayName,
		email: candidate.email,
		subscription: { ...candidate.subscription },
		refresh: { ...candidate.refresh },
		imported: Boolean(candidate.imported),
		status: candidate.status ?? "available",
		diagnostic: candidate.diagnostic ?? null
	};
}
function cacheEntries(cache) {
	if (!cache?.models || typeof cache.models !== "object") return [];
	return Array.isArray(cache.models) ? cache.models.map((value) => [value?.id, value]).filter(([id]) => id) : Object.entries(cache.models);
}
function normalizeReasoning$1(info) {
	const efforts = (Array.isArray(info?.reasoning_efforts) ? info.reasoning_efforts : []).map((effort) => {
		const id = firstString$6(effort?.id, effort?.value);
		if (!id) return null;
		return {
			id,
			name: firstString$6(effort?.label, effort?.name, id),
			...typeof effort?.description === "string" ? { description: effort.description } : {},
			...effort?.default === true ? { default: true } : {}
		};
	}).filter(Boolean);
	if (!efforts.length) return void 0;
	const preferred = efforts.find((effort) => effort.default)?.id ?? firstString$6(info?.reasoning_effort);
	return {
		efforts: efforts.map(({ default: _default, ...effort }) => effort),
		...preferred && efforts.some((effort) => effort.id === preferred) ? { defaultEffort: preferred } : {}
	};
}
function parseGrokModelCatalog(output = "", cache = null) {
	const discovered = [...String(output).matchAll(/^\s*[*-]\s+(\S+)(?:\s+\(([^)]+)\))?/gm)].map((match) => ({
		id: match[1],
		name: match[2] ?? match[1]
	}));
	const cached = new Map(cacheEntries(cache).map(([id, value]) => [id, value?.info ?? value ?? {}]));
	return [.../* @__PURE__ */ new Set([...discovered.map((model) => model.id), ...cached.keys()])].map((id) => {
		const fromOutput = discovered.find((model) => model.id === id);
		const info = cached.get(id) ?? {};
		const outputName = fromOutput?.name === "default" ? null : fromOutput?.name;
		const model = {
			id,
			name: firstString$6(info.name, info.model, outputName, id)
		};
		const reasoning = normalizeReasoning$1(info);
		if (reasoning) model.reasoning = reasoning;
		const contextWindow = finiteNumber(info.context_window ?? info.contextWindow);
		const maxTokens = finiteNumber(info.max_completion_tokens ?? info.maxTokens);
		if (Number.isInteger(contextWindow)) model.contextWindow = contextWindow;
		if (Number.isInteger(maxTokens)) model.maxTokens = maxTokens;
		if (Array.isArray(info.input) && info.input.length > 0) model.inputModalities = [...info.input];
		return model;
	});
}
function finiteValue(value) {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : null;
}
function centValue(value) {
	return finiteValue(value?.val ?? value);
}
function periodLabel(periodType) {
	const value = String(periodType ?? "").toUpperCase();
	if (value.includes("WEEK")) return "官方周额度周期";
	if (value.includes("MONTH")) return "官方月额度周期";
	return "官方额度周期";
}
/**
* Normalize the official Grok Build credits config. The CLI's `/billing`
* proxy forwards `grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`; it is
* the supported authenticated surface for the consumer weekly cycle.
*/
function parseGrokCreditsConfig(body, { now = /* @__PURE__ */ new Date() } = {}) {
	const config = body?.config && typeof body.config === "object" ? body.config : {};
	const updatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
	const usagePercent = finiteValue(config.creditUsagePercent);
	const monthlyLimit = centValue(config.monthlyLimit);
	const used = centValue(config.used);
	const currentPeriod = config.currentPeriod && typeof config.currentPeriod === "object" ? config.currentPeriod : {};
	const periodType = currentPeriod.type ?? config.periodType;
	const periodStart = currentPeriod.start ?? config.billingPeriodStart ?? null;
	const periodEnd = currentPeriod.end ?? config.billingPeriodEnd ?? null;
	let remaining = null;
	let limit = null;
	let unit = null;
	if (usagePercent !== null && usagePercent >= 0 && usagePercent <= 100) {
		remaining = Math.max(0, 100 - usagePercent);
		limit = 100;
		unit = "percent";
	} else if (monthlyLimit !== null && used !== null && monthlyLimit >= 0) {
		remaining = Math.max(0, monthlyLimit - used);
		limit = monthlyLimit;
		unit = "USD cents";
	}
	const windows = periodEnd || remaining !== null || limit !== null ? [{
		id: "grok.current_period",
		name: periodLabel(periodType),
		remaining,
		limit,
		unit,
		resetAt: periodEnd,
		updatedAt,
		source: "official_grok_build_billing"
	}] : [];
	return {
		quota: {
			remaining,
			limit,
			unit,
			resetAt: periodEnd,
			windows,
			updatedAt,
			source: "official_grok_build_billing"
		},
		subscription: {
			plan: typeof body?.subscriptionTier === "string" ? body.subscriptionTier : null,
			status: null,
			expiresAt: null
		},
		resources: {
			quotaSource: "official_grok_build_billing",
			quotaDiagnostic: windows.length === 0 ? "Grok 官方 credits config 未返回当前额度周期或剩余值" : remaining === null ? "Grok 官方已返回当前额度周期，但未返回剩余百分比" : null,
			quotaPeriodType: periodType ?? null,
			quotaPeriodStart: periodStart,
			quotaUrl: DEFAULT_GROK_USAGE_URL
		}
	};
}
function createGrokCatalogLoader({ env = process.env, home = homedir(), grokHome, cliPath = env.DOCKYARD_GROK_CLI || "grok", commandRunner = null, timeoutMs = 3e4, readJson = readJsonFile, cacheTtlMs = Number(process.env.DOCKYARD_GROK_CATALOG_TTL_MS) || DEFAULT_CATALOG_TTL_MS } = {}) {
	const resolvedHome = grokHomePath({
		env,
		home,
		grokHome
	});
	let cached = null;
	let cachedAt = 0;
	let pending = null;
	return async function loadCatalog({ force = false } = {}) {
		if (!force && cached && Date.now() - cachedAt < cacheTtlMs) return cached;
		if (pending) return pending;
		pending = (async () => {
			const cache = await readJson(join(resolvedHome, "models_cache.json"));
			let value;
			if (typeof commandRunner === "function") try {
				const models = parseGrokModelCatalog((await commandRunner(cliPath, ["models"], {
					env,
					timeoutMs,
					providerId: PROVIDER_ID$5
				})).output, cache);
				value = {
					models,
					source: "official_grok_cli",
					...models.length ? {} : { diagnostics: ["Grok 官方 CLI 没有返回可用模型"] }
				};
			} catch (error) {
				value = {
					models: parseGrokModelCatalog("", cache),
					source: cache ? "official_grok_local_cache" : "official_grok_cli",
					diagnostics: [`Grok 官方模型目录读取失败：${error.message}`]
				};
			}
			else value = {
				models: parseGrokModelCatalog("", cache),
				source: "official_grok_local_cache",
				...cache ? {} : { diagnostics: [`未找到 Grok 实时模型缓存：${join(resolvedHome, "models_cache.json")}`] }
			};
			cached = value;
			cachedAt = Date.now();
			return value;
		})().finally(() => {
			pending = null;
		});
		return pending;
	};
}
var GrokOAuthDriver = class {
	constructor({ authFilePath, env = process.env, home = homedir(), grokHome, catalogLoader = null, oauthAuthorizer = null, browserAuthorizer = null, browserOAuth = env.DOCKYARD_GROK_BROWSER_OAUTH !== "0", authorizationUrl = env.DOCKYARD_GROK_AUTHORIZATION_URL || DEFAULT_AUTHORIZATION_URL, tokenUrl = env.DOCKYARD_GROK_TOKEN_URL || DEFAULT_TOKEN_URL, clientId = env.DOCKYARD_GROK_CLIENT_ID || DEFAULT_CLIENT_ID, oauthScope = env.DOCKYARD_GROK_OAUTH_SCOPE || DEFAULT_OAUTH_SCOPE, cliPath = env.DOCKYARD_GROK_CLI || "grok", commandRunner = runCliCommand, requestExecutor = null, fetchImpl = fetch, creditsUrl = env.DOCKYARD_GROK_CREDITS_URL || DEFAULT_GROK_CREDITS_URL, tokenHeader = env.DOCKYARD_GROK_TOKEN_HEADER || DEFAULT_GROK_TOKEN_HEADER, clientVersion = env.DOCKYARD_GROK_CLIENT_VERSION || DEFAULT_GROK_CLIENT_VERSION, timeoutMs = 3e4 } = {}) {
		this.env = env;
		this.grokHome = grokHomePath({
			env,
			home,
			grokHome
		});
		this.authFilePath = authFilePath ?? join(this.grokHome, "auth.json");
		this.cliPath = cliPath;
		this.commandRunner = commandRunner;
		this.requestExecutor = requestExecutor;
		this.fetchImpl = fetchImpl;
		authorizationUrl = validateGrokEndpoint(authorizationUrl, "authorization", "https://auth.x.ai");
		tokenUrl = validateGrokEndpoint(tokenUrl, "token", "https://auth.x.ai");
		creditsUrl = validateGrokEndpoint(creditsUrl, "credits", "https://cli-chat-proxy.grok.com");
		this.creditsUrl = validateNativeEndpoint(creditsUrl, { providerId: PROVIDER_ID$5 });
		this.tokenHeader = String(tokenHeader || DEFAULT_GROK_TOKEN_HEADER);
		this.clientVersion = String(clientVersion || DEFAULT_GROK_CLIENT_VERSION);
		this.timeoutMs = timeoutMs;
		this.tokenUrl = tokenUrl;
		this.clientId = clientId;
		this.oauthScope = oauthScope;
		this.catalogLoader = catalogLoader ?? createGrokCatalogLoader({
			env,
			home,
			grokHome: this.grokHome,
			cliPath,
			commandRunner,
			timeoutMs
		});
		this.cliAuthorizer = createCliOAuthAuthorizer({
			providerId: PROVIDER_ID$5,
			cliPath,
			loginArgs: ["login", "--oauth"],
			environmentKey: "GROK_HOME",
			environment: env,
			profileDirectory: this.grokHome,
			browserOpened: true,
			instructions: "已启动官方 Grok CLI OAuth 登录。请在 auth.x.ai 官方网页完成登录，完成后回到 Dockyard DSH。",
			importCredentials: (raw, context) => this.#importOAuthState(raw, context)
		});
		this.browserAuthorizer = browserAuthorizer ?? (browserOAuth ? createBrowserOAuthAuthorizer({
			providerId: PROVIDER_ID$5,
			callbackPath: "/callback",
			callbackHost: "127.0.0.1",
			callbackPort: 0,
			instructions: "请在官方 Grok 授权页面选择账号并完成授权；完成后会自动返回 Dockyard DSH。",
			authorizationUrlBuilder: async ({ state, codeChallenge, redirectUri, nonce }) => {
				const url = new URL(authorizationUrl);
				url.search = new URLSearchParams({
					response_type: "code",
					client_id: clientId,
					redirect_uri: redirectUri,
					scope: oauthScope,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					state,
					nonce,
					referrer: "grok-build"
				});
				return url.toString();
			},
			exchangeCode: async ({ code, codeVerifier, redirectUri, context }) => {
				const response = await this.fetchImpl(`${tokenUrl}`, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						accept: "application/json"
					},
					body: new URLSearchParams({
						grant_type: "authorization_code",
						client_id: clientId,
						code,
						redirect_uri: redirectUri,
						code_verifier: codeVerifier
					}),
					...context.signal ? { signal: context.signal } : {}
				});
				const body = await response.json().catch(() => ({}));
				if (!response.ok) {
					const error = /* @__PURE__ */ new Error(`Grok OAuth token exchange failed (${response.status})`);
					error.status = response.status;
					error.upstreamCode = body.error ?? body.error_code;
					throw error;
				}
				return {
					...body,
					oidc_client_id: body.oidc_client_id ?? body.client_id ?? clientId,
					auth_mode: "oauth",
					scope: body.scope ?? oauthScope
				};
			},
			importCredentials: (raw, context) => this.#importOAuthState(raw, context, "official_grok_browser_oauth")
		}) : null);
		this.oauthAuthorizer = oauthAuthorizer ?? this.browserAuthorizer ?? this.cliAuthorizer;
	}
	async discover(context = {}) {
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		const raw = await readJsonFile(this.authFilePath);
		if (!raw) return {
			candidates: [],
			source: this.authFilePath,
			diagnostics: [`未发现 Grok OAuth 文件：${this.authFilePath}`]
		};
		const candidates = parseGrokAuth(raw).map((tokens) => candidateFromTokens(tokens, {
			source: "official_grok_oauth",
			now
		}));
		return {
			candidates,
			source: "official_grok_oauth",
			diagnostics: candidates.length ? [] : ["Grok OAuth 文件存在，但没有可识别的 access token"]
		};
	}
	async importAccount(candidate, context = {}) {
		const tokens = candidate?.[CREDENTIAL_SLOT$2];
		if (!tokens) throw new Error("Grok candidate is no longer available; scan again");
		if (!context.secretStore) throw new Error("A secure credential store is required");
		const credentialRef = createCredentialRef(PROVIDER_ID$5, tokens.accountId);
		await context.secretStore.write(credentialRef, {
			type: "oauth",
			providerId: PROVIDER_ID$5,
			access: tokens.access,
			refresh: tokens.refresh,
			accountId: tokens.accountId,
			email: tokens.email,
			displayName: tokens.displayName,
			expiresAt: tokens.expiresAt,
			issuer: tokens.issuer,
			clientId: tokens.clientId,
			scopes: tokens.scopes,
			scopeKey: tokens.scopeKey
		});
		return accountInput(tokens, credentialRef, context.now instanceof Date ? context.now : /* @__PURE__ */ new Date(), { source: candidate.source });
	}
	async importSource(source, context = {}) {
		let raw;
		try {
			raw = typeof source?.content === "string" ? JSON.parse(source.content) : source?.content;
		} catch {
			throw new Error("Grok OAuth source is not valid JSON");
		}
		return this.#importOAuthState(raw, context, source?.fileName || "user_selected_oauth.json");
	}
	async #importOAuthState(raw, context = {}, source = "official_grok_oauth") {
		const tokens = parseGrokAuth(raw);
		if (!tokens.length) throw new Error("Grok OAuth state does not contain a supported account token");
		const accounts = [];
		for (const value of tokens) accounts.push(await this.importAccount(candidateFromTokens(value, {
			source,
			now: context.now instanceof Date ? context.now : /* @__PURE__ */ new Date()
		}), context));
		return accounts;
	}
	async getActiveSession(context = {}) {
		try {
			const discovered = await this.discover(context);
			if (!discovered.candidates?.length) return null;
			const accounts = [];
			for (const candidate of discovered.candidates) accounts.push(await this.importAccount(candidate, context));
			return {
				status: "completed",
				providerId: PROVIDER_ID$5,
				instructions: "已检测到 Grok 官方 OAuth 会话，当前账号已接入 Dockyard DSH。",
				accounts,
				diagnostic: null
			};
		} catch {
			return null;
		}
	}
	async dispose() {
		const authorizers = /* @__PURE__ */ new Set([
			this.oauthAuthorizer,
			this.browserAuthorizer,
			this.cliAuthorizer
		]);
		await Promise.all([...authorizers].filter(Boolean).map((authorizer) => authorizer.dispose?.()));
	}
	async startAuthorization(context = {}) {
		if (this.oauthAuthorizer !== this.browserAuthorizer || !this.browserAuthorizer) return this.oauthAuthorizer.begin(context);
		const started = await this.browserAuthorizer.begin(context);
		if (started.status === "failed") return this.cliAuthorizer.begin(context);
		return started;
	}
	async pollAuthorization(sessionId, context = {}) {
		return (sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer).poll(sessionId, context);
	}
	async submitAuthorizationCode(sessionId, code, context = {}) {
		const authorizer = sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer;
		if (typeof authorizer?.submitAuthorizationCode !== "function") throw new Error("当前 Grok 授权流程不接收手动授权码");
		return authorizer.submitAuthorizationCode(sessionId, code, context);
	}
	async cancelAuthorization(sessionId, context = {}) {
		return (sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer).cancel(sessionId, context);
	}
	async #readCredential(account, context = {}) {
		if (!context.secretStore) throw new Error("A secure credential store is required");
		const credentialRef = account.auth?.credentialRef ?? account.credentialRef;
		const credential = await context.secretStore.read(credentialRef);
		if (!credential?.access) {
			const error = /* @__PURE__ */ new Error("Grok OAuth credential is missing from secure storage");
			error.authExpired = true;
			throw error;
		}
		return {
			...credential,
			accountId: credential.accountId ?? account.accountId
		};
	}
	async #prepareCredentialEnvironment(account, context = {}) {
		const credential = await this.#readCredential(account, context);
		const profileDir = await mkdtemp(join(tmpdir(), "dockyard-grok-run-"));
		const authPath = join(profileDir, "auth.json");
		const raw = { [account.accountId ?? credential.accountId]: {
			key: credential.access,
			...credential.refresh ? { refresh_token: credential.refresh } : {},
			user_id: credential.accountId ?? account.accountId,
			...credential.email ?? account.email ? { email: credential.email ?? account.email } : {},
			...account.subscription?.plan ? { subscription_level: account.subscription.plan } : {},
			...credential.expiresAt ? { expires_at: credential.expiresAt } : {}
		} };
		await writeFile(authPath, JSON.stringify(raw), { mode: 384 });
		return {
			profileDir,
			authPath,
			credential,
			env: grokCommandEnvironment(this.env, profileDir)
		};
	}
	async #finishCredentialEnvironment(prepared, account, context = {}) {
		try {
			const raw = JSON.parse(await readFile(prepared.authPath, "utf8"));
			const updated = parseGrokAuth(raw).find((value) => value.accountId === (account.accountId ?? prepared.credential.accountId)) ?? parseGrokAuth(raw)[0];
			if (updated && context.secretStore) {
				const credentialRef = account.auth?.credentialRef ?? account.credentialRef;
				await context.secretStore.write(credentialRef, {
					...prepared.credential,
					access: updated.access,
					...updated.refresh ? { refresh: updated.refresh } : {},
					...updated.email ? { email: updated.email } : prepared.credential.email ? { email: prepared.credential.email } : {},
					...updated.displayName ? { displayName: updated.displayName } : prepared.credential.displayName ? { displayName: prepared.credential.displayName } : {},
					...updated.expiresAt ? { expiresAt: updated.expiresAt } : {},
					accountId: updated.accountId,
					lastRefreshedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
			return updated;
		} finally {
			await rm(prepared.profileDir, {
				recursive: true,
				force: true
			}).catch(() => {});
		}
	}
	async refreshAccount(account, context = {}) {
		const prepared = await this.#prepareCredentialEnvironment(account, context);
		let updated = null;
		let commandError = null;
		try {
			await this.commandRunner(this.cliPath, ["models"], {
				env: prepared.env,
				timeoutMs: this.timeoutMs,
				providerId: PROVIDER_ID$5
			});
		} catch (error) {
			error.authExpired = error.code === 401 || /auth|login|expired|credential|access token.{0,80}(?:valid|invalid|expired|revok)/i.test(String(error.message));
			commandError = error;
		}
		let finishError = null;
		try {
			updated = await this.#finishCredentialEnvironment(prepared, account, context);
		} catch (error) {
			finishError = error;
		}
		if (commandError) {
			if (finishError && !commandError.cause) commandError.cause = finishError;
			throw commandError;
		}
		if (finishError) throw finishError;
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		return {
			...updated?.email ? { email: updated.email } : {},
			...updated?.displayName ? { displayName: updated.displayName } : {},
			refresh: {
				accessTokenExpiresAt: updated?.expiresAt ?? account.refresh?.accessTokenExpiresAt ?? null,
				nextRefreshAt: null,
				lastRefreshedAt: now.toISOString(),
				refreshable: Boolean(updated?.refresh ?? prepared.credential.refresh)
			}
		};
	}
	async getQuota(account, context = {}) {
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		const credential = await this.#readCredential(account, context);
		const accountId = credential.accountId ?? account.accountId;
		const response = await this.fetchImpl(this.creditsUrl, {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${credential.access}`,
				"x-xai-token-auth": this.tokenHeader,
				"x-userid": accountId,
				"x-grok-client-version": this.clientVersion
			},
			...context.signal ? { signal: context.signal } : {}
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			const error = /* @__PURE__ */ new Error(`Grok credits request failed (${response.status})`);
			error.status = response.status;
			error.quotaUnavailable = response.status === 401 || response.status === 403;
			throw error;
		}
		const parsed = parseGrokCreditsConfig(body, { now });
		return {
			...parsed,
			subscription: {
				...account.subscription,
				...parsed.subscription.plan ? { plan: parsed.subscription.plan } : {}
			}
		};
	}
	async getCatalog(context = {}) {
		return this.catalogLoader({ force: Boolean(context.force) });
	}
	async invoke(request, invocation, context = {}) {
		const executor = context.requestExecutor ?? this.requestExecutor;
		if (typeof executor !== "function") throw new Error("Grok native invocation transport is not mounted");
		const account = invocation?.account;
		if (executor.nativeTransport === "xai-chat-completions") return executor({
			request,
			invocation,
			credential: account && context.secretStore ? await this.#readCredential(account, context) : null,
			context
		});
		if (!account || !context.secretStore) return executor({
			request,
			invocation,
			context
		});
		const prepared = await this.#prepareCredentialEnvironment(account, context);
		let output;
		try {
			output = await executor({
				request,
				invocation,
				context: {
					...context,
					env: prepared.env
				}
			});
		} catch (error) {
			try {
				await this.#finishCredentialEnvironment(prepared, account, context);
			} catch (finishError) {
				if (!error.cause) error.cause = finishError;
			}
			throw error;
		}
		return (async function* streamWithCleanup() {
			const driver = this;
			let streamError = null;
			try {
				for await (const chunk of output) yield chunk;
			} catch (error) {
				streamError = error;
				throw error;
			} finally {
				try {
					await driver.#finishCredentialEnvironment(prepared, account, context);
				} catch (finishError) {
					if (streamError) {
						if (!streamError.cause) streamError.cause = finishError;
					} else throw finishError;
				}
			}
		}).call(this);
	}
	async stream(request, invocation, context = {}) {
		return this.invoke(request, invocation, context);
	}
};
function createGrokDriver(options = {}) {
	return new GrokOAuthDriver(options);
}
Object.freeze({ providerId: PROVIDER_ID$5 });
//#endregion
//#region vendor/dockyard/modules/provider-grok/src/native-transport.mjs
const PROVIDER_ID$4 = "grok";
const DEFAULT_ENDPOINT$2 = "https://api.x.ai/v1/chat/completions";
function firstString$5(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
function toolCallPart$1(part) {
	const type = String(part?.type ?? "").toLowerCase().replace(/[_-]/g, "");
	return type === "toolcall" || type === "functioncall" || type === "tooluse" ? part : null;
}
async function openAiContent(content, attachments) {
	const values = Array.isArray(content) ? content : [content];
	const blocks = [];
	for (const part of values) {
		if (typeof part === "string") {
			if (part) blocks.push({
				type: "text",
				text: part
			});
			continue;
		}
		if (!part || typeof part !== "object") continue;
		if (part.type === "image") {
			const image = await resolveImageData(part, attachments);
			if (!image) throw nativeProviderError(PROVIDER_ID$4, "image attachment could not be resolved");
			blocks.push({
				type: "image_url",
				image_url: { url: `data:${image.mediaType};base64,${image.data}` }
			});
			continue;
		}
		if (part.type === "tool-result" || part.type === "tool_result") {
			blocks.push({
				type: "text",
				text: `[Tool Result ${part.toolCallId ?? part.id ?? ""}]\n${textFromContent(part.content ?? part.output ?? part.result ?? part.text)}`
			});
			continue;
		}
		const call = toolCallPart$1(part);
		if (call) {
			blocks.push({
				type: "text",
				text: `[Tool Call ${call.name ?? call.function?.name ?? "tool"}] ${JSON.stringify(parseToolArguments(call.arguments ?? call.input ?? call.function?.arguments))}`
			});
			continue;
		}
		const text = textFromContent(part);
		if (text) blocks.push({
			type: "text",
			text
		});
	}
	return blocks;
}
async function buildGrokMessages(request, attachments) {
	const result = [];
	if (typeof request.system === "string" && request.system.length > 0) result.push({
		role: "system",
		content: request.system
	});
	for (const message of Array.isArray(request.messages) ? request.messages : []) {
		const role = message?.role === "assistant" ? "assistant" : message?.role === "tool" ? "tool" : "user";
		if (role === "tool") {
			result.push({
				role: "tool",
				tool_call_id: firstString$5(message.toolCallId, message.tool_call_id, message.id, "tool-result"),
				content: textFromContent(message.content ?? message.text ?? message.output ?? message.result)
			});
			continue;
		}
		const content = await openAiContent(message?.content ?? message?.text, attachments);
		const calls = (Array.isArray(message?.content) ? message.content : [message?.content]).map(toolCallPart$1).filter(Boolean).map((call, index) => ({
			id: firstString$5(call.id, call.toolCallId, call.tool_call_id, `tool-${index}`),
			type: "function",
			function: {
				name: firstString$5(call.name, call.function?.name, "tool"),
				arguments: typeof (call.arguments ?? call.function?.arguments) === "string" ? call.arguments ?? call.function.arguments : JSON.stringify(call.arguments ?? call.input ?? call.function?.arguments ?? {})
			}
		}));
		const messageValue = {
			role,
			content: content.length === 0 ? "" : content.length === 1 && content[0].type === "text" ? content[0].text : content
		};
		if (role === "assistant" && calls.length > 0) messageValue.tool_calls = calls;
		result.push(messageValue);
	}
	if (!result.some((message) => message.role === "user")) result.push({
		role: "user",
		content: "Continue the conversation."
	});
	return result;
}
function buildGrokTools(tools) {
	if (!Array.isArray(tools)) return void 0;
	const result = tools.map((tool) => ({
		type: "function",
		function: {
			name: tool?.name ?? tool?.function?.name ?? "tool",
			...tool?.description ? { description: String(tool.description) } : {},
			parameters: tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? { type: "object" }
		}
	}));
	return result.length > 0 ? result : void 0;
}
async function buildGrokRequest(request = {}, context = {}) {
	const body = {
		model: request.model,
		messages: await buildGrokMessages(request, context.attachments),
		stream: true,
		stream_options: { include_usage: true }
	};
	if (request.temperature !== void 0) body.temperature = request.temperature;
	const maxTokens = request.maxTokens ?? request.modelContext?.maxTokens;
	if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
	if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
	const tools = buildGrokTools(request.tools);
	if (tools) body.tools = tools;
	return body;
}
async function* streamGrokResponse(response) {
	let text = "";
	let textIndex = 0;
	let textOpen = true;
	let nextIndex = 1;
	let usage = null;
	let stop = "stop";
	let reasoning = null;
	const tools = /* @__PURE__ */ new Map();
	yield {
		type: "block-start",
		index: textIndex,
		blockType: "text"
	};
	for await (const event of readSseEvents(response)) {
		const payload = event.data;
		if (!payload || typeof payload !== "object") continue;
		if (payload.error) throw nativeProviderError(PROVIDER_ID$4, payload.error.message ?? "xAI returned an error", {
			status: payload.error.code ?? payload.error.status,
			body: payload.error
		});
		usage = normalizeUsage(payload.usage) ?? usage;
		const choice = payload.choices?.[0];
		if (!choice) continue;
		stop = choice.finish_reason ?? stop;
		const delta = choice.delta ?? {};
		const content = typeof delta.content === "string" ? delta.content : textFromContent(delta.content);
		if (content) {
			if (reasoning) {
				yield {
					type: "block-end",
					index: reasoning.index,
					block: {
						type: "reasoning",
						text: reasoning.text
					}
				};
				reasoning = null;
			}
			if (!textOpen) {
				textIndex = nextIndex++;
				text = "";
				textOpen = true;
				yield {
					type: "block-start",
					index: textIndex,
					blockType: "text"
				};
			}
			text += content;
			yield {
				type: "text-delta",
				index: textIndex,
				text: content
			};
		}
		const reasoningDelta = delta.reasoning_content ?? delta.reasoningContent;
		if (reasoningDelta) {
			if (textOpen) {
				yield {
					type: "block-end",
					index: textIndex,
					block: {
						type: "text",
						text
					}
				};
				textOpen = false;
			}
			if (!reasoning) {
				reasoning = {
					index: nextIndex++,
					text: ""
				};
				yield {
					type: "block-start",
					index: reasoning.index,
					blockType: "reasoning"
				};
			}
			const value = String(reasoningDelta);
			reasoning.text += value;
			yield {
				type: "reasoning-delta",
				index: reasoning.index,
				text: value
			};
		}
		for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
			const key = Number(call.index ?? tools.size);
			if (!tools.has(key)) {
				if (reasoning) {
					yield {
						type: "block-end",
						index: reasoning.index,
						block: {
							type: "reasoning",
							text: reasoning.text
						}
					};
					reasoning = null;
				}
				if (textOpen) {
					yield {
						type: "block-end",
						index: textIndex,
						block: {
							type: "text",
							text
						}
					};
					textOpen = false;
				}
				const state = {
					index: nextIndex++,
					id: firstString$5(call.id, `tool-${key}`),
					name: firstString$5(call.function?.name, call.name, "tool"),
					arguments: ""
				};
				tools.set(key, state);
				yield {
					type: "block-start",
					index: state.index,
					blockType: "tool-call"
				};
			}
			const state = tools.get(key);
			const argumentDelta = call.function?.arguments ?? call.arguments ?? "";
			if (call.id) state.id = call.id;
			if (call.function?.name) state.name = call.function.name;
			state.arguments += argumentDelta;
			if (argumentDelta) yield {
				type: "tool-call-delta",
				index: state.index,
				id: state.id,
				name: state.name,
				argumentsDelta: argumentDelta
			};
		}
	}
	if (reasoning) yield {
		type: "block-end",
		index: reasoning.index,
		block: {
			type: "reasoning",
			text: reasoning.text
		}
	};
	if (textOpen) yield {
		type: "block-end",
		index: textIndex,
		block: {
			type: "text",
			text
		}
	};
	for (const state of tools.values()) yield {
		type: "block-end",
		index: state.index,
		block: {
			type: "tool-call",
			id: state.id,
			name: state.name,
			arguments: state.arguments || "{}"
		}
	};
	if (usage) yield {
		type: "usage",
		usage
	};
	yield {
		type: "finish",
		reason: finishReason(stop)
	};
}
function createGrokNativeExecutor({ endpoint = process.env.DOCKYARD_GROK_ENDPOINT || DEFAULT_ENDPOINT$2, env = process.env, timeoutMs = 3e5, fetchImpl = fetch, userAgent = process.env.DOCKYARD_GROK_USER_AGENT } = {}) {
	const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID$4 });
	const executor = async ({ request = {}, credential, context = {} } = {}) => {
		const effectiveEnv = {
			...env,
			...context.env ?? {}
		};
		const token = firstString$5(credential?.access);
		if (!token) {
			const error = nativeProviderError(PROVIDER_ID$4, "Grok OAuth token is missing from secure storage");
			error.authExpired = true;
			throw error;
		}
		const headers = {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "text/event-stream"
		};
		const configuredUserAgent = userAgent ?? effectiveEnv.DOCKYARD_GROK_USER_AGENT;
		if (configuredUserAgent) headers["user-agent"] = configuredUserAgent;
		return streamGrokResponse(await fetchNativeResponse(safeEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(await buildGrokRequest(request, context)),
			signal: context.signal
		}, {
			providerId: PROVIDER_ID$4,
			timeoutMs,
			fetchImpl
		}));
	};
	executor.nativeTransport = "xai-chat-completions";
	return executor;
}
Object.freeze({
	providerId: PROVIDER_ID$4,
	endpoint: DEFAULT_ENDPOINT$2
});
//#endregion
//#region vendor/dockyard/modules/provider-grok/src/index.mjs
function createGrokModule({ driver = {} } = {}) {
	return defineProviderModule({
		id: "grok",
		displayName: "Grok",
		capabilities: [
			"oauth_discovery",
			"oauth_import",
			"oauth_authorization",
			"oauth_refresh",
			"quota",
			"catalog",
			"invoke",
			"stream"
		],
		driver
	});
}
//#endregion
//#region vendor/dockyard/packages/oauth/src/cli-status-authorizer.mjs
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const CHILD_STOP_GRACE_MS = 2e3;
function cleanUrl(value) {
	return String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[),.;]+$/, "");
}
function publicSession$1(session) {
	return {
		sessionId: session.sessionId,
		providerId: session.providerId,
		status: session.status ?? (session.exitCode === null ? "pending" : "processing"),
		authorizationUrl: session.authorizationUrl,
		instructions: session.instructions,
		startedAt: session.startedAt,
		diagnostic: session.diagnostic ?? null,
		...session.browserOpened ? { browserOpened: true } : {}
	};
}
function stopChild(session) {
	const child = session.child;
	if (!child || session.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (session.exitCode === null) session.exitCode = -1;
			resolve();
		};
		child.once("close", finish);
		if (session.exitCode !== null) {
			finish();
			return;
		}
		try {
			child.kill("SIGTERM");
		} catch {
			finish();
			return;
		}
		timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish();
		}, CHILD_STOP_GRACE_MS);
		timer.unref?.();
	});
}
/**
* OAuth login for CLIs whose official credentials are stored in the OS
* keychain or the CLI's own profile instead of an importable auth.json.
* Completion is verified by the provider's status reader, never by scraping
* tokens from disk.
*/
function createCliStatusAuthorizer({ providerId, cliPath, loginArgs, environment = process.env, timeoutMs = 600 * 1e3, instructions = "请在官方授权页面完成登录，完成后回到 Dockyard DSH。", browserOpened = false, importStatus } = {}) {
	if (!providerId || !cliPath || !Array.isArray(loginArgs) || loginArgs.length === 0) throw new Error(`Invalid CLI status authorizer configuration for ${providerId ?? "provider"}`);
	if (typeof importStatus !== "function") throw new Error(`Missing status importer for ${providerId}`);
	const sessions = /* @__PURE__ */ new Map();
	function capture(session, chunk) {
		session.output = `${session.output}${String(chunk ?? "")}`.slice(-32e3);
		if (!session.authorizationUrl) {
			const match = session.output.match(URL_PATTERN);
			if (match?.[0]) session.authorizationUrl = cleanUrl(match[0]);
		}
	}
	async function finalize(session, context) {
		if (session.result) return session.result;
		if (session.finalizing) return session.finalizing;
		session.finalizing = (async () => {
			try {
				if (session.timedOut) {
					session.status = "failed";
					session.diagnostic = "官方 OAuth 登录超时，请重新点击登录添加账号。";
					return publicSession$1(session);
				}
				if (session.launchError) {
					session.status = "failed";
					session.diagnostic = `无法启动官方登录命令：${session.launchError}`;
					return publicSession$1(session);
				}
				if (session.exitCode !== 0) {
					session.status = "failed";
					session.diagnostic = `官方 OAuth 登录未完成（退出码 ${session.exitCode ?? "unknown"}）。`;
					return publicSession$1(session);
				}
				const accounts = await importStatus(context);
				if (!Array.isArray(accounts) || accounts.length === 0) {
					session.status = "failed";
					session.diagnostic = "官方登录完成，但 provider status 没有返回可接入的订阅账号。";
					return publicSession$1(session);
				}
				session.status = "completed";
				session.result = {
					...publicSession$1(session),
					accounts,
					diagnostic: null
				};
				return session.result;
			} catch (error) {
				session.status = "failed";
				session.diagnostic = redactError(error);
				return publicSession$1(session);
			} finally {
				if (session.timer) clearTimeout(session.timer);
			}
		})();
		return session.finalizing;
	}
	async function begin() {
		const session = {
			sessionId: `${providerId}:${randomUUID()}`,
			providerId,
			browserOpened,
			status: "pending",
			authorizationUrl: null,
			instructions,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			exitCode: null,
			launchError: null,
			output: "",
			timedOut: false,
			child: null,
			timer: null,
			finalizing: null,
			result: null,
			diagnostic: null
		};
		sessions.set(session.sessionId, session);
		try {
			const child = spawn(cliPath, loginArgs, {
				env: environment,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
			session.child = child;
			child.stdout?.on("data", (chunk) => capture(session, chunk));
			child.stderr?.on("data", (chunk) => capture(session, chunk));
			child.once("error", (error) => {
				session.launchError = redactError(error);
				session.exitCode = -1;
			});
			child.once("close", (code) => {
				session.exitCode = typeof code === "number" ? code : -1;
			});
			session.timer = setTimeout(() => {
				if (session.exitCode !== null) return;
				session.timedOut = true;
				stopChild(session);
			}, timeoutMs);
			session.timer.unref?.();
		} catch (error) {
			session.launchError = redactError(error);
			session.exitCode = -1;
		}
		return publicSession$1(session);
	}
	async function poll(sessionId, context) {
		const session = sessions.get(sessionId);
		if (!session) return {
			sessionId,
			providerId,
			status: "missing",
			instructions,
			diagnostic: "OAuth 登录会话不存在或已结束，请重新点击登录添加账号。"
		};
		if (session.exitCode === null) return publicSession$1(session);
		const result = await finalize(session, context);
		if (result.status !== "pending" && result.status !== "processing") sessions.delete(sessionId);
		return result;
	}
	async function cancel(sessionId) {
		const session = sessions.get(sessionId);
		if (!session) return {
			sessionId,
			providerId,
			status: "missing"
		};
		if (session.timer) clearTimeout(session.timer);
		await stopChild(session);
		sessions.delete(sessionId);
		return {
			sessionId,
			providerId,
			status: "cancelled"
		};
	}
	return Object.freeze({
		begin,
		poll,
		cancel
	});
}
//#endregion
//#region vendor/dockyard/packages/oauth/src/official-session-authorizer.mjs
const DEFAULT_TIMEOUT_MS = 600 * 1e3;
function publicSession(session) {
	return {
		sessionId: session.sessionId,
		providerId: session.providerId,
		status: session.status,
		instructions: session.instructions,
		startedAt: session.startedAt,
		diagnostic: session.diagnostic ?? null,
		...session.browserOpened ? { browserOpened: true } : {}
	};
}
/**
* Authorizer for an official desktop/client session whose login is owned by
* another process. The provider supplies a public session reader; this layer
* only polls it and never handles raw credentials.
*/
function createOfficialSessionAuthorizer({ providerId, source = "official_client", instructions = "请在官方客户端完成登录，完成后回到 Dockyard DSH。", timeoutMs = DEFAULT_TIMEOUT_MS, browserOpened = false, readSession, onCancel = null } = {}) {
	if (!providerId) throw new Error("Official session authorizer requires providerId");
	if (typeof readSession !== "function") throw new Error(`Official session authorizer requires a reader for ${providerId}`);
	const sessions = /* @__PURE__ */ new Map();
	function missing(sessionId) {
		return {
			sessionId,
			providerId,
			status: "missing",
			instructions,
			diagnostic: "官方客户端登录会话不存在或已结束，请重新开始授权。"
		};
	}
	async function begin() {
		const session = {
			sessionId: `${providerId}:official-session:${randomUUID()}`,
			providerId,
			source,
			browserOpened,
			status: "pending",
			instructions,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			diagnostic: null,
			result: null
		};
		sessions.set(session.sessionId, session);
		return publicSession(session);
	}
	async function poll(sessionId, context = {}) {
		const session = sessions.get(sessionId);
		if (!session) return missing(sessionId);
		if (session.result) return session.result;
		if (Date.now() - Date.parse(session.startedAt) >= timeoutMs) {
			session.status = "failed";
			session.diagnostic = "官方客户端登录超时，请完成登录后重新开始授权。";
			sessions.delete(sessionId);
			return publicSession(session);
		}
		try {
			const value = await readSession(context);
			const accounts = Array.isArray(value) ? value : value?.accounts;
			if (Array.isArray(accounts) && accounts.length > 0) {
				session.status = "completed";
				session.result = {
					...publicSession(session),
					accounts,
					diagnostic: null
				};
				sessions.delete(sessionId);
				return session.result;
			}
			session.status = value?.status === "processing" ? "processing" : "pending";
			session.diagnostic = value?.diagnostic ?? null;
			return publicSession(session);
		} catch (error) {
			session.status = "processing";
			session.diagnostic = redactError(error);
			return publicSession(session);
		}
	}
	async function cancel(sessionId, context = {}) {
		if (!sessions.get(sessionId)) return missing(sessionId);
		try {
			await onCancel?.(context);
		} finally {
			sessions.delete(sessionId);
		}
		return {
			sessionId,
			providerId,
			status: "cancelled"
		};
	}
	async function submitAuthorizationCode(sessionId) {
		if (!sessions.get(sessionId)) return missing(sessionId);
		throw new Error("当前官方客户端授权流程不接收验证码");
	}
	return Object.freeze({
		begin,
		poll,
		cancel,
		submitAuthorizationCode
	});
}
Object.freeze({ defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
//#endregion
//#region vendor/dockyard/modules/provider-claude/src/driver.mjs
const PROVIDER_ID$3 = "claude";
const DEFAULT_BROWSER_AUTHORIZATION_URL = "https://claude.com/cai/oauth/authorize";
const DEFAULT_BROWSER_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_BROWSER_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_BROWSER_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const DEFAULT_BROWSER_SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_ALLOWED_ORIGINS = /* @__PURE__ */ new Set(["https://claude.com", "https://platform.claude.com"]);
function validateClaudeEndpoint(value, label, expectedOrigin) {
	const url = new URL(value);
	if (url.protocol !== "https:" || !CLAUDE_ALLOWED_ORIGINS.has(url.origin) || expectedOrigin && url.origin !== expectedOrigin) throw new Error(`Claude ${label} endpoint must use its allowlisted HTTPS origin`);
	if (url.username || url.password || url.hash) throw new Error(`Claude ${label} endpoint is invalid`);
	return url.toString();
}
const CREDENTIAL_SLOT$1 = Symbol("dockyard-claude-session");
function hash$1(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}
function firstString$4(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
function statusObject$1(raw, output = "") {
	if (raw && typeof raw === "object") return raw;
	return parseJsonOutput$1(output) ?? {};
}
function statusLoggedIn(value, output = "") {
	if (typeof value.loggedIn === "boolean") return value.loggedIn;
	if (typeof value.authenticated === "boolean") return value.authenticated;
	return !/not logged in|logged out|unauthenticated/i.test(String(output));
}
function isApiKeyStatus(value) {
	const method = String(value.authMethod ?? value.auth_method ?? "").toLowerCase();
	const source = String(value.apiKeySource ?? value.api_key_source ?? "").toLowerCase();
	return method.includes("api_key") || method.includes("apikey") || source.length > 0;
}
function isSubscriptionStatus(value) {
	if (isApiKeyStatus(value)) return false;
	const method = String(value.authMethod ?? value.auth_method ?? "").toLowerCase();
	const provider = String(value.apiProvider ?? value.api_provider ?? "").toLowerCase();
	return method.includes("oauth") || method.includes("claude") || method.includes("subscription") || provider.includes("claude") || provider.includes("firstparty");
}
function statusIdentity(value) {
	const profile = value.profile ?? value.user ?? value.account ?? {};
	const email = firstString$4(value.email, value.userEmail, profile.email, profile.userEmail);
	const accountId = firstString$4(value.accountId, value.account_id, value.userId, value.user_id, profile.accountId, profile.id, email) ?? "claude:active";
	return {
		accountId,
		email,
		plan: firstString$4(value.plan, value.planName, value.plan_type, value.subscriptionType, value.subscription?.plan, value.subscription?.name),
		displayName: firstString$4(value.name, profile.name, email, accountId)
	};
}
/** Normalize only public status fields; OAuth/API secrets never leave the provider session reader. */
function parseClaudeAuthStatus(output) {
	const value = statusObject$1(null, output);
	const identity = statusIdentity(value);
	return {
		loggedIn: statusLoggedIn(value, output),
		authMethod: firstString$4(value.authMethod, value.auth_method),
		apiProvider: firstString$4(value.apiProvider, value.api_provider),
		apiKeySource: firstString$4(value.apiKeySource, value.api_key_source),
		isApiKey: isApiKeyStatus(value),
		isSubscription: isSubscriptionStatus(value),
		...identity,
		raw: value
	};
}
function activeSessionError$1(message, { mismatch = false } = {}) {
	const error = new Error(message);
	error.authExpired = true;
	if (mismatch) error.accountMismatch = true;
	return error;
}
function candidateFromStatus$1(status, { source = "official_claude_cli", sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.CLI, imported = false, credential = null } = {}) {
	const credentialRef = createCredentialRef(PROVIDER_ID$3, status.accountId);
	const candidate = {
		candidateId: `claude:${hash$1(status.accountId).slice(0, 20)}`,
		providerId: PROVIDER_ID$3,
		source,
		accountId: status.accountId,
		displayName: status.displayName ?? status.accountId,
		email: status.email,
		subscription: {
			plan: status.plan,
			status: status.isSubscription ? "active" : null,
			expiresAt: null
		},
		refresh: {
			accessTokenExpiresAt: null,
			nextRefreshAt: null,
			lastRefreshedAt: null,
			refreshable: false
		},
		credentialRef,
		resources: officialSessionResources({
			sourceKind,
			authSource: source
		}),
		imported,
		status: status.isSubscription ? "available" : "degraded",
		diagnostic: status.isApiKey ? "当前 Claude 官方会话使用 API key，不是 Claude Pro/Max 订阅 OAuth" : status.isSubscription ? null : "Claude 官方会话没有返回可识别的订阅 OAuth 状态"
	};
	Object.defineProperty(candidate, CREDENTIAL_SLOT$1, {
		value: credential ?? {
			type: "official_session",
			providerId: PROVIDER_ID$3,
			accountId: status.accountId,
			authMethod: status.authMethod,
			sourceKind
		},
		enumerable: false
	});
	return candidate;
}
function browserTokenExpiry(raw, now = /* @__PURE__ */ new Date()) {
	if (typeof raw?.expires_at === "string") return raw.expires_at;
	const expiresIn = Number(raw?.expires_in);
	return Number.isFinite(expiresIn) ? new Date(now.getTime() + expiresIn * 1e3).toISOString() : null;
}
function candidateFromBrowserToken(raw, { source = "official_claude_browser_oauth", now = /* @__PURE__ */ new Date() } = {}) {
	const access = firstString$4(raw?.access_token, raw?.accessToken);
	const refresh = firstString$4(raw?.refresh_token, raw?.refreshToken);
	if (!access || !refresh) throw new Error("Claude browser OAuth response is missing access and refresh tokens");
	const account = raw.account ?? {};
	const organization = raw.organization ?? {};
	const email = firstString$4(raw.email, account.email, account.email_address, account.emailAddress);
	const accountId = firstString$4(raw.accountId, raw.account_id, account.uuid, account.id, email) ?? "claude:active";
	const candidate = candidateFromStatus$1({
		loggedIn: true,
		authMethod: "oauth",
		apiProvider: "firstParty",
		isApiKey: false,
		isSubscription: true,
		accountId,
		email,
		displayName: firstString$4(raw.name, account.name, email, accountId),
		plan: firstString$4(raw.plan, raw.plan_type, organization.name)
	}, {
		source,
		sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER,
		credential: {
			type: "oauth",
			providerId: PROVIDER_ID$3,
			accountId,
			access,
			refresh,
			expiresAt: browserTokenExpiry(raw, now),
			sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER,
			clientId: raw.client_id ?? raw.clientId ?? null
		}
	});
	candidate.refresh = {
		...candidate.refresh,
		accessTokenExpiresAt: browserTokenExpiry(raw, now),
		refreshable: true
	};
	return candidate;
}
function summarizeClaudeCandidate(candidate) {
	return {
		providerId: PROVIDER_ID$3,
		candidateId: candidate.candidateId,
		source: candidate.source,
		accountId: candidate.accountId,
		displayName: candidate.displayName,
		email: candidate.email,
		subscription: { ...candidate.subscription },
		refresh: { ...candidate.refresh },
		imported: Boolean(candidate.imported),
		status: candidate.status ?? "available",
		diagnostic: candidate.diagnostic ?? null
	};
}
function catalogModel(model) {
	const reasoning = model?.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? { efforts: Object.keys(model.thinkingLevelMap).filter((id) => id !== "off").map((id) => ({
		id,
		name: id.replace(/[-_]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase())
	})) } : model?.reasoning && typeof model.reasoning === "object" ? model.reasoning : void 0;
	return {
		id: model.id,
		name: model.name ?? model.id,
		...Array.isArray(model.input) ? { inputModalities: [...model.input] } : {},
		...Number.isInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {},
		...Number.isInteger(model.maxTokens) ? { maxTokens: model.maxTokens } : {},
		...reasoning ? { reasoning } : {}
	};
}
function createClaudeCatalogLoader({ registryLoader = null } = {}) {
	let cached = null;
	return async function loadCatalog({ force = false } = {}) {
		if (cached && !force) return cached;
		const registry = typeof registryLoader === "function" ? await registryLoader() : [];
		const modelsById = /* @__PURE__ */ new Map();
		for (const rawModel of Array.isArray(registry) ? registry : []) {
			if (!rawModel || rawModel.provider !== "anthropic" && rawModel.api !== "anthropic-messages") continue;
			const model = catalogModel(rawModel);
			if (typeof model.id !== "string" || model.id.length === 0) continue;
			const previous = modelsById.get(model.id);
			if (!previous) {
				modelsById.set(model.id, model);
				continue;
			}
			modelsById.set(model.id, {
				...previous,
				...previous.name === model.id && model.name !== model.id ? { name: model.name } : {},
				...previous.inputModalities === void 0 && model.inputModalities !== void 0 ? { inputModalities: [...model.inputModalities] } : {},
				...previous.contextWindow === void 0 && model.contextWindow !== void 0 ? { contextWindow: model.contextWindow } : {},
				...previous.maxTokens === void 0 && model.maxTokens !== void 0 ? { maxTokens: model.maxTokens } : {},
				...previous.reasoning === void 0 && model.reasoning !== void 0 ? { reasoning: model.reasoning } : {}
			});
		}
		const models = [...modelsById.values()];
		cached = {
			models,
			source: "dsh_live_provider_registry",
			...models.length ? {} : { diagnostics: ["Claude 官方没有公开模型目录，且当前 DSH registry 未返回 Anthropic 模型"] }
		};
		return cached;
	};
}
var ClaudeSubscriptionDriver = class {
	constructor({ cliPath = process.env.DOCKYARD_CLAUDE_CLI || "claude", env = process.env, commandRunner = runCliCommand, requestExecutor = null, catalogLoader = null, sessionReader = null, sessionSource = "official_claude_client", sessionSourceKind = OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP, oauthAuthorizer = null, browserAuthorizer = null, browserOAuth = env.DOCKYARD_CLAUDE_BROWSER_OAUTH !== "0", authorizationUrl = env.DOCKYARD_CLAUDE_AUTHORIZATION_URL || DEFAULT_BROWSER_AUTHORIZATION_URL, tokenUrl = env.DOCKYARD_CLAUDE_TOKEN_URL || DEFAULT_BROWSER_TOKEN_URL, clientId = env.DOCKYARD_CLAUDE_CLIENT_ID || DEFAULT_BROWSER_CLIENT_ID, redirectUri = env.DOCKYARD_CLAUDE_REDIRECT_URI || DEFAULT_BROWSER_REDIRECT_URI, oauthScope = env.DOCKYARD_CLAUDE_OAUTH_SCOPE || DEFAULT_BROWSER_SCOPE, fetchImpl = fetch } = {}) {
		this.cliPath = cliPath;
		this.env = env;
		this.commandRunner = commandRunner;
		this.requestExecutor = requestExecutor;
		this.fetchImpl = fetchImpl;
		authorizationUrl = validateClaudeEndpoint(authorizationUrl, "authorization", "https://claude.com");
		tokenUrl = validateClaudeEndpoint(tokenUrl, "token", "https://platform.claude.com");
		this.browserTokenUrl = tokenUrl;
		this.browserClientId = clientId;
		this.sessionReader = sessionReader;
		this.sessionSource = sessionSource;
		this.sessionSourceKind = sessionSourceKind;
		this.catalogLoader = catalogLoader ?? createClaudeCatalogLoader();
		this.clientSessionAuthorizer = typeof sessionReader === "function" ? createOfficialSessionAuthorizer({
			providerId: PROVIDER_ID$3,
			source: sessionSource,
			instructions: "请在 Claude 官方客户端完成登录，完成后回到 Dockyard DSH。",
			readSession: async (context = {}) => {
				const status = await this.#activeStatus(context.signal);
				const candidate = candidateFromStatus$1(status, {
					source: status.source,
					sourceKind: status.sourceKind
				});
				return { accounts: [await this.importAccount(candidate, context)] };
			}
		}) : null;
		this.cliAuthorizer = createCliStatusAuthorizer({
			providerId: PROVIDER_ID$3,
			cliPath,
			loginArgs: [
				"auth",
				"login",
				"--claudeai"
			],
			environment: env,
			browserOpened: true,
			instructions: "已启动官方 Claude CLI OAuth 登录。请在 Claude 官方网页完成登录，完成后回到 Dockyard DSH。",
			importStatus: async (context) => {
				const status = await this.#activeStatus();
				if (!status.loggedIn || !status.isSubscription) return [];
				return [await this.importAccount(candidateFromStatus$1(status, {
					source: status.source,
					sourceKind: status.sourceKind
				}), context)];
			}
		});
		this.browserAuthorizer = browserAuthorizer ?? (browserOAuth ? createBrowserOAuthAuthorizer({
			providerId: PROVIDER_ID$3,
			redirectUri,
			callbackPort: 0,
			authorizationCodeRequired: true,
			instructions: "请在官方 Claude 授权页面选择账号并完成授权，然后将页面返回的授权码粘贴回 Dockyard DSH。",
			authorizationUrlBuilder: async ({ state, codeChallenge, redirectUri: callback }) => {
				const url = new URL(authorizationUrl);
				url.search = new URLSearchParams({
					code: "true",
					client_id: clientId,
					response_type: "code",
					redirect_uri: callback,
					scope: oauthScope,
					code_challenge: codeChallenge,
					code_challenge_method: "S256",
					state
				});
				return url.toString();
			},
			exchangeCode: async ({ code, state, codeVerifier, redirectUri: callback, context }) => {
				const response = await this.fetchImpl(tokenUrl, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					body: JSON.stringify({
						grant_type: "authorization_code",
						code: code.includes("#") ? code.split("#", 1)[0] : code,
						redirect_uri: callback,
						client_id: clientId,
						code_verifier: codeVerifier,
						state
					}),
					...context.signal ? { signal: context.signal } : {}
				});
				const body = await response.json().catch(() => ({}));
				if (!response.ok) {
					const error = /* @__PURE__ */ new Error(`Claude OAuth token exchange failed (${response.status})`);
					error.status = response.status;
					error.upstreamCode = body.error;
					throw error;
				}
				return body;
			},
			importCredentials: async (raw, context) => [await this.importAccount(candidateFromBrowserToken(raw, {
				source: "official_claude_browser_oauth",
				now: context.now instanceof Date ? context.now : /* @__PURE__ */ new Date()
			}), context)]
		}) : null);
		this.oauthAuthorizer = oauthAuthorizer ?? this.browserAuthorizer ?? this.cliAuthorizer;
	}
	#statusFromResult(result, defaults = {}) {
		const normalized = normalizeOfficialSessionResult(result, {
			source: defaults.source ?? "official_claude_cli",
			sourceKind: defaults.sourceKind ?? OFFICIAL_SESSION_SOURCE_KINDS.CLI
		});
		return {
			...parseClaudeAuthStatus(normalized?.output ?? ""),
			source: normalized?.source ?? defaults.source ?? "official_claude_cli",
			sourceKind: normalized?.sourceKind ?? defaults.sourceKind ?? OFFICIAL_SESSION_SOURCE_KINDS.CLI
		};
	}
	async #readStatus(signal) {
		if (typeof this.sessionReader === "function") try {
			const normalized = normalizeOfficialSessionResult(await this.sessionReader({
				env: this.env,
				signal
			}), {
				source: this.sessionSource,
				sourceKind: this.sessionSourceKind
			});
			if (normalized) return normalized;
		} catch {}
		return normalizeOfficialSessionResult(await this.commandRunner(this.cliPath, [
			"auth",
			"status",
			"--json"
		], {
			env: this.env,
			providerId: PROVIDER_ID$3,
			timeoutMs: 3e4,
			...signal ? { signal } : {}
		}), {
			source: "official_claude_cli",
			sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.CLI
		});
	}
	#isBrowserAccount(account) {
		return account?.resources?.authSource === "official_claude_browser_oauth";
	}
	async #readBrowserCredential(account, context = {}) {
		if (!context.secretStore) throw new Error("A secure credential store is required");
		const credentialRef = account.auth?.credentialRef ?? account.credentialRef;
		const credential = await context.secretStore.read(credentialRef);
		if (!credential?.access) throw activeSessionError$1("Claude browser OAuth credential is missing; authorize again");
		return {
			...credential,
			credentialRef
		};
	}
	async #refreshBrowserCredential(account, context = {}) {
		const credential = await this.#readBrowserCredential(account, context);
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		const expiresAt = Date.parse(credential.expiresAt ?? "");
		if (!credential.refresh || Number.isFinite(expiresAt) && expiresAt - now.getTime() > 6e4) return credential;
		const response = await this.fetchImpl(this.browserTokenUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: credential.refresh,
				client_id: credential.clientId ?? this.browserClientId
			}),
			...context.signal ? { signal: context.signal } : {}
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok || !body.access_token) {
			const error = /* @__PURE__ */ new Error(`Claude browser OAuth refresh failed (${response.status})`);
			error.status = response.status;
			throw error;
		}
		const updated = {
			...credential,
			access: body.access_token,
			refresh: body.refresh_token ?? credential.refresh,
			expiresAt: typeof body.expires_in === "number" ? new Date(now.getTime() + body.expires_in * 1e3).toISOString() : credential.expiresAt
		};
		await context.secretStore.write(credential.credentialRef, updated);
		return updated;
	}
	async #browserStatus(account, context = {}) {
		const credential = await this.#refreshBrowserCredential(account, context);
		return {
			loggedIn: true,
			authMethod: "oauth",
			apiProvider: "firstParty",
			isApiKey: false,
			isSubscription: true,
			accountId: account.accountId,
			email: account.email,
			displayName: account.displayName,
			plan: account.subscription?.plan ?? null,
			raw: {},
			source: "official_claude_browser_oauth",
			sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER,
			credential
		};
	}
	async #activeStatus(signal, account = null, context = {}) {
		if (this.#isBrowserAccount(account)) return this.#browserStatus(account, context);
		const result = await this.#readStatus(signal);
		const status = this.#statusFromResult(result, {
			source: this.sessionSource,
			sourceKind: this.sessionSourceKind
		});
		if (!status.loggedIn || status.isApiKey || !status.isSubscription) throw activeSessionError$1("Claude subscription OAuth is not the active official session; authorize again");
		return status;
	}
	async #assertActiveSession(account, signal, context = {}) {
		const status = await this.#activeStatus(signal, account, context);
		if (account?.accountId !== status.accountId && account?.accountId !== "claude:active") throw activeSessionError$1("Claude only exposes its active official session; select the active account or authorize it again", { mismatch: true });
		return status;
	}
	async discover() {
		try {
			const result = await this.#readStatus();
			const status = this.#statusFromResult(result, {
				source: this.sessionSource,
				sourceKind: this.sessionSourceKind
			});
			const source = status.source ?? "official_claude_cli";
			if (!status.loggedIn) return {
				candidates: [],
				source,
				diagnostics: ["Claude 官方会话当前未登录"]
			};
			if (status.isApiKey) return {
				candidates: [],
				source,
				diagnostics: ["Claude 官方会话当前使用 API key；请使用订阅 OAuth 登录"]
			};
			if (!status.isSubscription) return {
				candidates: [],
				source,
				diagnostics: ["Claude 官方会话不是可识别的订阅 OAuth"]
			};
			return {
				candidates: [candidateFromStatus$1(status, {
					source,
					sourceKind: status.sourceKind
				})],
				source,
				diagnostics: []
			};
		} catch (error) {
			return {
				candidates: [],
				source: this.sessionSource,
				diagnostics: [`无法读取 Claude 官方会话：${error.message}`]
			};
		}
	}
	async importAccount(candidate, context = {}) {
		const session = candidate?.[CREDENTIAL_SLOT$1];
		if (!session) throw new Error("Claude candidate is no longer available; scan again");
		if (!context.secretStore) throw new Error("A secure credential store is required");
		await context.secretStore.write(candidate.credentialRef, session);
		return {
			providerId: PROVIDER_ID$3,
			accountId: candidate.accountId,
			credentialRef: candidate.credentialRef,
			displayName: candidate.displayName,
			email: candidate.email,
			auth: {
				kind: OFFICIAL_SESSION_AUTH_KIND,
				scopes: []
			},
			subscription: { ...candidate.subscription },
			refresh: { ...candidate.refresh },
			resources: {
				...officialSessionResources({
					sourceKind: candidate.resources?.sessionSource ?? OFFICIAL_SESSION_SOURCE_KINDS.CLI,
					authSource: candidate.source
				}),
				transport: "anthropic_messages_sse",
				quotaSource: candidate.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP ? "official_client_status" : candidate.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER ? "official_browser_status" : "official_cli_status"
			}
		};
	}
	async getActiveSession(context = {}) {
		try {
			const status = await this.#activeStatus(context.signal);
			const candidate = candidateFromStatus$1(status, {
				source: status.source,
				sourceKind: status.sourceKind
			});
			const account = await this.importAccount(candidate, context);
			return {
				status: "completed",
				providerId: PROVIDER_ID$3,
				instructions: "已检测到 Claude 官方会话，当前账号已接入 Dockyard DSH。",
				accounts: [account],
				diagnostic: null
			};
		} catch {
			return null;
		}
	}
	async dispose() {
		const authorizers = /* @__PURE__ */ new Set([
			this.oauthAuthorizer,
			this.browserAuthorizer,
			this.cliAuthorizer,
			this.clientSessionAuthorizer
		]);
		await Promise.all([...authorizers].filter(Boolean).map((authorizer) => authorizer.dispose?.()));
	}
	async startAuthorization(context = {}) {
		if (this.oauthAuthorizer !== this.browserAuthorizer || !this.browserAuthorizer) return this.oauthAuthorizer.begin(context);
		const started = await this.browserAuthorizer.begin(context);
		if (started.status === "failed") return this.cliAuthorizer.begin(context);
		return started;
	}
	async pollAuthorization(sessionId, context = {}) {
		return (sessionId?.includes(":official-session:") ? this.clientSessionAuthorizer : sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer).poll(sessionId, context);
	}
	async submitAuthorizationCode(sessionId, code, context = {}) {
		const authorizer = sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer;
		if (typeof authorizer?.submitAuthorizationCode !== "function") throw new Error("当前 Claude 授权流程不接收手动授权码");
		return authorizer.submitAuthorizationCode(sessionId, code, context);
	}
	async cancelAuthorization(sessionId, context = {}) {
		return (sessionId?.includes(":official-session:") ? this.clientSessionAuthorizer : sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer).cancel(sessionId, context);
	}
	async refreshAccount(account, context = {}) {
		if (this.#isBrowserAccount(account)) await this.#refreshBrowserCredential(account, context);
		const status = await this.#assertActiveSession(account, context.signal, context);
		return {
			identity: {
				email: status.email,
				displayName: status.displayName
			},
			subscription: {
				plan: status.plan,
				status: "active",
				expiresAt: null
			},
			refresh: {
				accessTokenExpiresAt: status.credential?.expiresAt ?? null,
				lastRefreshedAt: (context.now instanceof Date ? context.now : /* @__PURE__ */ new Date()).toISOString(),
				refreshable: Boolean(status.credential?.refresh)
			}
		};
	}
	async getQuota(account, context = {}) {
		const status = await this.#assertActiveSession(account, context.signal, context);
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		const quotaSource = status.sourceKind === OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP ? "official_client_status" : "claude_cli_status";
		const windows = recursiveQuotaWindows(status.raw, {
			source: quotaSource,
			now,
			prefix: "claude"
		});
		const primary = selectPrimaryQuotaWindow(windows);
		return {
			quota: {
				remaining: primary.remaining ?? null,
				limit: primary.limit ?? null,
				unit: primary.unit ?? null,
				resetAt: primary.resetAt ?? null,
				windows,
				updatedAt: now.toISOString(),
				source: quotaSource
			},
			subscription: {
				plan: status.plan,
				status: status.isSubscription ? "active" : null,
				expiresAt: null
			},
			resources: { quotaDiagnostic: windows.length ? null : "Claude 官方会话状态未返回实时订阅额度；Dockyard 不显示估算百分比" }
		};
	}
	async getCatalog(context = {}) {
		return this.catalogLoader({ force: Boolean(context.force) });
	}
	async invoke(request, invocation, context = {}) {
		await this.#assertActiveSession(invocation?.account, context.signal, context);
		const executor = context.requestExecutor ?? this.requestExecutor;
		if (typeof executor !== "function") throw new Error("Claude native invocation transport is not mounted");
		return executor({
			request,
			invocation,
			context
		});
	}
	async stream(request, invocation, context = {}) {
		return this.invoke(request, invocation, context);
	}
};
function createClaudeDriver(options = {}) {
	return new ClaudeSubscriptionDriver(options);
}
Object.freeze({ providerId: PROVIDER_ID$3 });
//#endregion
//#region vendor/dockyard/modules/provider-claude/src/native-transport.mjs
const PROVIDER_ID$2 = "claude";
const DEFAULT_ENDPOINT$1 = "https://api.anthropic.com/v1/messages";
function firstString$3(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
/** Resolve only the selected subscription account's host-side OAuth credential. */
async function resolveClaudeAccessToken({ credential } = {}) {
	const stored = firstString$3(credential?.access, credential?.token);
	if (!stored || credential?.type === "api_key") return null;
	return {
		token: stored,
		kind: "oauth"
	};
}
function toolCallPart(part) {
	const type = String(part?.type ?? "").toLowerCase().replace(/[_-]/g, "");
	return type === "toolcall" || type === "tooluse" || type === "functioncall" ? part : null;
}
async function anthropicContent(content, attachments) {
	const values = Array.isArray(content) ? content : [content];
	const blocks = [];
	for (const part of values) {
		if (typeof part === "string") {
			if (part) blocks.push({
				type: "text",
				text: part
			});
			continue;
		}
		if (!part || typeof part !== "object") continue;
		if (part.type === "image") {
			const image = await resolveImageData(part, attachments);
			if (!image) throw nativeProviderError(PROVIDER_ID$2, "image attachment could not be resolved");
			blocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: image.mediaType,
					data: image.data
				}
			});
			continue;
		}
		if (part.type === "tool-result" || part.type === "tool_result") {
			blocks.push({
				type: "tool_result",
				tool_use_id: firstString$3(part.toolCallId, part.tool_call_id, part.id, "tool-result"),
				content: textFromContent(part.content ?? part.output ?? part.result ?? part.text),
				...part.isError || part.is_error ? { is_error: true } : {}
			});
			continue;
		}
		const tool = toolCallPart(part);
		if (tool) {
			blocks.push({
				type: "tool_use",
				id: firstString$3(tool.id, tool.toolCallId, tool.tool_call_id, `tool-${blocks.length}`),
				name: firstString$3(tool.name, tool.function?.name, "tool"),
				input: parseToolArguments(tool.arguments ?? tool.input ?? tool.function?.arguments)
			});
			continue;
		}
		const text = textFromContent(part);
		if (text) blocks.push({
			type: "text",
			text
		});
	}
	return blocks;
}
async function buildAnthropicMessages(request, attachments) {
	const messages = [];
	for (const message of Array.isArray(request.messages) ? request.messages : []) {
		const role = message?.role === "assistant" ? "assistant" : message?.role === "tool" ? "user" : "user";
		const content = await anthropicContent(message?.content ?? message?.text, attachments);
		if (role === "user" && message?.role === "tool" && content.length === 0) continue;
		if (content.length > 0) messages.push({
			role,
			content: content.length === 1 && content[0].type === "text" ? content[0].text : content
		});
	}
	if (messages.length === 0) messages.push({
		role: "user",
		content: "Continue the conversation."
	});
	return messages;
}
function buildAnthropicTools(tools) {
	if (!Array.isArray(tools)) return void 0;
	const result = tools.map((tool) => ({
		name: firstString$3(tool?.name, tool?.function?.name, "tool"),
		...tool?.description ? { description: String(tool.description) } : {},
		input_schema: tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? { type: "object" }
	}));
	return result.length > 0 ? result : void 0;
}
function thinkingBudget(request) {
	const value = request?.reasoningBudget ?? request?.thinkingBudget;
	if (Number.isInteger(value) && value > 0) return value;
	const effort = String(request?.reasoningEffort ?? "").toLowerCase();
	if (effort === "high" || effort === "xhigh") return 16e3;
	if (effort === "medium") return 8e3;
	if (effort === "low") return 4e3;
	return null;
}
async function buildClaudeRequest(request = {}, context = {}) {
	const body = {
		model: request.model,
		messages: await buildAnthropicMessages(request, context.attachments),
		max_tokens: Number.isInteger(request.maxTokens) ? request.maxTokens : Number.isInteger(request.modelContext?.maxTokens) ? request.modelContext.maxTokens : 4096,
		stream: true
	};
	if (typeof request.system === "string" && request.system.length > 0) body.system = request.system;
	if (request.temperature !== void 0) body.temperature = request.temperature;
	const tools = buildAnthropicTools(request.tools);
	if (tools) body.tools = tools;
	const budget = thinkingBudget(request);
	if (budget && body.max_tokens > budget) body.thinking = {
		type: "enabled",
		budget_tokens: budget
	};
	return body;
}
function headersForToken(auth, userAgent) {
	const headers = {
		"content-type": "application/json",
		accept: "text/event-stream",
		"anthropic-version": "2023-06-01"
	};
	if (userAgent) headers["user-agent"] = userAgent;
	if (auth.kind === "apiKey" || auth.token.startsWith("sk-ant-")) headers["x-api-key"] = auth.token;
	else {
		headers.authorization = `Bearer ${auth.token}`;
		headers["anthropic-beta"] = "oauth-2025-04-20";
		headers["anthropic-client-platform"] = "DESKTOP_APP";
		headers["anthropic-client-version"] = "1.0.0";
	}
	return headers;
}
function mergeUsage(previous, next) {
	return next ? {
		...previous ?? {},
		...next
	} : previous;
}
async function* streamClaudeResponse(response) {
	let text = "";
	let textIndex = 0;
	let textOpen = true;
	let nextIndex = 1;
	let usage = null;
	let stop = "stop";
	const tools = /* @__PURE__ */ new Map();
	const reasoning = /* @__PURE__ */ new Map();
	yield {
		type: "block-start",
		index: textIndex,
		blockType: "text"
	};
	for await (const event of readSseEvents(response)) {
		const payload = event.data;
		if (!payload || typeof payload !== "object") continue;
		if (payload.type === "message_start") {
			usage = mergeUsage(usage, normalizeUsage(payload.message?.usage));
			continue;
		}
		if (payload.type === "content_block_start") {
			const block = payload.content_block ?? {};
			if (block.type === "tool_use" || block.type === "thinking" || block.type === "redacted_thinking") {
				if (textOpen) {
					yield {
						type: "block-end",
						index: textIndex,
						block: {
							type: "text",
							text
						}
					};
					textOpen = false;
				}
				const index = nextIndex++;
				if (block.type === "tool_use") {
					tools.set(payload.index, {
						index,
						id: firstString$3(block.id, `tool-${payload.index}`),
						name: firstString$3(block.name, "tool"),
						arguments: ""
					});
					yield {
						type: "block-start",
						index,
						blockType: "tool-call"
					};
				} else {
					reasoning.set(payload.index, {
						index,
						text: ""
					});
					yield {
						type: "block-start",
						index,
						blockType: "reasoning"
					};
				}
				continue;
			}
			if (block.type === "text" && !textOpen) {
				textIndex = nextIndex++;
				text = "";
				textOpen = true;
				yield {
					type: "block-start",
					index: textIndex,
					blockType: "text"
				};
			}
			continue;
		}
		if (payload.type === "content_block_delta") {
			const delta = payload.delta ?? {};
			if (delta.type === "text_delta" && delta.text) {
				if (!textOpen) {
					textIndex = nextIndex++;
					text = "";
					textOpen = true;
					yield {
						type: "block-start",
						index: textIndex,
						blockType: "text"
					};
				}
				text += delta.text;
				yield {
					type: "text-delta",
					index: textIndex,
					text: delta.text
				};
			} else if (delta.type === "thinking_delta" && delta.thinking) {
				let state = reasoning.get(payload.index);
				if (!state) {
					if (textOpen) {
						yield {
							type: "block-end",
							index: textIndex,
							block: {
								type: "text",
								text
							}
						};
						textOpen = false;
					}
					state = {
						index: nextIndex++,
						text: ""
					};
					reasoning.set(payload.index, state);
					yield {
						type: "block-start",
						index: state.index,
						blockType: "reasoning"
					};
				}
				state.text += delta.thinking;
				yield {
					type: "reasoning-delta",
					index: state.index,
					text: delta.thinking
				};
			} else if (delta.type === "input_json_delta" && tools.has(payload.index)) {
				const tool = tools.get(payload.index);
				tool.arguments += delta.partial_json ?? "";
				yield {
					type: "tool-call-delta",
					index: tool.index,
					id: tool.id,
					name: tool.name,
					argumentsDelta: delta.partial_json ?? ""
				};
			}
			continue;
		}
		if (payload.type === "content_block_stop") {
			const thought = reasoning.get(payload.index);
			if (thought) {
				yield {
					type: "block-end",
					index: thought.index,
					block: {
						type: "reasoning",
						text: thought.text
					}
				};
				reasoning.delete(payload.index);
			}
			const tool = tools.get(payload.index);
			if (tool) {
				yield {
					type: "block-end",
					index: tool.index,
					block: {
						type: "tool-call",
						id: tool.id,
						name: tool.name,
						arguments: tool.arguments || "{}"
					}
				};
				tools.delete(payload.index);
			}
			continue;
		}
		if (payload.type === "message_delta") {
			stop = payload.delta?.stop_reason ?? stop;
			usage = mergeUsage(usage, normalizeUsage(payload.usage));
			continue;
		}
		if (payload.type === "error") throw nativeProviderError(PROVIDER_ID$2, payload.error?.message ?? "Anthropic returned an error", {
			status: payload.error?.status,
			body: payload.error
		});
	}
	for (const thought of reasoning.values()) yield {
		type: "block-end",
		index: thought.index,
		block: {
			type: "reasoning",
			text: thought.text
		}
	};
	if (textOpen) yield {
		type: "block-end",
		index: textIndex,
		block: {
			type: "text",
			text
		}
	};
	for (const tool of tools.values()) yield {
		type: "block-end",
		index: tool.index,
		block: {
			type: "tool-call",
			id: tool.id,
			name: tool.name,
			arguments: tool.arguments || "{}"
		}
	};
	if (usage) yield {
		type: "usage",
		usage
	};
	yield {
		type: "finish",
		reason: finishReason(stop)
	};
}
function createClaudeNativeExecutor({ endpoint = process.env.DOCKYARD_CLAUDE_ENDPOINT || DEFAULT_ENDPOINT$1, env = process.env, timeoutMs = 3e5, fetchImpl = fetch, tokenResolver = resolveClaudeAccessToken, userAgent = null } = {}) {
	const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID$2 });
	const executor = async ({ request = {}, invocation, context = {} } = {}) => {
		let credential = null;
		if (context.secretStore) {
			const ref = invocation?.auth?.credentialRef ?? invocation?.account?.auth?.credentialRef ?? invocation?.account?.credentialRef;
			if (ref) credential = await context.secretStore.read(ref);
		}
		const auth = await tokenResolver({
			credential,
			env: {
				...env,
				...context.env ?? {}
			}
		});
		if (!auth?.token) {
			const error = nativeProviderError(PROVIDER_ID$2, "Claude OAuth token is unavailable; authorize Claude first");
			error.authExpired = true;
			throw error;
		}
		const body = await buildClaudeRequest(request, context);
		return streamClaudeResponse(await fetchNativeResponse(safeEndpoint, {
			method: "POST",
			headers: headersForToken(auth, userAgent),
			body: JSON.stringify(body),
			signal: context.signal
		}, {
			providerId: PROVIDER_ID$2,
			timeoutMs,
			fetchImpl
		}));
	};
	executor.nativeTransport = "anthropic-messages";
	return executor;
}
Object.freeze({
	providerId: PROVIDER_ID$2,
	endpoint: DEFAULT_ENDPOINT$1
});
//#endregion
//#region vendor/dockyard/modules/provider-claude/src/index.mjs
function createClaudeModule({ driver = {} } = {}) {
	return defineProviderModule({
		id: "claude",
		displayName: "Claude",
		capabilities: [
			"oauth_discovery",
			"oauth_import",
			"oauth_authorization",
			"oauth_refresh",
			"quota",
			"catalog",
			"invoke",
			"stream"
		],
		driver
	});
}
//#endregion
//#region vendor/dockyard/modules/provider-cursor/src/native-protocol.mjs
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function concatBytes(parts) {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}
function encodeVarint(value) {
	let current = BigInt(Math.max(0, Number(value) || 0));
	const result = [];
	while (current >= 128n) {
		result.push(Number(current & 127n | 128n));
		current >>= 7n;
	}
	result.push(Number(current));
	return Uint8Array.from(result);
}
function fieldKey(field, wireType) {
	return encodeVarint(field << 3 | wireType);
}
function bytesField(field, value) {
	const bytes = typeof value === "string" ? textEncoder.encode(value) : value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
	return concatBytes([
		fieldKey(field, 2),
		encodeVarint(bytes.byteLength),
		bytes
	]);
}
function stringField(field, value) {
	return bytesField(field, textEncoder.encode(String(value ?? "")));
}
function varintField(field, value) {
	return concatBytes([fieldKey(field, 0), encodeVarint(value)]);
}
function frameConnectMessage(message, flags = 0) {
	const payload = message instanceof Uint8Array ? message : Uint8Array.from(message ?? []);
	const header = /* @__PURE__ */ new Uint8Array(5);
	header[0] = flags & 255;
	new DataView(header.buffer).setUint32(1, payload.byteLength, false);
	return concatBytes([header, payload]);
}
function decodeProtoFields(bytes) {
	const value = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
	const fields = [];
	let offset = 0;
	while (offset < value.length) {
		const key = readVarint(value, offset);
		if (!key) break;
		offset = key.offset;
		const field = Number(key.value >> 3n);
		const wireType = Number(key.value & 7n);
		if (wireType === 0) {
			const parsed = readVarint(value, offset);
			if (!parsed) break;
			offset = parsed.offset;
			fields.push({
				field,
				wireType,
				value: Number(parsed.value)
			});
			continue;
		}
		if (wireType === 1) {
			if (offset + 8 > value.length) break;
			fields.push({
				field,
				wireType,
				value: value.slice(offset, offset + 8)
			});
			offset += 8;
			continue;
		}
		if (wireType === 2) {
			const length = readVarint(value, offset);
			if (!length) break;
			offset = length.offset;
			const end = offset + Number(length.value);
			if (end > value.length) break;
			fields.push({
				field,
				wireType,
				value: value.slice(offset, end)
			});
			offset = end;
			continue;
		}
		if (wireType === 5) {
			if (offset + 4 > value.length) break;
			fields.push({
				field,
				wireType,
				value: value.slice(offset, offset + 4)
			});
			offset += 4;
			continue;
		}
		break;
	}
	return fields;
}
function readVarint(bytes, start) {
	let offset = start;
	let value = 0n;
	let shift = 0n;
	while (offset < bytes.length && shift <= 63n) {
		const byte = bytes[offset++];
		value |= BigInt(byte & 127) << shift;
		if ((byte & 128) === 0) return {
			value,
			offset
		};
		shift += 7n;
	}
	return null;
}
function firstBytes(fields, field) {
	return fields.find((entry) => entry.field === field && entry.wireType === 2)?.value ?? null;
}
function firstString$2(fields, field) {
	const bytes = firstBytes(fields, field);
	return bytes ? textDecoder.decode(bytes) : "";
}
function sha256(bytes) {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}
function putBlob(store, value) {
	const bytes = value instanceof Uint8Array ? value : textEncoder.encode(String(value));
	const id = sha256(bytes);
	store.set(Buffer.from(id).toString("hex"), bytes);
	return id;
}
function jsonBlob(store, value) {
	return putBlob(store, textEncoder.encode(JSON.stringify(value)));
}
function normalizeText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(normalizeText).filter(Boolean).join("");
	if (!content || typeof content !== "object") return "";
	if (content.type === "image") return "[image attachment]";
	if (content.type === "tool-result" || content.type === "tool_result") return `[Tool Result]\n${normalizeText(content.content ?? content.output ?? content.result ?? content.text)}`;
	if (content.type === "tool-call" || content.type === "tool_call") return `[Tool Call ${content.name ?? "tool"}] ${content.arguments ?? "{}"}`;
	return String(content.text ?? content.value ?? content.content ?? content.delta ?? "");
}
function normalizedMessages(messages) {
	return (Array.isArray(messages) ? messages : []).map((message) => ({
		role: String(message?.role ?? "user"),
		content: normalizeText(message?.content ?? message?.text).trim()
	})).filter((message) => message.content.length > 0);
}
function encodeUserMessage(text, messageId, mode = 1) {
	return concatBytes([
		stringField(1, text),
		stringField(2, messageId),
		varintField(4, mode)
	]);
}
function encodeAssistantStep(text) {
	return bytesField(1, stringField(1, text));
}
function encodeConversationTurn(userMessageId, stepIds, requestId) {
	return concatBytes([
		bytesField(1, userMessageId),
		...stepIds.map((id) => bytesField(2, id)),
		...requestId ? [stringField(3, requestId)] : []
	]);
}
function encodeConversationState(messages, blobStore, requestId) {
	const roots = [];
	const turns = [];
	const turnRecords = [];
	for (const message of messages) {
		if (message.role === "system") {
			roots.push(jsonBlob(blobStore, {
				role: "system",
				content: message.content
			}));
			continue;
		}
		if (message.role === "user") {
			const userMessage = {
				role: "user",
				content: [{
					type: "text",
					text: message.content
				}]
			};
			roots.push(jsonBlob(blobStore, userMessage));
			turnRecords.push({
				text: message.content,
				steps: []
			});
			continue;
		}
		if (message.role === "assistant") {
			roots.push(jsonBlob(blobStore, {
				role: "assistant",
				content: [{
					type: "text",
					text: message.content
				}]
			}));
			turnRecords.at(-1)?.steps.push(putBlob(blobStore, encodeAssistantStep(message.content)));
			continue;
		}
		const resultText = `[Tool Result]\n${message.content}`;
		roots.push(jsonBlob(blobStore, {
			role: "user",
			content: [{
				type: "text",
				text: resultText
			}]
		}));
		turnRecords.at(-1)?.steps.push(putBlob(blobStore, encodeAssistantStep(resultText)));
	}
	for (const record of turnRecords.slice(0, -1)) {
		const turn = encodeConversationTurn(putBlob(blobStore, encodeUserMessage(record.text, randomUUID())), record.steps, requestId);
		turns.push(putBlob(blobStore, turn));
	}
	return concatBytes([...roots.map((id) => bytesField(1, id)), ...turns.map((id) => bytesField(8, id))]);
}
function encodeRequestContext(timeZone = "UTC") {
	return bytesField(2, bytesField(4, stringField(10, timeZone)));
}
function encodeModelDetails(model) {
	return concatBytes([
		stringField(1, model),
		stringField(3, model),
		stringField(4, model),
		stringField(5, model)
	]);
}
function encodeMcpTools(tools) {
	return concatBytes((Array.isArray(tools) ? tools : []).map((tool) => {
		const name = String(tool?.name ?? tool?.function?.name ?? "").trim();
		if (!name) return null;
		const fn = tool?.function ?? tool;
		return bytesField(1, concatBytes([
			stringField(1, name),
			stringField(4, "opencodex-responses"),
			stringField(5, name),
			stringField(2, fn?.description ?? "")
		]));
	}).filter(Boolean));
}
/** Build an AgentService Run request and retain the blobs for KV responses. */
function encodeAgentRunRequest({ messages, model, requestId = randomUUID(), conversationId = requestId, tools = [], timeZone = "UTC" } = {}) {
	const normalized = normalizedMessages(messages);
	const blobStore = /* @__PURE__ */ new Map();
	const latestUserIndex = normalized.map((message) => message.role).lastIndexOf("user");
	const latestUserText = latestUserIndex >= 0 ? normalized[latestUserIndex].content : normalized.at(-1)?.content ?? "Continue the conversation.";
	const priorConversation = latestUserIndex > 0 ? normalized.slice(0, latestUserIndex).filter((message) => message.role !== "system").map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`).join("\n\n") : "";
	const action = bytesField(1, concatBytes([bytesField(1, encodeUserMessage(priorConversation ? `Conversation history:\n${priorConversation}\n\nCurrent user message:\n${latestUserText}` : latestUserText, requestId, 1)), encodeRequestContext(timeZone)]));
	return {
		frame: frameConnectMessage(bytesField(1, concatBytes([
			bytesField(1, encodeConversationState(normalized, blobStore, requestId)),
			bytesField(2, action),
			bytesField(3, encodeModelDetails(String(model ?? ""))),
			bytesField(4, encodeMcpTools(tools)),
			stringField(5, conversationId)
		]))),
		blobs: blobStore,
		requestId,
		conversationId
	};
}
function encodeHeartbeat() {
	return frameConnectMessage(bytesField(7, /* @__PURE__ */ new Uint8Array()));
}
function decodeConnectFrames(buffer, { maxFrameBytes = 8 * 1024 * 1024 } = {}) {
	const frames = [];
	let offset = 0;
	while (buffer.length - offset >= 5) {
		const flags = buffer[offset];
		const length = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0, false);
		if (length > maxFrameBytes) {
			const error = /* @__PURE__ */ new Error(`Cursor Connect frame exceeds ${maxFrameBytes} bytes`);
			error.code = "CURSOR_FRAME_TOO_LARGE";
			error.frameLength = length;
			throw error;
		}
		if (buffer.length - offset - 5 < length) break;
		frames.push({
			flags,
			payload: buffer.slice(offset + 5, offset + 5 + length)
		});
		offset += 5 + length;
	}
	return {
		frames,
		rest: buffer.slice(offset)
	};
}
/**
* Return redacted wire metadata for diagnostics. This deliberately records
* only Connect flags, byte lengths, wire types, and protobuf field paths.
*/
function cursorFrameMetadata(message, flags = null) {
	const bytes = message instanceof Uint8Array ? message : Uint8Array.from(message ?? []);
	const fieldPaths = [];
	const visit = (value, prefix = [], depth = 0) => {
		if (depth > 4 || fieldPaths.length >= 64) return;
		for (const field of decodeProtoFields(value).slice(0, 32)) {
			const path = [...prefix, field.field].join(".");
			fieldPaths.push({
				path,
				wireType: field.wireType,
				byteLength: field.value instanceof Uint8Array ? field.value.byteLength : null
			});
			if (field.wireType === 2) visit(field.value, [...prefix, field.field], depth + 1);
			if (fieldPaths.length >= 64) return;
		}
	};
	visit(bytes);
	return {
		...Number.isInteger(flags) ? { flags } : {},
		payloadLength: bytes.byteLength,
		fieldPaths
	};
}
/**
* Connect's end-stream frame is a JSON envelope for this Cursor endpoint.
* Older code treated every trailer as a successful turn, which made upstream
* quota errors appear in the UI as an empty assistant message.
*/
function decodeCursorConnectTrailer(payload) {
	const text = textDecoder.decode(payload instanceof Uint8Array ? payload : Uint8Array.from(payload ?? [])).trim();
	if (!text) return null;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			code: "CURSOR_CONNECT_ERROR",
			message: text.slice(0, 500)
		};
	}
	const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
	if (!error) return null;
	const code = typeof error.code === "string" && error.code.trim() ? error.code.trim() : "CURSOR_CONNECT_ERROR";
	return {
		code,
		message: typeof error.message === "string" && error.message.trim() ? error.message.trim().slice(0, 500) : code
	};
}
function decodeCursorText(message) {
	try {
		const interaction = firstBytes(decodeProtoFields(message), 1);
		if (!interaction) return "";
		const update = firstBytes(decodeProtoFields(interaction), 1);
		if (!update) return "";
		return firstString$2(decodeProtoFields(update), 1);
	} catch {
		return "";
	}
}
function cursorTurnComplete(message) {
	try {
		const interaction = firstBytes(decodeProtoFields(message), 1);
		if (!interaction) return false;
		return decodeProtoFields(interaction).some((field) => field.wireType === 2 && [
			14,
			18,
			19
		].includes(field.field));
	} catch {
		return false;
	}
}
function decodeKvRequest(message) {
	const kv = firstBytes(decodeProtoFields(message), 4);
	if (!kv) return null;
	const fields = decodeProtoFields(kv);
	const id = fields.find((field) => field.field === 1 && field.wireType === 0)?.value ?? 0;
	const getArgs = firstBytes(fields, 2);
	const setArgs = firstBytes(fields, 3);
	if (getArgs) return {
		id,
		kind: "get",
		blobId: firstBytes(decodeProtoFields(getArgs), 1)
	};
	if (setArgs) return {
		id,
		kind: "set"
	};
	return null;
}
function encodeKvResponse(request, blobs) {
	if (request.kind === "get") {
		const key = request.blobId ? Buffer.from(request.blobId).toString("hex") : "";
		const result = bytesField(1, blobs.get(key) ?? /* @__PURE__ */ new Uint8Array());
		return frameConnectMessage(bytesField(3, concatBytes([varintField(1, request.id), bytesField(2, result)])));
	}
	return frameConnectMessage(bytesField(3, concatBytes([varintField(1, request.id), bytesField(3, /* @__PURE__ */ new Uint8Array())])));
}
function decodeCursorKvRequest(message) {
	return decodeKvRequest(message);
}
const cursorNativeProtocolConstants = Object.freeze({
	endpoint: "https://agent.api5.cursor.sh/agent.v1.AgentService/Run",
	providerIdentifier: "opencodex-responses"
});
//#endregion
//#region vendor/dockyard/modules/provider-cursor/src/native-transport.mjs
const PROVIDER_ID$1 = "cursor";
const DEFAULT_ENDPOINT = cursorNativeProtocolConstants.endpoint;
const CURSOR_SESSION_KEYS = [
	"cursorAuth/accessToken",
	"cursorAuth/refreshToken",
	"cursorAuth/cachedEmail",
	"cursorAuth/stripeMembershipType"
];
function firstString$1(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
function createAsyncQueue() {
	const values = [];
	const waiters = [];
	let closed = false;
	let failure = null;
	return {
		push(value) {
			if (closed || failure) return;
			const waiter = waiters.shift();
			if (waiter) waiter.resolve({
				value,
				done: false
			});
			else values.push(value);
		},
		close() {
			if (closed || failure) return;
			closed = true;
			while (waiters.length) waiters.shift().resolve({
				value: void 0,
				done: true
			});
		},
		fail(error) {
			if (closed || failure) return;
			failure = error;
			while (waiters.length) waiters.shift().reject(error);
		},
		async next() {
			if (values.length) return {
				value: values.shift(),
				done: false
			};
			if (failure) throw failure;
			if (closed) return {
				value: void 0,
				done: true
			};
			return new Promise((resolve, reject) => waiters.push({
				resolve,
				reject
			}));
		},
		[Symbol.asyncIterator]() {
			return this;
		}
	};
}
/**
* Read Cursor's official desktop OAuth session without starting cursor-agent.
* The token is returned only to the provider module/native transport and is
* never included in a public DSH snapshot.
*/
function readCursorDesktopSession({ credential, env = process.env, home = homedir(), allowDesktopSession = false } = {}) {
	const stored = firstString$1(credential?.access, credential?.token);
	if (stored) return {
		token: stored,
		refreshToken: firstString$1(credential?.refresh, credential?.refreshToken),
		expiresAt: firstString$1(credential?.expiresAt, credential?.expires_at),
		email: firstString$1(credential?.email),
		plan: firstString$1(credential?.plan),
		kind: "oauth",
		source: "dockyard_credential"
	};
	if (!allowDesktopSession || process.platform !== "darwin") return null;
	const dbPath = join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
	try {
		const output = execFileSync("sqlite3", [
			"-json",
			dbPath,
			`SELECT key, CAST(value AS TEXT) AS value FROM ItemTable WHERE key IN (${CURSOR_SESSION_KEYS.map((key) => `'${key}'`).join(",")});`
		], {
			encoding: "utf8",
			timeout: 5e3,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
		const rows = JSON.parse(output || "[]");
		const valueFor = (key) => rows.find((row) => row.key === key)?.value;
		const access = valueFor("cursorAuth/accessToken");
		return access ? {
			token: access,
			refreshToken: firstString$1(valueFor("cursorAuth/refreshToken")),
			email: firstString$1(valueFor("cursorAuth/cachedEmail")),
			plan: firstString$1(valueFor("cursorAuth/stripeMembershipType")),
			kind: "oauth",
			source: "cursor_desktop_app"
		} : null;
	} catch {
		return null;
	}
}
/** Resolve Cursor's access token without starting cursor-agent. */
function resolveCursorAccessToken(options = {}) {
	const session = readCursorDesktopSession(options);
	return session ? {
		token: session.token,
		kind: session.kind,
		...session.expiresAt ? { expiresAt: session.expiresAt } : {}
	} : null;
}
function cursorHeaders(endpoint, token, requestId, env, userAgent) {
	const clientVersion = env.DOCKYARD_CURSOR_CLIENT_VERSION ?? `cli-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, ".")}-agent-host`;
	const clientKey = randomBytes(32).toString("hex");
	return {
		":method": "POST",
		":path": `${endpoint.pathname}${endpoint.search}`,
		":scheme": "https",
		":authority": endpoint.host,
		authorization: `Bearer ${token}`,
		"content-type": "application/connect+proto",
		accept: "application/connect+proto",
		"connect-protocol-version": "1",
		"x-request-id": requestId,
		"x-cursor-client-version": clientVersion,
		"x-cursor-client-type": "cli",
		"x-cursor-client-key": clientKey,
		"x-cursor-streaming": "true",
		...userAgent ? { "user-agent": userAgent } : {}
	};
}
function cursorStatusError(status) {
	return nativeProviderError(PROVIDER_ID$1, `Cursor AgentService returned HTTP ${status}`, { status });
}
function streamCursor({ endpoint, token, request, context, http2Module = http2, timeoutMs = 12e4, maxFrameBytes = 8 * 1024 * 1024, maxBufferBytes = 8388613, maxResponseBytes = 32 * 1024 * 1024, userAgent = null }) {
	return (async function* cursorStream() {
		const requestId = firstString$1(request.requestId, context.requestId, randomUUID());
		const conversationId = firstString$1(request.sessionId, context.sessionId, requestId);
		const model = firstString$1(request.model);
		if (!model) throw nativeProviderError(PROVIDER_ID$1, "Cursor model is missing");
		const timeZone = (() => {
			try {
				return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			} catch {
				return "UTC";
			}
		})();
		const encoded = encodeAgentRunRequest({
			messages: request.messages,
			model,
			requestId,
			conversationId,
			tools: [],
			timeZone
		});
		const url = new URL(endpoint);
		const session = http2Module.connect(url.origin);
		const queue = createAsyncQueue();
		let stream = null;
		let responseStatus = 0;
		let responseBuffer = /* @__PURE__ */ new Uint8Array();
		let responseBytes = 0;
		const responseDiagnostics = [];
		const protocolError = (message, code) => {
			const error = nativeProviderError(PROVIDER_ID$1, message, { code });
			if (responseDiagnostics.length > 0) error.cursorDiagnostics = responseDiagnostics.slice(0, 32);
			return error;
		};
		let completed = false;
		let cleaned = false;
		let heartbeat;
		let requestTimer;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			clearInterval(heartbeat);
			clearTimeout(requestTimer);
			context.signal?.removeEventListener?.("abort", onAbort);
			if (stream && !stream.destroyed && !stream.closed) stream.close();
			if (!session.closed && !session.destroyed) session.close();
		};
		const onAbort = () => {
			const error = nativeProviderError(PROVIDER_ID$1, "Cursor request aborted");
			error.code = "ABORT_ERR";
			queue.fail(error);
			stream?.close(http2Module.constants?.NGHTTP2_CANCEL);
			session.close();
		};
		session.once("error", (error) => queue.fail(error));
		try {
			stream = session.request(cursorHeaders(url, token, requestId, context.env ?? process.env, userAgent));
			stream.once("response", (headers) => {
				responseStatus = Number(headers[":status"] ?? 0);
				if (responseStatus >= 400) queue.fail(cursorStatusError(responseStatus));
			});
			stream.on("data", (chunk) => {
				const incoming = new Uint8Array(chunk);
				responseBytes += incoming.byteLength;
				if (responseBytes > maxResponseBytes) {
					queue.fail(protocolError("Cursor AgentService response exceeded the size limit", "CURSOR_RESPONSE_TOO_LARGE"));
					stream?.close(http2Module.constants?.NGHTTP2_CANCEL);
					session.close();
					return;
				}
				if (responseBuffer.byteLength + incoming.byteLength > maxBufferBytes) {
					queue.fail(protocolError("Cursor AgentService buffered frame exceeded the size limit", "CURSOR_BUFFER_TOO_LARGE"));
					stream?.close(http2Module.constants?.NGHTTP2_CANCEL);
					session.close();
					return;
				}
				const merged = new Uint8Array(responseBuffer.byteLength + incoming.byteLength);
				merged.set(responseBuffer);
				merged.set(incoming, responseBuffer.byteLength);
				let decoded;
				try {
					decoded = decodeConnectFrames(merged, { maxFrameBytes });
				} catch (error) {
					queue.fail(protocolError(error.message, error.code ?? "CURSOR_FRAME_INVALID"));
					stream?.close(http2Module.constants?.NGHTTP2_CANCEL);
					session.close();
					return;
				}
				responseBuffer = decoded.rest;
				for (const frame of decoded.frames) {
					if ((frame.flags & 2) !== 0) {
						const trailer = decodeCursorConnectTrailer(frame.payload);
						if (trailer) queue.fail(nativeProviderError(PROVIDER_ID$1, trailer.message, {
							code: trailer.code,
							body: {
								code: trailer.code,
								message: trailer.message
							}
						}));
						else {
							completed = true;
							queue.push({ type: "complete" });
						}
						continue;
					}
					if ((frame.flags & 1) !== 0) {
						responseDiagnostics.push(cursorFrameMetadata(frame.payload, frame.flags));
						queue.fail(protocolError("Cursor returned a compressed protobuf frame", "CURSOR_COMPRESSED_RESPONSE"));
						continue;
					}
					const kv = decodeCursorKvRequest(frame.payload);
					if (kv) {
						try {
							stream?.write(Buffer.from(encodeKvResponse(kv, encoded.blobs)));
						} catch (error) {
							queue.fail(error);
						}
						continue;
					}
					const text = decodeCursorText(frame.payload);
					const turnComplete = cursorTurnComplete(frame.payload);
					if (text) queue.push({
						type: "text",
						text
					});
					if (!text) responseDiagnostics.push(cursorFrameMetadata(frame.payload, frame.flags));
					if (turnComplete) {
						completed = true;
						queue.push({ type: "complete" });
					}
				}
			});
			stream.once("end", () => {
				if (responseBuffer.byteLength > 0) {
					responseDiagnostics.push({
						payloadLength: responseBuffer.byteLength,
						incomplete: true
					});
					queue.fail(protocolError("Cursor AgentService returned an incomplete Connect frame", "CURSOR_INCOMPLETE_RESPONSE"));
				} else queue.close();
			});
			stream.once("error", (error) => queue.fail(error));
			stream.write(Buffer.from(encoded.frame));
			heartbeat = setInterval(() => {
				if (!stream || stream.destroyed || stream.closed) return;
				try {
					stream.write(Buffer.from(encodeHeartbeat()));
				} catch {}
			}, 5e3);
			context.signal?.addEventListener?.("abort", onAbort, { once: true });
			requestTimer = setTimeout(() => {
				const error = nativeProviderError(PROVIDER_ID$1, "Cursor AgentService request timed out", { code: "CURSOR_REQUEST_TIMEOUT" });
				queue.fail(error);
				stream?.close(http2Module.constants?.NGHTTP2_CANCEL);
				session.close();
			}, timeoutMs);
			requestTimer.unref?.();
			let text = "";
			let failed = false;
			yield {
				type: "block-start",
				index: 0,
				blockType: "text"
			};
			try {
				for await (const item of queue) if (item.type === "text") {
					text += item.text;
					yield {
						type: "text-delta",
						index: 0,
						text: item.text
					};
				} else if (item.type === "complete") {
					completed = true;
					break;
				}
			} catch (error) {
				failed = true;
				if (error?.status === 401 || error?.status === 403) error.authExpired = error.status === 401;
				throw error;
			} finally {
				cleanup();
			}
			if (!failed) {
				if (!completed) throw protocolError("Cursor AgentService ended before completing the turn", "CURSOR_INCOMPLETE_RESPONSE");
				if (text.trim().length === 0) throw protocolError("Cursor AgentService completed without assistant text", "CURSOR_EMPTY_RESPONSE");
				yield {
					type: "block-end",
					index: 0,
					block: {
						type: "text",
						text
					}
				};
				yield {
					type: "finish",
					reason: { kind: "stop" }
				};
			}
		} catch (error) {
			cleanup();
			throw error;
		}
	})();
}
function createCursorNativeExecutor({ endpoint = process.env.DOCKYARD_CURSOR_ENDPOINT || DEFAULT_ENDPOINT, env = process.env, home = homedir(), tokenResolver = resolveCursorAccessToken, http2Module = http2, timeoutMs = 12e4, maxFrameBytes = 8 * 1024 * 1024, maxBufferBytes = maxFrameBytes + 5, maxResponseBytes = 32 * 1024 * 1024, userAgent = null } = {}) {
	const safeEndpoint = validateNativeEndpoint(endpoint, { providerId: PROVIDER_ID$1 });
	const executor = async ({ request = {}, invocation, context = {} } = {}) => {
		let credential = null;
		if (context.secretStore) {
			const ref = invocation?.auth?.credentialRef ?? invocation?.account?.auth?.credentialRef ?? invocation?.account?.credentialRef;
			if (ref) credential = await context.secretStore.read(ref);
		}
		const auth = await tokenResolver({
			credential,
			env: {
				...env,
				...context.env ?? {}
			},
			home
		});
		if (!auth?.token) {
			const error = nativeProviderError(PROVIDER_ID$1, "Cursor OAuth token is unavailable; authorize Cursor first");
			error.authExpired = true;
			throw error;
		}
		if (auth.expiresAt) {
			const expiry = Date.parse(auth.expiresAt);
			if (Number.isFinite(expiry) && expiry <= Date.now()) {
				const error = nativeProviderError(PROVIDER_ID$1, "Cursor OAuth access token expired; authorize Cursor again", { code: "CURSOR_TOKEN_EXPIRED" });
				error.authExpired = true;
				throw error;
			}
		}
		return streamCursor({
			endpoint: safeEndpoint,
			token: auth.token,
			request,
			context,
			http2Module,
			timeoutMs,
			maxFrameBytes,
			maxBufferBytes,
			maxResponseBytes,
			userAgent
		});
	};
	executor.nativeTransport = "cursor-connect-agent-service";
	return executor;
}
Object.freeze({
	providerId: PROVIDER_ID$1,
	endpoint: DEFAULT_ENDPOINT
});
//#endregion
//#region vendor/dockyard/modules/provider-cursor/src/driver.mjs
const PROVIDER_ID = "cursor";
const CURSOR_ALLOWED_ORIGINS = /* @__PURE__ */ new Set(["https://cursor.com", "https://api2.cursor.sh"]);
function validateCursorOrigin(value, label) {
	const url = new URL(value);
	if (url.protocol !== "https:" || !CURSOR_ALLOWED_ORIGINS.has(url.origin)) throw new Error(`Cursor ${label} endpoint must use an allowlisted official HTTPS origin`);
	return url.href.replace(/\/+$/, "");
}
function validateCursorUrl(value, label, expectedOrigin = null) {
	const url = new URL(value);
	if (url.protocol !== "https:" || !CURSOR_ALLOWED_ORIGINS.has(url.origin)) throw new Error(`Cursor ${label} endpoint must use an allowlisted official HTTPS origin`);
	if (expectedOrigin && url.origin !== new URL(expectedOrigin).origin) throw new Error(`Cursor ${label} endpoint must match the official API origin`);
	return url;
}
const CREDENTIAL_SLOT = Symbol("dockyard-cursor-session");
function hash(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}
function firstString(...values) {
	return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}
function normalizeTokenExpiry(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		const millis = value > 0xe8d4a51000 ? value : value * 1e3;
		const date = new Date(millis);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function cursorTokenExpiresAt(raw = {}, payload = {}) {
	const direct = normalizeTokenExpiry(raw.expiresAt ?? raw.expires_at);
	if (direct) return direct;
	const expiresIn = raw.expiresIn ?? raw.expires_in;
	if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) return new Date(Date.now() + expiresIn * 1e3).toISOString();
	return normalizeTokenExpiry(payload.exp);
}
function tokenIsExpired(value, now = Date.now()) {
	const timestamp = Date.parse(String(value ?? ""));
	return Number.isFinite(timestamp) && timestamp <= now;
}
function tokenNeedsRefresh(value, now = Date.now(), leewayMs = 6e4) {
	const timestamp = Date.parse(String(value ?? ""));
	return Number.isFinite(timestamp) && timestamp <= now + leewayMs;
}
function statusObject(output) {
	return parseJsonOutput$1(output) ?? {};
}
function statusValue(value, ...keys) {
	for (const key of keys) {
		const parts = key.split(".");
		let current = value;
		for (const part of parts) current = current?.[part];
		if (typeof current === "string" && current.length > 0) return current;
		if (typeof current === "number" || typeof current === "boolean") return current;
		if (Array.isArray(current)) return current;
		if (current && typeof current === "object") return current;
	}
	return null;
}
function parseTextEmail(output) {
	return String(output).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}
/** Parse only Cursor's public status output; credentials are never scraped. */
function parseCursorAuthStatus(output) {
	const raw = statusObject(output);
	const email = firstString(statusValue(raw, "email", "user.email", "account.email", "accountEmail"), parseTextEmail(output));
	const explicitLoggedIn = statusValue(raw, "loggedIn", "authenticated", "isAuthenticated");
	const text = String(output);
	const loggedIn = typeof explicitLoggedIn === "boolean" ? explicitLoggedIn : !/not authenticated|not logged in|unauthenticated|please login/i.test(text) && /authenticated|logged in|account|endpoint/i.test(text);
	const accountId = firstString(statusValue(raw, "accountId", "account_id", "userId", "user_id", "user.id", "account.id"), email, "cursor:active");
	return {
		loggedIn,
		accountId,
		email,
		plan: firstString(statusValue(raw, "plan", "planName", "subscription.plan", "subscription.name", "tier", "subscriptionTier")),
		displayName: firstString(statusValue(raw, "name", "user.name", "account.name"), email, accountId),
		models: [
			statusValue(raw, "models"),
			statusValue(raw, "availableModels"),
			statusValue(raw, "modelCatalog")
		].find((value) => Array.isArray(value)) ?? [],
		raw
	};
}
function activeSessionError(message, { mismatch = false } = {}) {
	const error = new Error(message);
	error.authExpired = true;
	if (mismatch) error.accountMismatch = true;
	return error;
}
function candidateFromStatus(status, { source = "official_cursor_cli", sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.CLI, imported = false, credential = null } = {}) {
	const credentialRef = createCredentialRef(PROVIDER_ID, status.accountId);
	const candidate = {
		candidateId: `cursor:${hash(status.accountId).slice(0, 20)}`,
		providerId: PROVIDER_ID,
		source,
		accountId: status.accountId,
		displayName: status.displayName ?? status.accountId,
		email: status.email,
		subscription: {
			plan: status.plan,
			status: status.loggedIn ? "active" : null,
			expiresAt: null
		},
		refresh: {
			accessTokenExpiresAt: null,
			nextRefreshAt: null,
			lastRefreshedAt: null,
			refreshable: false
		},
		credentialRef,
		resources: officialSessionResources({
			sourceKind,
			authSource: source
		}),
		imported,
		status: status.loggedIn ? "available" : "degraded",
		diagnostic: status.loggedIn ? null : "Cursor 官方会话当前未返回已登录状态"
	};
	Object.defineProperty(candidate, CREDENTIAL_SLOT, {
		value: credential ?? {
			type: "official_session",
			providerId: PROVIDER_ID,
			accountId: status.accountId,
			sourceKind
		},
		enumerable: false
	});
	return candidate;
}
async function resolveCursorBrowserEmail(raw, access, { fetchImpl = null, apiBaseUrl = "https://api2.cursor.sh", home = homedir(), signal } = {}) {
	const payload = decodeJwtPayload(access) ?? {};
	const direct = firstString(raw?.email, raw?.user?.email, raw?.profile?.email, payload.email, payload.user_email, payload.email_address, payload["https://cursor.com/email"]);
	if (direct) return direct;
	try {
		const desktop = readCursorDesktopSession({ home });
		if (desktop?.email) return desktop.email;
	} catch {}
	if (typeof fetchImpl !== "function") return null;
	try {
		const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/aiserver.v1.AuthService/GetEmail`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${access}`
			},
			body: "{}",
			...signal ? { signal } : {}
		});
		if (!response.ok) return null;
		const body = await response.json().catch(() => ({}));
		return firstString(body?.email, body?.user?.email, body?.profile?.email);
	} catch {
		return null;
	}
}
async function candidateFromBrowserTokens(raw, options = {}) {
	const access = firstString(raw?.accessToken, raw?.access_token);
	const refresh = firstString(raw?.refreshToken, raw?.refresh_token);
	if (!access || !refresh) throw new Error("Cursor browser login did not return access and refresh tokens");
	const payload = decodeJwtPayload(access) ?? {};
	const expiresAt = cursorTokenExpiresAt(raw, payload);
	const email = await resolveCursorBrowserEmail(raw, access, options);
	const accountId = firstString(raw.accountId, raw.account_id, raw.userId, raw.user_id, payload.sub, payload.user_id, email) ?? `cursor:${hash(access).slice(0, 20)}`;
	const candidate = candidateFromStatus({
		loggedIn: true,
		accountId,
		email,
		plan: firstString(raw.plan, raw.subscription?.plan, raw.membershipType, payload.plan),
		displayName: firstString(raw.name, raw.user?.name, email, accountId)
	}, {
		source: "official_cursor_browser_oauth",
		sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER,
		credential: {
			type: "oauth",
			providerId: PROVIDER_ID,
			accountId,
			access,
			refresh,
			...expiresAt ? { expiresAt } : {},
			email,
			sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER
		}
	});
	candidate.refresh = {
		...candidate.refresh,
		accessTokenExpiresAt: expiresAt,
		refreshable: true
	};
	return candidate;
}
function desktopSessionAccountId(session) {
	return session.email ? `cursor:${hash(session.email.toLowerCase()).slice(0, 20)}` : "cursor:desktop";
}
function statusFromDesktopSession(session) {
	return {
		source: "cursor_desktop_app",
		sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP,
		loggedIn: true,
		accountId: session.accountId,
		email: session.email,
		plan: session.plan,
		displayName: session.email ?? "Cursor desktop session",
		models: [],
		raw: {
			source: "cursor_desktop_app",
			loggedIn: true,
			email: session.email,
			plan: session.plan
		}
	};
}
function candidateFromDesktopSession(session) {
	const accountId = session.accountId ?? desktopSessionAccountId(session);
	const candidate = {
		candidateId: `cursor:desktop:${hash(accountId).slice(0, 20)}`,
		providerId: PROVIDER_ID,
		source: "cursor_desktop_app",
		accountId,
		displayName: session.email ?? "Cursor desktop session",
		email: session.email,
		subscription: {
			plan: session.plan,
			status: "active",
			expiresAt: null
		},
		refresh: {
			accessTokenExpiresAt: null,
			nextRefreshAt: null,
			lastRefreshedAt: null,
			refreshable: Boolean(session.refreshToken)
		},
		credentialRef: createCredentialRef(PROVIDER_ID, accountId),
		imported: false,
		status: "available",
		diagnostic: null,
		resources: {
			...officialSessionResources({
				sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP,
				authSource: "cursor_desktop_app"
			}),
			transport: "cursor_connect_agent_service",
			identitySource: "cursor_desktop_app",
			sessionPersistence: "captured",
			quotaSource: "cursor_desktop_app"
		}
	};
	Object.defineProperty(candidate, CREDENTIAL_SLOT, {
		value: {
			type: OFFICIAL_SESSION_AUTH_KIND,
			providerId: PROVIDER_ID,
			accountId,
			access: session.token,
			...session.refreshToken ? { refresh: session.refreshToken } : {}
		},
		enumerable: false
	});
	return candidate;
}
function summarizeCursorCandidate(candidate) {
	return {
		providerId: PROVIDER_ID,
		candidateId: candidate.candidateId,
		source: candidate.source,
		accountId: candidate.accountId,
		displayName: candidate.displayName,
		email: candidate.email,
		subscription: { ...candidate.subscription },
		refresh: { ...candidate.refresh },
		imported: Boolean(candidate.imported),
		status: candidate.status ?? "available",
		diagnostic: candidate.diagnostic ?? null
	};
}
function normalizeModel(value) {
	if (typeof value === "string") return {
		id: value,
		name: value
	};
	if (!value || typeof value !== "object") return null;
	const id = firstString(value.id, value.model, value.modelId, value.name);
	if (!id) return null;
	const contextWindow = value.contextWindow ?? value.context_window ?? value.contextTokenLimit ?? value.context_token_limit;
	const maxTokens = value.maxTokens ?? value.max_tokens ?? value.maxOutputTokens ?? value.max_output_tokens;
	const inputModalities = value.input ?? value.inputModalities ?? value.input_modalities ?? (value.supportsImages || value.supports_images ? ["text", "image"] : null);
	return {
		id,
		name: firstString(value.clientDisplayName, value.client_display_name, value.displayName, value.display_name, value.name, value.label, id),
		...Number.isInteger(contextWindow) ? { contextWindow } : {},
		...Number.isInteger(maxTokens) ? { maxTokens } : {},
		...Array.isArray(inputModalities) ? { inputModalities: [...inputModalities] } : {},
		...value.reasoning ? { reasoning: value.reasoning } : {},
		...value.supportsThinking || value.supports_thinking ? { reasoning: { supported: true } } : {}
	};
}
function createCursorCatalogLoader({ cliPath = process.env.DOCKYARD_CURSOR_CLI || "cursor-agent", env = process.env, commandRunner = runCliCommand, apiBaseUrl = process.env.CURSOR_API_BASE_URL || "https://api2.cursor.sh", fetchImpl = fetch } = {}) {
	let cached = null;
	let pending = null;
	const normalizedApiBaseUrl = validateCursorOrigin(apiBaseUrl, "API base");
	async function loadBrowserCatalog({ accounts, secretStore, signal }) {
		const account = (Array.isArray(accounts) ? accounts : []).find((entry) => entry?.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER || entry?.resources?.authSource === "official_cursor_browser_oauth");
		const credentialRef = account?.auth?.credentialRef ?? account?.credentialRef;
		if (!account || !credentialRef || typeof secretStore?.read !== "function") return null;
		const credential = await secretStore.read(credentialRef);
		if (!credential?.access) return null;
		const response = await fetchImpl(`${normalizedApiBaseUrl}/aiserver.v1.AiService/AvailableModels`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${credential.access}`
			},
			body: JSON.stringify({
				isNightly: false,
				excludeMaxNamedModels: true,
				additionalModelNames: [],
				useModelParameters: true,
				useReactModelPicker: true
			}),
			...signal ? { signal } : {}
		});
		if (!response.ok) return null;
		const body = await response.json().catch(() => ({}));
		const values = Array.isArray(body?.models) ? body.models : body?.modelNames ?? body?.model_names;
		const models = (Array.isArray(values) ? values : []).map(normalizeModel).filter(Boolean);
		if (models.length === 0) return null;
		return {
			models,
			source: "official_cursor_browser_oauth_api"
		};
	}
	return async function loadCatalog({ force = false, accounts = [], secretStore, signal } = {}) {
		const hasBrowserAccount = (Array.isArray(accounts) ? accounts : []).some((entry) => entry?.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER || entry?.resources?.authSource === "official_cursor_browser_oauth");
		if (!force && cached && (hasBrowserAccount ? cached.source === "official_cursor_browser_oauth_api" : cached.source !== "official_cursor_browser_oauth_api")) return cached;
		if (pending) return pending;
		pending = (async () => {
			try {
				const browser = await loadBrowserCatalog({
					accounts,
					secretStore,
					signal
				});
				if (browser) {
					cached = browser;
					return cached;
				}
			} catch {}
			try {
				const models = parseCursorAuthStatus((await commandRunner(cliPath, ["status"], {
					env,
					providerId: PROVIDER_ID,
					timeoutMs: 3e4,
					...signal ? { signal } : {}
				})).output).models.map(normalizeModel).filter(Boolean);
				const catalog = {
					models,
					source: "official_cursor_cli_status",
					...models.length ? {} : { diagnostics: ["Cursor 官方 status 没有返回模型目录"] }
				};
				cached = models.length ? catalog : null;
				return catalog;
			} catch (error) {
				const desktop = readCursorDesktopSession({ env });
				const catalog = {
					models: [],
					source: error?.code === "ENOENT" ? desktop ? "cursor_desktop_app" : "cursor_cli_not_found" : "official_cursor_cli_status",
					diagnostics: [desktop ? "已检测到 Cursor 官方 OAuth；官方模型目录请求未返回结果" : `无法读取 Cursor 官方模型目录：${error.message}`]
				};
				cached = null;
				return catalog;
			}
		})().finally(() => {
			pending = null;
		});
		return pending;
	};
}
var CursorSubscriptionDriver = class {
	constructor({ cliPath = process.env.DOCKYARD_CURSOR_CLI || "cursor-agent", env = process.env, home = homedir(), commandRunner = runCliCommand, requestExecutor = null, catalogLoader = null, sessionReader = null, sessionSource = "official_cursor_client", sessionSourceKind = OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP, oauthAuthorizer = null, browserAuthorizer = null, browserOAuth = env.DOCKYARD_CURSOR_BROWSER_OAUTH !== "0", websiteUrl = env.CURSOR_WEBSITE_URL || "https://cursor.com", apiBaseUrl = env.CURSOR_API_BASE_URL || "https://api2.cursor.sh", refreshUrl = env.CURSOR_REFRESH_URL || `${apiBaseUrl}/auth/exchange_user_api_key`, fetchImpl = fetch, allowDesktopSessionImport = false } = {}) {
		this.cliPath = cliPath;
		this.env = env;
		this.home = home;
		this.commandRunner = commandRunner;
		this.requestExecutor = requestExecutor;
		this.fetchImpl = fetchImpl;
		this.allowDesktopSessionImport = allowDesktopSessionImport === true;
		this.websiteUrl = validateCursorOrigin(websiteUrl, "website");
		this.apiBaseUrl = validateCursorOrigin(apiBaseUrl, "API base");
		const refreshEndpoint = validateCursorUrl(refreshUrl, "OAuth refresh", this.apiBaseUrl);
		this.refreshUrl = refreshEndpoint.toString().replace(/\/$/, "");
		this.sessionReader = sessionReader;
		this.sessionSource = sessionSource;
		this.sessionSourceKind = sessionSourceKind;
		this.catalogLoader = catalogLoader ?? createCursorCatalogLoader({
			cliPath,
			env,
			commandRunner,
			apiBaseUrl: this.apiBaseUrl,
			fetchImpl: this.fetchImpl
		});
		this.clientSessionAuthorizer = createOfficialSessionAuthorizer({
			providerId: PROVIDER_ID,
			source: sessionSource,
			instructions: "请在 Cursor 官方客户端完成登录，完成后回到 Dockyard DSH。",
			readSession: async (context = {}) => {
				const status = this.sessionReader ? await this.#readStatus(context.signal) : (() => {
					const desktop = this.#readDesktopSession();
					return desktop ? statusFromDesktopSession(desktop) : null;
				})();
				if (!status?.loggedIn) return { accounts: [] };
				const desktop = status.source === "cursor_desktop_app" ? this.#readDesktopSession() : null;
				const candidate = desktop ? candidateFromDesktopSession(desktop) : candidateFromStatus(status, {
					source: status.source,
					sourceKind: status.sourceKind
				});
				return { accounts: [await this.importAccount(candidate, context)] };
			}
		});
		this.cliAuthorizer = createCliStatusAuthorizer({
			providerId: PROVIDER_ID,
			cliPath,
			loginArgs: ["login"],
			environment: env,
			browserOpened: true,
			instructions: "已启动官方 Cursor CLI OAuth 登录。请在 Cursor 官方网页完成登录，完成后回到 Dockyard DSH。",
			importStatus: async (context) => {
				const status = await this.#readStatus();
				if (!status.loggedIn) return [];
				return [await this.importAccount(candidateFromStatus(status, {
					source: status.source,
					sourceKind: status.sourceKind
				}), context)];
			}
		});
		this.browserAuthorizer = browserAuthorizer ?? (browserOAuth ? createBrowserOAuthAuthorizer({
			providerId: PROVIDER_ID,
			instructions: "请在官方 Cursor 授权页面选择账号并完成授权；完成后会自动返回 Dockyard DSH。",
			authorizationUrlBuilder: async () => {
				const verifier = randomBytes(32).toString("base64url");
				const challenge = createHash("sha256").update(verifier).digest("base64url");
				const uuid = randomUUID();
				return {
					url: `${this.websiteUrl}/loginDeepControl?${new URLSearchParams({
						challenge,
						uuid,
						mode: "login",
						redirectTarget: "cli"
					})}`,
					metadata: {
						uuid,
						verifier
					}
				};
			},
			pollSession: async ({ metadata, context }) => {
				if (!metadata?.uuid || !metadata.verifier) return null;
				const response = await this.fetchImpl(`${this.apiBaseUrl}/auth/poll?${new URLSearchParams({
					uuid: metadata.uuid,
					verifier: metadata.verifier
				})}`, {
					headers: { "content-type": "application/json" },
					...context.signal ? { signal: context.signal } : {}
				});
				if (response.status === 404) return null;
				const body = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error(`Cursor browser OAuth polling failed (${response.status})`);
				return body?.accessToken && body?.refreshToken ? body : null;
			},
			importCredentials: async (raw, context) => [await this.importAccount(await candidateFromBrowserTokens(raw, {
				fetchImpl: this.fetchImpl,
				apiBaseUrl: this.apiBaseUrl,
				home: this.home,
				signal: context.signal
			}), context)]
		}) : null);
		this.oauthAuthorizer = oauthAuthorizer ?? this.browserAuthorizer ?? this.cliAuthorizer;
	}
	#readDesktopSession() {
		const session = readCursorDesktopSession({
			env: this.env,
			home: this.home,
			allowDesktopSession: this.allowDesktopSessionImport
		});
		if (!session?.token || session.source !== "cursor_desktop_app") return null;
		return {
			...session,
			accountId: desktopSessionAccountId(session)
		};
	}
	#statusFromResult(result, defaults = {}) {
		const normalized = normalizeOfficialSessionResult(result, {
			source: defaults.source ?? "official_cursor_cli",
			sourceKind: defaults.sourceKind ?? OFFICIAL_SESSION_SOURCE_KINDS.CLI
		});
		return {
			...parseCursorAuthStatus(normalized?.output ?? ""),
			source: normalized?.source ?? defaults.source ?? "official_cursor_cli",
			sourceKind: normalized?.sourceKind ?? defaults.sourceKind ?? OFFICIAL_SESSION_SOURCE_KINDS.CLI
		};
	}
	async #readStatus(signal) {
		if (typeof this.sessionReader === "function") try {
			const normalized = normalizeOfficialSessionResult(await this.sessionReader({
				env: this.env,
				home: this.home,
				signal
			}), {
				source: this.sessionSource,
				sourceKind: this.sessionSourceKind
			});
			if (normalized) return this.#statusFromResult(normalized, {
				source: this.sessionSource,
				sourceKind: this.sessionSourceKind
			});
		} catch {}
		try {
			const result = await this.commandRunner(this.cliPath, ["status"], {
				env: this.env,
				providerId: PROVIDER_ID,
				timeoutMs: 3e4,
				...signal ? { signal } : {}
			});
			const status = this.#statusFromResult(result, {
				source: "official_cursor_cli",
				sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.CLI
			});
			if (status.loggedIn) return status;
			const desktop = this.#readDesktopSession();
			return desktop ? statusFromDesktopSession(desktop) : status;
		} catch (error) {
			const desktop = this.#readDesktopSession();
			if (desktop) return statusFromDesktopSession(desktop);
			throw error;
		}
	}
	#isBrowserAccount(account) {
		return account?.resources?.authSource === "official_cursor_browser_oauth";
	}
	async #refreshBrowserCredential(account, context = {}) {
		const credentialRef = account?.auth?.credentialRef ?? account?.credentialRef;
		const credential = context.secretStore && credentialRef ? await context.secretStore.read(credentialRef) : null;
		if (!credential?.access) throw activeSessionError("Cursor browser OAuth credential is missing; authorize again");
		const expiresAt = cursorTokenExpiresAt(credential, decodeJwtPayload(credential.access) ?? {});
		const now = context.now instanceof Date ? context.now.getTime() : Date.now();
		if (!tokenNeedsRefresh(expiresAt, now)) return credential;
		if (!credential.refresh) throw activeSessionError("Cursor browser OAuth token expired; authorize again");
		let response;
		try {
			response = await this.fetchImpl(this.refreshUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${credential.refresh}`,
					"content-type": "application/json",
					accept: "application/json"
				},
				body: "{}",
				...context.signal ? { signal: context.signal } : {}
			});
		} catch (error) {
			const wrapped = activeSessionError("Cursor browser OAuth access token expired and refresh failed; authorize again");
			wrapped.cause = error;
			throw wrapped;
		}
		const body = await response.json().catch(() => ({}));
		const access = firstString(body?.accessToken, body?.access_token);
		if (!response.ok || !access) {
			const error = activeSessionError("Cursor browser OAuth access token expired and refresh failed; authorize again");
			error.status = response.status;
			throw error;
		}
		const refresh = firstString(body?.refreshToken, body?.refresh_token, credential.refresh);
		const refreshedExpiresAt = cursorTokenExpiresAt({
			expiresAt: body?.expiresAt ?? body?.expires_at,
			expiresIn: body?.expiresIn ?? body?.expires_in
		}, decodeJwtPayload(access) ?? {});
		const updated = {
			...credential,
			access,
			refresh,
			...refreshedExpiresAt ? { expiresAt: refreshedExpiresAt } : {},
			lastRefreshedAt: new Date(now).toISOString()
		};
		await context.secretStore.write(credentialRef, updated);
		return updated;
	}
	async #browserStatus(account, context = {}) {
		const credential = await this.#refreshBrowserCredential(account, context);
		if (tokenIsExpired(cursorTokenExpiresAt(credential, decodeJwtPayload(credential.access) ?? {}))) throw activeSessionError("Cursor browser OAuth access token expired; authorize again");
		const email = account.email ?? await resolveCursorBrowserEmail({}, credential.access, {
			fetchImpl: this.fetchImpl,
			apiBaseUrl: this.apiBaseUrl,
			home: this.home,
			signal: context.signal
		});
		return {
			loggedIn: true,
			accountId: account.accountId,
			email,
			displayName: email ?? account.displayName,
			plan: account.subscription?.plan ?? null,
			credential,
			raw: {}
		};
	}
	async #assertActiveSession(account, signal, context = {}) {
		if (this.#isBrowserAccount(account)) return this.#browserStatus(account, context);
		const status = await this.#readStatus(signal);
		if (!status.loggedIn) throw activeSessionError("Cursor OAuth session is not active; authorize again");
		if (account?.accountId !== status.accountId && account?.accountId !== "cursor:active") throw activeSessionError("Cursor only exposes its active official session; authorize the selected account again", { mismatch: true });
		return status;
	}
	async discover() {
		try {
			const status = await this.#readStatus();
			const source = status.source ?? "official_cursor_cli";
			if (!status.loggedIn) return {
				candidates: [],
				source,
				diagnostics: ["Cursor 官方环境当前未登录"]
			};
			const desktop = source === "cursor_desktop_app" ? this.#readDesktopSession() : null;
			const candidate = desktop ? candidateFromDesktopSession(desktop) : candidateFromStatus(status, {
				source,
				sourceKind: status.sourceKind
			});
			return {
				candidates: candidate ? [candidate] : [],
				source,
				diagnostics: []
			};
		} catch (error) {
			return {
				candidates: [],
				source: "official_cursor_cli",
				diagnostics: [`无法读取 Cursor 官方登录态：${error.message}`]
			};
		}
	}
	async importAccount(candidate, context = {}) {
		const session = candidate?.[CREDENTIAL_SLOT];
		if (!session) throw new Error("Cursor candidate is no longer available; scan again");
		if (!context.secretStore) throw new Error("A secure credential store is required");
		await context.secretStore.write(candidate.credentialRef, session);
		return {
			providerId: PROVIDER_ID,
			accountId: candidate.accountId,
			credentialRef: candidate.credentialRef,
			displayName: candidate.displayName,
			email: candidate.email,
			auth: {
				kind: OFFICIAL_SESSION_AUTH_KIND,
				scopes: []
			},
			subscription: { ...candidate.subscription },
			refresh: { ...candidate.refresh },
			resources: {
				...officialSessionResources({
					sourceKind: candidate.resources?.sessionSource ?? (candidate.source === "cursor_desktop_app" ? OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP : OFFICIAL_SESSION_SOURCE_KINDS.CLI),
					authSource: candidate.source
				}),
				transport: "cursor_agentservice_connect_proto",
				quotaSource: candidate.resources?.quotaSource ?? "official_cursor_cli_status",
				...candidate.resources ?? {}
			}
		};
	}
	async getActiveSession(context = {}) {
		try {
			const status = await this.#readStatus(context.signal);
			if (!status.loggedIn) return null;
			const desktop = status.source === "cursor_desktop_app" ? this.#readDesktopSession() : null;
			const candidate = desktop ? candidateFromDesktopSession(desktop) : candidateFromStatus(status, {
				source: status.source,
				sourceKind: status.sourceKind
			});
			const account = await this.importAccount(candidate, context);
			return {
				status: "completed",
				providerId: PROVIDER_ID,
				instructions: "已检测到 Cursor 官方会话，当前账号已接入 Dockyard DSH。",
				accounts: [account],
				diagnostic: null
			};
		} catch {
			return null;
		}
	}
	async dispose() {
		const authorizers = /* @__PURE__ */ new Set([
			this.oauthAuthorizer,
			this.browserAuthorizer,
			this.cliAuthorizer,
			this.clientSessionAuthorizer
		]);
		await Promise.all([...authorizers].filter(Boolean).map((authorizer) => authorizer.dispose?.()));
	}
	async startAuthorization(context = {}) {
		if (this.oauthAuthorizer !== this.browserAuthorizer || !this.browserAuthorizer) return this.oauthAuthorizer.begin(context);
		const started = await this.browserAuthorizer.begin(context);
		if (started.status === "failed") return this.cliAuthorizer.begin(context);
		return started;
	}
	async pollAuthorization(sessionId, context = {}) {
		return (sessionId?.includes(":official-session:") ? this.clientSessionAuthorizer : sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer).poll(sessionId, context);
	}
	async cancelAuthorization(sessionId, context = {}) {
		return (sessionId?.includes(":official-session:") ? this.clientSessionAuthorizer : sessionId?.includes(":browser:") ? this.browserAuthorizer : this.oauthAuthorizer === this.browserAuthorizer ? this.cliAuthorizer : this.oauthAuthorizer).cancel(sessionId, context);
	}
	async refreshAccount(account, context = {}) {
		const status = await this.#assertActiveSession(account, context.signal, context);
		return {
			identity: {
				email: status.email,
				displayName: status.displayName
			},
			subscription: {
				plan: status.plan,
				status: "active",
				expiresAt: null
			},
			refresh: {
				accessTokenExpiresAt: this.#isBrowserAccount(account) ? cursorTokenExpiresAt(status.credential, decodeJwtPayload(status.credential?.access ?? "") ?? {}) : account.refresh?.accessTokenExpiresAt ?? null,
				lastRefreshedAt: (context.now instanceof Date ? context.now : /* @__PURE__ */ new Date()).toISOString(),
				refreshable: this.#isBrowserAccount(account) ? Boolean(status.credential?.refresh) : false
			}
		};
	}
	async getQuota(account, context = {}) {
		const status = await this.#assertActiveSession(account, context.signal, context);
		const now = context.now instanceof Date ? context.now : /* @__PURE__ */ new Date();
		const quotaSource = this.#isBrowserAccount(account) ? "official_cursor_browser_oauth" : "cursor_cli_status";
		const windows = recursiveQuotaWindows(status.raw, {
			source: quotaSource,
			now,
			prefix: "cursor"
		});
		const primary = selectPrimaryQuotaWindow(windows);
		return {
			quota: {
				remaining: primary.remaining ?? null,
				limit: primary.limit ?? null,
				unit: primary.unit ?? null,
				resetAt: primary.resetAt ?? null,
				windows,
				updatedAt: now.toISOString(),
				source: quotaSource
			},
			subscription: {
				plan: status.plan,
				status: status.loggedIn ? "active" : null,
				expiresAt: null
			},
			resources: { quotaDiagnostic: windows.length ? null : this.#isBrowserAccount(account) ? "Cursor 官方浏览器会话未返回实时订阅额度；详细 usage 仍以 Cursor 官方 Dashboard 为准" : "Cursor 官方 CLI status 未返回实时订阅额度；详细 usage 仍以 Cursor 官方 Dashboard 为准" }
		};
	}
	async getCatalog(context = {}) {
		return this.catalogLoader({
			force: Boolean(context.force),
			accounts: context.accounts,
			secretStore: context.secretStore,
			signal: context.signal
		});
	}
	async invoke(request, invocation, context = {}) {
		await this.#assertActiveSession(invocation?.account, context.signal, context);
		const executor = context.requestExecutor ?? this.requestExecutor;
		if (typeof executor !== "function") throw new Error("Cursor native invocation transport is not mounted");
		return executor({
			request,
			invocation,
			context
		});
	}
	async stream(request, invocation, context = {}) {
		return this.invoke(request, invocation, context);
	}
};
function createCursorDriver(options = {}) {
	return new CursorSubscriptionDriver(options);
}
Object.freeze({ providerId: PROVIDER_ID });
//#endregion
//#region vendor/dockyard/modules/provider-cursor/src/index.mjs
function createCursorModule({ driver = {} } = {}) {
	return defineProviderModule({
		id: "cursor",
		displayName: "Cursor",
		capabilities: [
			"oauth_discovery",
			"oauth_import",
			"oauth_authorization",
			"oauth_refresh",
			"quota",
			"catalog",
			"invoke",
			"stream"
		],
		driver
	});
}
//#endregion
//#region vendor/dockyard/packages/runtime/src/dockyard-runtime.mjs
const candidateSummarizers = /* @__PURE__ */ new Map([
	["antigravity", summarizeAntigravityCandidate],
	["grok", summarizeGrokCandidate],
	["claude", summarizeClaudeCandidate],
	["cursor", summarizeCursorCandidate]
]);
const DEFAULT_REFRESH_TIMEOUT_MS = 15e3;
function numericOption(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function refreshTimeoutError(providerId, accountId, timeoutMs) {
	const error = /* @__PURE__ */ new Error(`刷新 ${providerId}/${accountId} 超时（${Math.ceil(timeoutMs / 1e3)} 秒）；已保留上次额度`);
	error.code = "ETIMEDOUT";
	error.refreshTimeout = true;
	error.timeoutMs = timeoutMs;
	return error;
}
/**
* A successful quota refresh proves the credential works but must not erase a
* confirmed exhausted/cooldown state: an account whose live quota reports
* zero remaining would otherwise be re-selected and fail again immediately.
*/
function reportPostRefreshHealth(pool, accountId) {
	const account = pool.get(accountId);
	if (!account || account.health?.status === ACCOUNT_HEALTH.EXPIRED) return;
	const remaining = account.quota?.remaining;
	if (typeof remaining === "number" && remaining <= 0) {
		pool.report(accountId, {
			status: "quota_exhausted",
			message: "刷新后官方额度仍为 0，请切换账号或稍后重试"
		});
		return;
	}
	pool.report(accountId, { status: "success" });
}
function withRefreshTimeout(task, { providerId, accountId, timeoutMs }) {
	const controller = new AbortController();
	let timer = null;
	const operation = Promise.resolve().then(() => task(controller.signal));
	operation.catch(() => {});
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(refreshTimeoutError(providerId, accountId, timeoutMs));
		}, timeoutMs);
	});
	return Promise.race([operation, deadline]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
function withRequestExecutor(providerId, driverOptions, requestExecutors = {}) {
	const executor = requestExecutors[providerId];
	return executor ? {
		...driverOptions ?? {},
		requestExecutor: executor
	} : driverOptions;
}
function createDefaultProviderEntries(options = {}) {
	const requestExecutors = options.requestExecutors ?? {};
	const catalogLoaders = options.catalogLoaders ?? {};
	return [
		{
			module: createAntigravityModule({ driver: options.antigravityDriver ?? createAntigravityDriver({
				...withRequestExecutor("antigravity", options.antigravity, requestExecutors),
				...catalogLoaders.antigravity ? { catalogLoader: catalogLoaders.antigravity } : {}
			}) }),
			driver: options.antigravityDriver
		},
		{
			module: createGrokModule({ driver: options.grokDriver ?? createGrokDriver({
				...withRequestExecutor("grok", options.grok, requestExecutors),
				...catalogLoaders.grok ? { catalogLoader: catalogLoaders.grok } : {}
			}) }),
			driver: options.grokDriver
		},
		{
			module: createClaudeModule({ driver: options.claudeDriver ?? createClaudeDriver({
				...withRequestExecutor("claude", options.claude, requestExecutors),
				...catalogLoaders.claude ? { catalogLoader: catalogLoaders.claude } : {}
			}) }),
			driver: options.claudeDriver
		},
		{
			module: createCursorModule({ driver: options.cursorDriver ?? createCursorDriver({
				...withRequestExecutor("cursor", options.cursor, requestExecutors),
				...catalogLoaders.cursor ? { catalogLoader: catalogLoaders.cursor } : {}
			}) }),
			driver: options.cursorDriver
		}
	];
}
function providerContext(app, extra = {}) {
	return {
		secretStore: app.secretStore,
		now: /* @__PURE__ */ new Date(),
		...extra
	};
}
function providerAccount(pool, accountId) {
	const account = pool.get(accountId);
	if (!account) throw new Error(`Account does not exist: ${accountId}`);
	const auth = pool.resolve(accountId);
	return {
		...account,
		auth: {
			kind: auth.authKind,
			credentialRef: auth.credentialRef,
			scopes: [...auth.scopes]
		}
	};
}
function providerErrorStatus(error) {
	if (error?.quotaUnavailable) return "error";
	if (error?.authExpired || error?.accountMismatch) return "auth_expired";
	if (error?.authForbidden) return "error";
	if (error?.quotaExhausted) return "quota_exhausted";
	if (error?.rateLimited) return "rate_limited";
	return "error";
}
var DockyardRuntime = class {
	#entries = /* @__PURE__ */ new Map();
	#candidates = /* @__PURE__ */ new Map();
	#refreshPromises = /* @__PURE__ */ new Map();
	#accountRefreshPromises = /* @__PURE__ */ new Map();
	#saveQueue = Promise.resolve();
	#initialized = false;
	#initPromise = null;
	constructor({ providers = createDefaultProviderEntries(), runtime = new ModuleRuntime({ logger: {
		error() {},
		warn() {},
		info() {}
	} }), stateStore = new JsonStateStore(), secretStore = createDefaultSecretStore(), dshAdapter = null, refreshTimeoutMs = numericOption(process.env.DOCKYARD_DSH_REFRESH_TIMEOUT_MS, DEFAULT_REFRESH_TIMEOUT_MS) } = {}) {
		this.runtime = runtime;
		this.stateStore = stateStore;
		this.secretStore = secretStore;
		this.bridge = new DshInjectionBridge({
			runtime,
			adapter: dshAdapter
		});
		this.providers = providers;
		this.refreshTimeoutMs = refreshTimeoutMs;
	}
	setSecretStore(secretStore) {
		if (!secretStore || typeof secretStore.read !== "function" || typeof secretStore.write !== "function") throw new TypeError("Dockyard secret store requires read() and write() methods");
		this.secretStore = secretStore;
		return this;
	}
	async dispose() {
		const modules = [...this.#entries.values()].map((entry) => entry.module);
		await Promise.all(modules.map((module) => module.dispose?.()));
	}
	async init() {
		if (this.#initialized) return this;
		if (this.#initPromise) return this.#initPromise;
		this.#initPromise = (async () => {
			const state = await this.stateStore.load();
			const stagedEntries = /* @__PURE__ */ new Map();
			const registered = [];
			const mounted = [];
			try {
				for (const entry of this.providers) {
					const providerId = entry.module.manifest.id;
					const stored = state.pools?.[providerId] ?? {};
					const pool = new AccountPool({
						providerId,
						policy: stored.policy ?? ACCOUNT_SELECTION_POLICY.ROUND_ROBIN
					});
					for (const account of Array.isArray(stored.accounts) ? stored.accounts : []) if (account?.auth?.credentialRef) pool.upsert({
						...account,
						credentialRef: account.auth.credentialRef
					});
					if (stored.defaultAccountId && pool.get(stored.defaultAccountId)) pool.setDefaultAccount(stored.defaultAccountId);
					stagedEntries.set(providerId, {
						...entry,
						pool
					});
					if (!this.runtime.has(providerId)) {
						await this.runtime.register(entry.module);
						registered.push(providerId);
					}
					await this.bridge.mountProvider(entry.module, pool);
					mounted.push(providerId);
				}
				this.#entries = stagedEntries;
				this.#initialized = true;
				return this;
			} catch (error) {
				for (const providerId of mounted.reverse()) await this.bridge.unmountProvider(providerId).catch(() => {});
				for (const providerId of registered.reverse()) await this.runtime.unregister(providerId).catch(() => {});
				this.#entries.clear();
				throw error;
			}
		})();
		try {
			return await this.#initPromise;
		} finally {
			this.#initPromise = null;
		}
	}
	#entry(providerId) {
		const entry = this.#entries.get(providerId);
		if (!entry) throw new Error(`Unknown Dockyard provider: ${providerId}`);
		return entry;
	}
	listProviderManifests() {
		return this.providers.map(({ module }) => ({ ...module.manifest }));
	}
	listProviderIds() {
		return this.providers.map(({ module }) => module.manifest.id);
	}
	async scan(providerId = null) {
		await this.init();
		const entries = providerId ? [[providerId, this.#entry(providerId)]] : [...this.#entries];
		const providers = [];
		const changedProviderIds = /* @__PURE__ */ new Set();
		for (const [currentProviderId, entry] of entries) {
			let result;
			try {
				result = await entry.module.discover(providerContext(this, { accounts: entry.pool.list() }));
			} catch (error) {
				result = {
					candidates: [],
					source: "provider",
					diagnostics: [redactError(error)]
				};
			}
			const rawCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
			this.#candidates.set(currentProviderId, new Map(rawCandidates.map((candidate) => [candidate.candidateId, candidate])));
			for (const candidate of rawCandidates) {
				const existing = entry.pool.get(candidate.accountId);
				const candidateIdentity = candidate.resources ?? {};
				const existingIdentity = existing?.resources ?? {};
				if (!existing) continue;
				if (candidate.email !== existing.email || candidate.displayName !== existing.displayName || candidateIdentity.identitySource !== existingIdentity.identitySource || candidateIdentity.identityLabel !== existingIdentity.identityLabel || candidateIdentity.sessionFingerprint !== existingIdentity.sessionFingerprint || candidateIdentity.identityNote !== existingIdentity.identityNote || candidateIdentity.sessionPersistence !== existingIdentity.sessionPersistence) {
					entry.pool.upsert({
						accountId: candidate.accountId,
						...candidate.email !== void 0 ? { email: candidate.email } : {},
						...candidate.displayName !== void 0 ? { displayName: candidate.displayName } : {},
						...candidate.resources ? { resources: candidate.resources } : {}
					}, { resetHealth: currentProviderId === "antigravity" && candidate.resources?.sessionPersistence === "active" });
					changedProviderIds.add(currentProviderId);
				}
				if (candidate.resources?.sessionPersistence === "captured" && candidate.resources.sessionFingerprint && candidate.resources.sessionFingerprint !== existing.resources?.sessionFingerprint && typeof entry.module.importAccount === "function") try {
					const captured = await entry.module.importAccount(candidate, providerContext(this));
					entry.pool.upsert(captured, { resetHealth: true });
					changedProviderIds.add(currentProviderId);
				} catch {}
				if (currentProviderId === "grok" && typeof entry.module.importAccount === "function" && (candidate.email && !existing.email || candidate.source && candidate.source !== existingIdentity.authSource)) try {
					const repaired = await entry.module.importAccount(candidate, providerContext(this));
					entry.pool.upsert(repaired, { resetHealth: true });
					changedProviderIds.add(currentProviderId);
				} catch {}
			}
			const summarize = candidateSummarizers.get(currentProviderId) ?? ((candidate) => ({ ...candidate }));
			const candidates = rawCandidates.map((candidate) => ({
				...summarize(candidate),
				imported: Boolean(entry.pool.get(candidate.accountId))
			}));
			providers.push({
				providerId: currentProviderId,
				manifest: { ...entry.module.manifest },
				policy: entry.pool.policy,
				accounts: entry.pool.list(),
				candidates,
				source: result?.source ?? "unknown",
				diagnostics: result?.diagnostics ?? []
			});
		}
		if (changedProviderIds.size > 0) await this.#saveState(changedProviderIds);
		return {
			generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			providers,
			routes: this.bridge.listRoutes()
		};
	}
	async importCandidate(providerId, candidateId) {
		await this.init();
		const entry = this.#entry(providerId);
		const candidate = this.#candidates.get(providerId)?.get(candidateId);
		if (!candidate) throw new Error("Candidate is missing; scan local OAuth states again");
		const rawAccount = await entry.module.importAccount(candidate, providerContext(this));
		entry.pool.upsert(rawAccount, { resetHealth: true });
		await this.#saveState([providerId]);
		return {
			account: entry.pool.get(rawAccount.accountId),
			diagnostics: [],
			needsRefresh: true
		};
	}
	async importSource(providerId, source) {
		await this.init();
		const entry = this.#entry(providerId);
		if (typeof entry.module.importSource !== "function") throw new Error(`Provider ${providerId} does not support OAuth source import`);
		const imported = await entry.module.importSource(source, providerContext(this));
		const accounts = (Array.isArray(imported) ? imported : Array.isArray(imported?.accounts) ? imported.accounts : [imported]).filter((account) => account?.accountId).map((account) => {
			entry.pool.upsert(account, { resetHealth: true });
			return entry.pool.get(account.accountId);
		});
		if (accounts.length === 0) throw new Error("OAuth source did not contain an importable account");
		await this.#saveState([providerId]);
		return {
			accounts,
			diagnostics: []
		};
	}
	async startAuthorization(providerId) {
		await this.init();
		const entry = this.#entry(providerId);
		const context = providerContext(this, { accounts: entry.pool.list() });
		const result = await entry.module.startAuthorization(context);
		return this.#persistAuthorizationResult(entry, providerId, result);
	}
	async pollAuthorization(providerId, sessionId) {
		await this.init();
		const entry = this.#entry(providerId);
		const result = await entry.module.pollAuthorization(sessionId, providerContext(this, { accounts: entry.pool.list() }));
		return this.#persistAuthorizationResult(entry, providerId, result);
	}
	async cancelAuthorization(providerId, sessionId) {
		await this.init();
		return this.#entry(providerId).module.cancelAuthorization(sessionId, providerContext(this));
	}
	async submitAuthorizationCode(providerId, sessionId, code) {
		await this.init();
		const entry = this.#entry(providerId);
		const result = await entry.module.submitAuthorizationCode(sessionId, code, providerContext(this, { accounts: entry.pool.list() }));
		return this.#persistAuthorizationResult(entry, providerId, result);
	}
	async refreshAccount(providerId, accountId, { force = false, tolerateFailure = false } = {}) {
		const key = `${providerId}\u0000${accountId}`;
		const existing = this.#accountRefreshPromises.get(key);
		if (existing) return existing;
		const promise = (async () => {
			try {
				return await withRefreshTimeout((signal) => this.#refreshAccountNow(providerId, accountId, {
					force,
					tolerateFailure,
					signal
				}), {
					providerId,
					accountId,
					timeoutMs: this.refreshTimeoutMs
				});
			} catch (error) {
				if (!error?.refreshTimeout || !tolerateFailure) throw error;
				await this.init();
				const entry = this.#entry(providerId);
				if (entry.pool.get(accountId)) {
					entry.pool.report(accountId, {
						status: "error",
						message: error.message
					});
					await this.#saveState([providerId]);
				}
				return {
					account: entry.pool.get(accountId),
					diagnostics: [error.message]
				};
			}
		})();
		this.#accountRefreshPromises.set(key, promise);
		try {
			return await promise;
		} finally {
			if (this.#accountRefreshPromises.get(key) === promise) this.#accountRefreshPromises.delete(key);
		}
	}
	async #refreshAccountNow(providerId, accountId, { force = false, tolerateFailure = false, signal } = {}) {
		await this.init();
		const entry = this.#entry(providerId);
		providerAccount(entry.pool, accountId);
		const diagnostics = [];
		let authorizationFailure = null;
		let refresh = null;
		try {
			refresh = await entry.module.refreshAccount(providerAccount(entry.pool, accountId), providerContext(this, {
				force,
				signal
			}));
			this.#applyPatch(entry.pool, accountId, refresh);
		} catch (error) {
			if (signal?.aborted) throw error;
			authorizationFailure = error;
			diagnostics.push(`刷新 OAuth 状态失败：${redactError(error)}`);
			entry.pool.report(accountId, {
				status: providerErrorStatus(error),
				message: diagnostics.at(-1)
			});
			if (!tolerateFailure) await this.#saveState([providerId]);
			if (!tolerateFailure) throw error;
		}
		if (authorizationFailure?.authExpired || authorizationFailure?.authForbidden) {
			await this.#saveState([providerId]);
			return {
				account: entry.pool.get(accountId),
				diagnostics
			};
		}
		try {
			if (refresh && Object.hasOwn(refresh, "quota")) {
				reportPostRefreshHealth(entry.pool, accountId);
				await this.#saveState([providerId]);
				return {
					account: entry.pool.get(accountId),
					diagnostics
				};
			}
			const quota = await entry.module.getQuota(providerAccount(entry.pool, accountId), providerContext(this, { signal }));
			this.#applyPatch(entry.pool, accountId, quota);
			reportPostRefreshHealth(entry.pool, accountId);
		} catch (error) {
			if (signal?.aborted) throw error;
			diagnostics.push(`刷新实时额度失败：${redactError(error)}`);
			entry.pool.report(accountId, {
				status: providerErrorStatus(error),
				message: diagnostics.at(-1)
			});
			if (!tolerateFailure) await this.#saveState([providerId]);
			if (!tolerateFailure) throw error;
		}
		await this.#saveState([providerId]);
		return {
			account: entry.pool.get(accountId),
			diagnostics
		};
	}
	async refreshAll(providerId = null) {
		await this.init();
		if (!providerId) return (await Promise.all([...this.#entries].map(([id]) => this.refreshAll(id)))).flat();
		this.#entry(providerId);
		const existing = this.#refreshPromises.get(providerId);
		if (existing) return existing;
		const promise = (async () => {
			const entry = this.#entry(providerId);
			return await Promise.all(entry.pool.list().map(async (account) => {
				try {
					return await this.refreshAccount(providerId, account.accountId, { tolerateFailure: true });
				} catch (error) {
					return {
						account: entry.pool.get(account.accountId),
						diagnostics: [redactError(error)]
					};
				}
			}));
		})();
		this.#refreshPromises.set(providerId, promise);
		try {
			return await promise;
		} finally {
			if (this.#refreshPromises.get(providerId) === promise) this.#refreshPromises.delete(providerId);
		}
	}
	async setPolicy(providerId, policy, defaultAccountId = void 0) {
		await this.init();
		const pool = this.#entry(providerId).pool;
		pool.setPolicy(policy);
		if (defaultAccountId !== void 0) pool.setDefaultAccount(defaultAccountId);
		await this.#saveState([providerId]);
		return {
			providerId,
			policy: pool.policy,
			defaultAccountId: pool.getDefaultAccountId()
		};
	}
	async setDefaultAccount(providerId, accountId) {
		await this.init();
		const pool = this.#entry(providerId).pool;
		pool.setDefaultAccount(accountId);
		await this.#saveState([providerId]);
		return {
			providerId,
			defaultAccountId: pool.getDefaultAccountId()
		};
	}
	async removeAccount(providerId, accountId) {
		await this.init();
		const entry = this.#entry(providerId);
		const credential = entry.pool.resolve(accountId);
		if (!entry.pool.remove(accountId)) throw new Error(`Account does not exist: ${accountId}`);
		await this.#saveState([providerId]);
		const diagnostics = [];
		if (credential.credentialRef && typeof this.secretStore?.delete === "function") try {
			await this.secretStore.delete(credential.credentialRef);
		} catch (error) {
			diagnostics.push(`清理本机 Keychain 引用失败：${redactError(error)}`);
		}
		return {
			providerId,
			accountId,
			removed: true,
			defaultAccountId: entry.pool.getDefaultAccountId(),
			diagnostics
		};
	}
	async getCatalog(providerId) {
		await this.init();
		const entry = this.#entry(providerId);
		const accounts = entry.pool.list().map((account) => providerAccount(entry.pool, account.accountId));
		return entry.module.getCatalog(providerContext(this, { accounts }));
	}
	async getActiveSession(providerId) {
		await this.init();
		const entry = this.#entry(providerId);
		return entry.module.getActiveSession(providerContext(this, { accounts: entry.pool.list() }));
	}
	async invoke(providerId, request, context = {}) {
		await this.init();
		const route = this.bridge.getRoute(providerId);
		try {
			return await route.invoke(request, providerContext(this, {
				...context,
				secretStore: this.secretStore
			}));
		} finally {
			await this.#saveState([providerId]).catch(() => {});
		}
	}
	async stream(providerId, request, context = {}) {
		await this.init();
		const route = this.bridge.getRoute(providerId);
		if (!route) throw new Error(`Unknown Dockyard provider route: ${providerId}`);
		const output = route.stream(request, providerContext(this, {
			...context,
			secretStore: this.secretStore
		}));
		const runtime = this;
		return (async function* streamWithPersistedHealth() {
			try {
				for await (const chunk of await output) yield chunk;
			} finally {
				try {
					await runtime.#saveState([providerId]);
				} catch {}
			}
		})();
	}
	snapshot() {
		return {
			generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			providers: [...this.#entries].map(([providerId, entry]) => ({
				providerId,
				manifest: { ...entry.module.manifest },
				policy: entry.pool.policy,
				defaultAccountId: entry.pool.getDefaultAccountId(),
				accounts: entry.pool.list()
			})),
			routes: this.bridge.listRoutes()
		};
	}
	#applyPatch(pool, accountId, patch = {}) {
		if (!patch || typeof patch !== "object") return;
		const input = { accountId };
		for (const key of [
			"email",
			"displayName",
			"subscription",
			"quota",
			"refresh",
			"resources"
		]) if (patch[key] !== void 0) input[key] = patch[key];
		if (patch.identity?.email !== void 0) input.email = patch.identity.email;
		if (patch.identity?.displayName !== void 0) input.displayName = patch.identity.displayName;
		if (patch.credits !== void 0) input.resources = { credits: patch.credits };
		pool.upsert(input);
	}
	async #persistAuthorizationResult(entry, providerId, result) {
		if (result?.status !== "completed") return result;
		const rawAccounts = Array.isArray(result.accounts) ? result.accounts : result.account ? [result.account] : [];
		const accounts = await this.#storeImportedAccounts(entry, rawAccounts);
		await this.#saveState([providerId]);
		return {
			...result,
			accounts
		};
	}
	async #storeImportedAccounts(entry, rawAccounts) {
		const accounts = [];
		for (const account of rawAccounts.filter((value) => value?.accountId)) {
			const imported = Boolean(account?.auth?.credentialRef || account?.auth?.kind && account?.credentialRef && !account?.candidateId) || typeof entry.module.importAccount !== "function" ? account : await entry.module.importAccount(account, providerContext(this));
			entry.pool.upsert(imported, { resetHealth: true });
			accounts.push(entry.pool.get(imported.accountId));
		}
		return accounts;
	}
	async #saveState(changedProviderIds = null) {
		const write = async () => {
			const changed = changedProviderIds === null ? new Set(this.#entries.keys()) : new Set(changedProviderIds);
			const merge = (latest) => {
				const pools = { ...latest?.pools && typeof latest.pools === "object" ? latest.pools : {} };
				for (const [providerId, entry] of this.#entries) {
					if (!changed.has(providerId) && Object.hasOwn(pools, providerId)) continue;
					pools[providerId] = {
						policy: entry.pool.policy,
						defaultAccountId: entry.pool.getDefaultAccountId(),
						accounts: entry.pool.listForStorage()
					};
				}
				return {
					...latest,
					pools
				};
			};
			if (typeof this.stateStore.update === "function") {
				await this.stateStore.update(merge);
				return;
			}
			const latest = await this.stateStore.load();
			await this.stateStore.save(merge(latest));
		};
		const queued = this.#saveQueue.then(write, write);
		this.#saveQueue = queued.catch(() => {});
		await queued;
	}
};
//#endregion
//#region src/host/pi-ai-registry-loader.ts
/**
* Load Claude's catalog from the pi-ai installation shipped with the active
* DSH CLI. The plugin does not take a package dependency on pi-ai, because DSH
* owns and upgrades that live provider registry.
*/
function createDshAnthropicRegistryLoader(moduleAnchor) {
	let loading;
	return async () => {
		loading ??= loadRegistry(moduleAnchor);
		return [...(await loading).anthropicProvider().getModels()];
	};
}
async function loadRegistry(moduleAnchor) {
	try {
		return await import("@earendil-works/pi-ai/providers/anthropic");
	} catch {
		const roots = candidateModuleRoots(moduleAnchor);
		for (const root of roots) {
			const piRoot = await findPackageRoot(root, "@earendil-works/pi-ai");
			if (piRoot !== null) return await import(await packageImportUrl(piRoot, "providers/anthropic"));
		}
		throw new Error("The active DSH installation does not expose the pi-ai Anthropic model registry");
	}
}
function candidateModuleRoots(moduleAnchor) {
	const roots = /* @__PURE__ */ new Set();
	const anchors = [
		moduleAnchor,
		process.env.DSH_CLI_PATH,
		process.argv[1],
		import.meta.url
	];
	for (const anchor of anchors) {
		if (!anchor) continue;
		try {
			const llmPath = createRequire(anchor).resolve("@deepseek-ai/dsh-llm");
			roots.add(dirname(llmPath));
		} catch {
			const plain = anchor.startsWith("file:") ? new URL(anchor).pathname : anchor;
			roots.add(dirname(resolve(plain)));
		}
	}
	for (const nodePath of (process.env.NODE_PATH ?? "").split(delimiter)) if (nodePath) roots.add(resolve(nodePath));
	const appData = process.env.APPDATA;
	if (appData) roots.add(join(appData, "npm", "node_modules", "@deepseek-ai", "dsh"));
	return [...roots];
}
async function findPackageRoot(startDirectory, packageName) {
	const packageParts = packageName.split("/");
	let current = resolve(startDirectory);
	while (true) {
		const candidate = join(current, "node_modules", ...packageParts);
		try {
			await access(join(candidate, "package.json"));
			return candidate;
		} catch {
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}
async function packageImportUrl(packageRoot, subpath) {
	const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	const target = resolveExport(packageJson.exports?.[`./${subpath}`]) ?? resolveWildcardExport(packageJson.exports, subpath);
	if (target === null) throw new Error(`Cannot resolve pi-ai subpath ${subpath}`);
	return pathToFileURL(join(packageRoot, target)).href;
}
function resolveWildcardExport(exports, subpath) {
	if (exports === void 0) return null;
	const key = `./${subpath}`;
	for (const [pattern, value] of Object.entries(exports)) {
		const star = pattern.indexOf("*");
		if (star < 0) continue;
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
		const target = resolveExport(value);
		if (target !== null) return target.replace("*", key.slice(prefix.length, key.length - suffix.length));
	}
	return null;
}
function resolveExport(value) {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value;
	for (const condition of [
		"import",
		"node",
		"default"
	]) {
		const target = resolveExport(record[condition]);
		if (target !== null) return target;
	}
	return null;
}
//#endregion
//#region src/host/multi-provider-runtime.ts
const SUBSCRIPTION_PROVIDER_IDS = [
	"claude",
	"grok",
	"cursor",
	"antigravity"
];
const PROVIDER_NAMES = {
	claude: "Claude（订阅 OAuth）",
	grok: "Grok（订阅 OAuth）",
	cursor: "Cursor（官方会话）",
	antigravity: "Antigravity（Google OAuth）"
};
var MultiProviderRuntime = class {
	runtime;
	attachments;
	candidates = /* @__PURE__ */ new Map();
	constructor(options) {
		this.attachments = options.attachments;
		const env = sanitizeProviderEnvironment(options.env ?? process.env);
		const providerOptions = {
			antigravity: { env },
			claude: { env },
			cursor: { env },
			grok: { env }
		};
		const userAgent = attributionHeaders()["user-agent"];
		const antigravityQuota = createAntigravityNativeQuotaReader({
			env,
			endpoint: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
			userAgent
		});
		providerOptions.antigravity = {
			...providerOptions.antigravity,
			quotaReader: antigravityQuota
		};
		const catalogLoaders = {
			antigravity: createAntigravityCatalogLoader({ env }),
			claude: createClaudeCatalogLoader({ registryLoader: createDshAnthropicRegistryLoader() }),
			cursor: createCursorCatalogLoader({ env }),
			grok: createGrokCatalogLoader({
				env,
				commandRunner: runCliCommand
			})
		};
		const requestExecutors = {
			antigravity: createAntigravitySessionExecutor(createAntigravityNativeExecutor({
				env,
				endpoint: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
				userAgent
			}), createAntigravityCliExecutor({
				env,
				catalogLoader: catalogLoaders.antigravity
			})),
			claude: createClaudeNativeExecutor({
				env,
				endpoint: "https://api.anthropic.com/v1/messages",
				userAgent
			}),
			cursor: createCursorNativeExecutor({
				env,
				endpoint: "https://api2.cursor.sh",
				timeoutMs: 12e4,
				userAgent
			}),
			grok: createGrokNativeExecutor({
				env,
				endpoint: "https://api.x.ai/v1/chat/completions",
				userAgent
			})
		};
		const providers = createDefaultProviderEntries({
			...providerOptions,
			catalogLoaders,
			requestExecutors
		});
		this.runtime = new DockyardRuntime({
			providers,
			secretStore: options.secretStore,
			stateStore: new JsonStateStore({ filePath: options.statePath ?? defaultProviderStatePath(env) })
		});
	}
	async init() {
		await this.runtime.init();
	}
	async dispose() {
		await this.runtime.dispose?.();
	}
	providers() {
		return SUBSCRIPTION_PROVIDER_IDS;
	}
	providerName(provider) {
		return PROVIDER_NAMES[provider] ?? provider;
	}
	async listModels(provider) {
		await this.runtime.init();
		const entry = this.runtime.snapshot().providers.find((value) => value.providerId === provider);
		if (!entry || entry.accounts.length === 0) return [];
		return catalogModels(provider, await this.runtime.getCatalog(provider));
	}
	async resolveModel(provider, model) {
		return (await this.listModels(provider)).find((entry) => entry.id === model) ?? {
			provider,
			id: model,
			name: model
		};
	}
	async *stream(options) {
		const stream = await this.runtime.stream(options.provider, options, {
			sessionId: options.sessionId,
			attachments: this.attachments
		});
		for await (const chunk of stream) yield chunk;
	}
	snapshot() {
		return this.runtime.snapshot();
	}
	async scan(provider) {
		const result = await this.runtime.scan(provider ?? null);
		for (const entry of result.providers ?? []) if (typeof entry.providerId === "string" && Array.isArray(entry.candidates)) this.candidates.set(entry.providerId, entry.candidates);
		return result;
	}
	discoveredCandidates(provider) {
		return this.candidates.get(provider) ?? [];
	}
	importCandidate(provider, candidateId) {
		return this.runtime.importCandidate(provider, candidateId);
	}
	startAuthorization(provider) {
		return this.runtime.startAuthorization(provider);
	}
	pollAuthorization(provider, sessionId) {
		return this.runtime.pollAuthorization(provider, sessionId);
	}
	submitAuthorizationCode(provider, sessionId, code) {
		return this.runtime.submitAuthorizationCode(provider, sessionId, code);
	}
	cancelAuthorization(provider, sessionId) {
		return this.runtime.cancelAuthorization(provider, sessionId);
	}
	refresh(provider) {
		return this.runtime.refreshAll(provider ?? null);
	}
	removeAccount(provider, accountId) {
		return this.runtime.removeAccount(provider, accountId);
	}
	activeSession(provider) {
		return this.runtime.getActiveSession(provider);
	}
};
function createAntigravitySessionExecutor(nativeExecutor, cliExecutor) {
	return (value) => {
		const resources = value.invocation?.account?.resources;
		return resources?.sessionSource === "cli" && resources?.sessionPersistence === "active" ? cliExecutor(value) : nativeExecutor(value);
	};
}
function defaultProviderStatePath(env = process.env) {
	return join(env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "storages", "dsh-chatgpt-subscription", "providers.json");
}
function sanitizeProviderEnvironment(source) {
	const env = { ...source };
	const blocked = /* @__PURE__ */ new Set([
		"DOCKYARD_CLAUDE_AUTHORIZATION_URL",
		"DOCKYARD_CLAUDE_TOKEN_URL",
		"DOCKYARD_CLAUDE_CLIENT_ID",
		"DOCKYARD_CLAUDE_REDIRECT_URI",
		"DOCKYARD_CLAUDE_OAUTH_SCOPE",
		"DOCKYARD_GROK_AUTHORIZATION_URL",
		"DOCKYARD_GROK_TOKEN_URL",
		"DOCKYARD_GROK_CREDITS_URL",
		"DOCKYARD_GROK_CLIENT_ID",
		"DOCKYARD_GROK_OAUTH_SCOPE",
		"DOCKYARD_GROK_TOKEN_HEADER",
		"DOCKYARD_ANTIGRAVITY_AUTHORIZATION_URL",
		"DOCKYARD_ANTIGRAVITY_TOKEN_URL",
		"DOCKYARD_ANTIGRAVITY_USERINFO_URL",
		"CURSOR_WEBSITE_URL",
		"CURSOR_API_BASE_URL",
		"CURSOR_REFRESH_URL"
	]);
	for (const key of blocked) delete env[key];
	return env;
}
function catalogModels(provider, catalog) {
	return (Array.isArray(catalog.models) ? catalog.models : []).flatMap((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
		const model = value;
		if (typeof model.id !== "string" || model.id === "") return [];
		const modalities = provider === "cursor" ? ["text"] : Array.isArray(model.inputModalities) ? model.inputModalities.filter((item) => item === "text" || item === "image") : void 0;
		const reasoning = normalizeReasoning(model.reasoning);
		return [{
			provider,
			id: model.id,
			name: typeof model.name === "string" && model.name !== "" ? model.name : model.id,
			...modalities?.length ? { inputModalities: modalities } : {},
			...Number.isInteger(model.contextWindow) ? { context: { contextWindow: model.contextWindow } } : {},
			...Number.isInteger(model.maxTokens) ? { defaultMaxTokens: model.maxTokens } : {},
			...reasoning ? { reasoning } : {}
		}];
	});
}
function normalizeReasoning(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	if (!Array.isArray(record.efforts)) return void 0;
	const efforts = record.efforts.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
		const effort = entry;
		if (typeof effort.id !== "string" || effort.id === "") return [];
		return [{
			id: ReasoningEffortId(effort.id),
			name: typeof effort.name === "string" && effort.name !== "" ? effort.name : effort.id
		}];
	});
	if (efforts.length === 0) return void 0;
	const defaultEffort = typeof record.defaultEffort === "string" && efforts.some((effort) => effort.id === record.defaultEffort) ? ReasoningEffortId(record.defaultEffort) : void 0;
	return {
		efforts,
		...defaultEffort ? { defaultEffort } : {}
	};
}
//#endregion
//#region src/host/multi-provider-routes.ts
const PREFIX = `${ROUTE_PREFIX}/providers`;
const MAX_BODY_BYTES = 64 * 1024;
function registerMultiProviderRoutes(ctx, runtime, storage) {
	const csrfToken = randomBytes(32).toString("base64url");
	const handler = async (request, response) => {
		const url = new URL(request.url ?? "/", "http://dsh.local");
		try {
			if (request.method === "GET" && url.pathname === PREFIX) {
				response.setHeader("cache-control", "no-store");
				json(response, {
					ok: true,
					value: {
						...await publicSnapshot(runtime, storage),
						csrfToken
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
			if (!isSameOriginMutation(request) || !validCsrfToken(request, csrfToken)) {
				jsonError(response, 403, {
					code: "csrf-rejected",
					message: "Cross-origin request rejected."
				});
				return;
			}
			const body = await readJson(request);
			if (body === null) {
				jsonError(response, 400, {
					code: "bad-request",
					message: "A valid JSON object is required."
				});
				return;
			}
			const provider = optionalField(body, "providerId");
			if (provider !== null && !SUBSCRIPTION_PROVIDER_IDS.includes(provider)) throw new ProviderRouteError("bad-request", `Unknown provider: ${provider}`);
			let value;
			switch (url.pathname) {
				case `${PREFIX}/scan`:
					value = await runtime.scan(provider);
					break;
				case `${PREFIX}/active-session`:
					value = await runtime.activeSession(requiredProvider(provider));
					break;
				case `${PREFIX}/candidate/import`:
					value = await runtime.importCandidate(requiredProvider(provider), requiredField(body, "candidateId"));
					break;
				case `${PREFIX}/login/start`:
					value = publicAuthorization(await runtime.startAuthorization(requiredProvider(provider)));
					break;
				case `${PREFIX}/login/poll`:
					value = publicAuthorization(await runtime.pollAuthorization(requiredProvider(provider), requiredField(body, "sessionId")));
					break;
				case `${PREFIX}/login/code`:
					value = publicAuthorization(await runtime.submitAuthorizationCode(requiredProvider(provider), requiredField(body, "sessionId"), requiredField(body, "code")));
					break;
				case `${PREFIX}/login/cancel`:
					value = publicAuthorization(await runtime.cancelAuthorization(requiredProvider(provider), requiredField(body, "sessionId")));
					break;
				case `${PREFIX}/refresh`:
					value = await runtime.refresh(provider);
					break;
				case `${PREFIX}/account/remove`:
					value = await runtime.removeAccount(requiredProvider(provider), requiredField(body, "accountId"));
					break;
				default: throw new ProviderRouteError("bad-request", "Route not found.");
			}
			json(response, {
				ok: true,
				value: {
					result: sanitize(value),
					snapshot: await publicSnapshot(runtime, storage)
				}
			});
		} catch (error) {
			if (error instanceof RequestBodyTooLargeError) {
				request.destroy();
				jsonError(response, 413, {
					code: "bad-request",
					message: "Request body is too large."
				});
				return;
			}
			const mapped = routeError(error);
			jsonError(response, mapped.code === "bad-request" ? 400 : 502, mapped);
		}
	};
	return ctx.webServer.register({
		kind: "prefix",
		path: PREFIX,
		handler
	});
}
async function publicSnapshot(runtime, storage) {
	await runtime.init();
	const snapshot = runtime.snapshot();
	return {
		generatedAt: snapshot.generatedAt,
		providers: snapshot.providers.map((provider) => ({
			providerId: provider.providerId,
			displayName: runtime.providerName(provider.providerId),
			capabilities: provider.manifest.capabilities ?? [],
			policy: provider.policy,
			defaultAccountId: provider.defaultAccountId ?? null,
			accounts: provider.accounts.map(publicAccount),
			candidates: runtime.discoveredCandidates(provider.providerId).map((candidate) => ({
				candidateId: candidate.candidateId,
				accountId: candidate.accountId,
				displayName: candidate.displayName ?? null,
				email: maskEmail(typeof candidate.email === "string" ? candidate.email : null),
				source: candidate.source ?? null,
				imported: candidate.imported === true
			}))
		})),
		storage: {
			...storage,
			available: true
		}
	};
}
function publicAccount(value) {
	return {
		providerId: value.providerId,
		accountId: value.accountId,
		displayName: value.displayName ?? null,
		email: maskEmail(typeof value.email === "string" ? value.email : null),
		subscription: sanitize(value.subscription),
		quota: sanitize(value.quota),
		refresh: sanitize(value.refresh),
		resources: sanitize(value.resources),
		health: sanitize(value.health)
	};
}
function publicAuthorization(value) {
	return {
		status: value.status,
		...typeof value.providerId === "string" ? { providerId: value.providerId } : {},
		...typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {},
		...typeof value.authorizationUrl === "string" ? { authorizationUrl: value.authorizationUrl } : {},
		...typeof value.instructions === "string" ? { instructions: value.instructions } : {},
		...value.browserOpened === true ? { browserOpened: true } : {},
		...value.inputRequired === true ? { inputRequired: true } : {},
		...value.authorizationCodeRequired === true ? { authorizationCodeRequired: true } : {},
		...typeof value.diagnostic === "string" ? { diagnostic: value.diagnostic } : {},
		...Array.isArray(value.accounts) ? { accounts: value.accounts.map((account) => publicAccount(account)) } : {}
	};
}
function sanitize(value) {
	if (Array.isArray(value)) return value.map(sanitize);
	if (typeof value !== "object" || value === null) return value;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if (/token|secret|credential|api.?key/i.test(key) || /^(?:authorization|proxy-authorization)$/i.test(key)) continue;
		result[key] = sanitize(entry);
	}
	return result;
}
var RequestBodyTooLargeError = class extends Error {};
var ProviderRouteError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
function redactDiagnostic(value) {
	return value.replace(/https?:\/\/[^\s]+/gi, "[redacted-url]").replace(/((?:bearer|token|secret|authorization|code|verifier|client[_-]?secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").replace(/[A-Za-z]:\\[^\s]+|\/(?:[^\s\/]+\/){2,}[^\s]*/g, "[redacted-path]").replace(/\s+/g, " ").trim().slice(0, 300);
}
function routeError(error) {
	if (error instanceof ProviderRouteError) return {
		code: error.code,
		message: redactDiagnostic(error.message)
	};
	return {
		code: "connection-failed",
		message: error instanceof Error ? redactDiagnostic(error.message) : "Provider operation failed."
	};
}
function requiredProvider(provider) {
	if (provider === null) throw new ProviderRouteError("bad-request", "providerId is required.");
	return provider;
}
function requiredField(body, name) {
	const value = optionalField(body, name);
	if (value === null) throw new ProviderRouteError("bad-request", `${name} is required.`);
	return value;
}
function optionalField(body, name) {
	const value = body[name];
	return typeof value === "string" && value !== "" ? value : null;
}
function maskEmail(email) {
	if (email === null) return null;
	const at = email.indexOf("@");
	return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : "***";
}
function validCsrfToken(request, expected) {
	const supplied = request.headers["x-dsh-csrf-token"];
	if (typeof supplied !== "string") return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function isSameOriginMutation(request) {
	const host = request.headers.host;
	const origin = request.headers.origin;
	if (typeof host !== "string" || typeof origin !== "string") return false;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}
async function readJson(request) {
	const contentType = request.headers["content-type"];
	if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) return null;
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > MAX_BODY_BYTES) throw new RequestBodyTooLargeError();
		chunks.push(bytes);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
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
//#endregion
//#region src/host/provider-secret-store.ts
const BUNDLE_MARKER_ACCESS = "provider-secret-bundle";
const BUNDLE_MARKER_REFRESH = "provider-secret-bundle";
const PROVIDER_IDS = /* @__PURE__ */ new Set([
	"claude",
	"grok",
	"cursor",
	"antigravity"
]);
const REF_PATTERN = /^provider-secret:\/\/dsh-subscriptions\/([a-z][a-z0-9-]{0,31})\/([a-f0-9]{64})$/;
function assertProviderId(providerId) {
	if (!PROVIDER_IDS.has(providerId)) throw new Error(`Unsupported subscription provider: ${providerId}`);
}
function assertCredentialRef(ref) {
	const match = REF_PATTERN.exec(ref);
	if (!match) throw new Error("Invalid provider credential reference");
	assertProviderId(match[1]);
	return { providerId: match[1] };
}
function assertCredentialEnvelope(ref, value) {
	const { providerId } = assertCredentialRef(ref);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Provider credential must be an object envelope");
	const envelope = value;
	if (envelope.providerId !== providerId) throw new Error("Provider credential reference/envelope mismatch");
	const type = envelope.type;
	if (type !== "oauth" && type !== "official_session" && type !== "official_cli_session") throw new Error("Subscription provider credentials must use OAuth or an official-session envelope");
	if (type === "oauth" && (typeof envelope.access !== "string" || envelope.access.length === 0)) throw new Error("OAuth provider credential access token is required");
}
var PlatformProviderSecretStore = class {
	store;
	queue = Promise.resolve();
	constructor(store) {
		this.store = store;
	}
	async read(ref) {
		assertCredentialRef(ref);
		const bundle = await this.loadBundle();
		return Object.hasOwn(bundle.values, ref) ? structuredClone(bundle.values[ref]) : null;
	}
	async write(ref, value) {
		assertCredentialEnvelope(ref, value);
		await this.exclusive(async () => {
			const bundle = await this.loadBundle();
			bundle.values[ref] = structuredClone(value);
			await this.store.save({
				accessToken: BUNDLE_MARKER_ACCESS,
				refreshToken: BUNDLE_MARKER_REFRESH,
				expiresAt: Number.MAX_SAFE_INTEGER,
				providerSecrets: bundle.values
			});
		});
		return ref;
	}
	async delete(ref) {
		assertCredentialRef(ref);
		await this.exclusive(async () => {
			const bundle = await this.loadBundle();
			if (!Object.hasOwn(bundle.values, ref)) return;
			delete bundle.values[ref];
			if (Object.keys(bundle.values).length === 0) {
				await this.store.clear();
				return;
			}
			await this.store.save({
				accessToken: BUNDLE_MARKER_ACCESS,
				refreshToken: BUNDLE_MARKER_REFRESH,
				expiresAt: Number.MAX_SAFE_INTEGER,
				providerSecrets: bundle.values
			});
		});
	}
	async loadBundle() {
		const values = (await this.store.load())?.providerSecrets;
		return {
			schema: 1,
			values: values && typeof values === "object" && !Array.isArray(values) ? structuredClone(values) : {}
		};
	}
	async exclusive(operation) {
		const next = this.queue.then(operation, operation);
		this.queue = next.catch(() => void 0);
		return next;
	}
};
//#endregion
//#region src/index.ts
const inject = [
	"webServer",
	"llm",
	"attachments",
	"agents"
];
function apply(ctx) {
	const oauth = new OAuthService(createPlatformTokenStore(), { logger: ctx.logger });
	const usage = new UsageService(oauth);
	const adapter = new CodexChatGptAdapter(new ResponsesClient(oauth, ctx.attachments, {
		localRawImages: { baseUrl: localWebServerBaseUrl(ctx.webServer.host, ctx.webServer.port) },
		onGenerationFinished: () => usage.invalidate()
	}));
	ctx.effect(() => {
		const disposeRoutes = registerRoutes(ctx, oauth, usage);
		const disposeAdapter = ctx.llm.registerAdapter([PROVIDER_ID$8], adapter);
		const disposeProviderAdapters = [];
		let disposeProviderRoutes = () => {};
		let providerRuntime = null;
		try {
			const providerTokenStore = createPlatformTokenStore(void 0, "providers");
			providerRuntime = new MultiProviderRuntime({
				secretStore: new PlatformProviderSecretStore(providerTokenStore),
				attachments: ctx.attachments
			});
			const providerAdapter = new MultiProviderAdapter(providerRuntime);
			disposeProviderRoutes = registerMultiProviderRoutes(ctx, providerRuntime, providerTokenStore.storage);
			for (const providerId of SUBSCRIPTION_PROVIDER_IDS) try {
				disposeProviderAdapters.push(ctx.llm.registerAdapter([providerId], providerAdapter));
			} catch (error) {
				ctx.logger.warn(`[dsh-chatgpt-subscription] provider ${providerId} registration skipped: ${safeLogMessage(error)}`);
			}
			providerRuntime.init().catch((error) => {
				ctx.logger.warn(`[dsh-chatgpt-subscription] multi-provider initialization failed: ${safeLogMessage(error)}`);
			});
		} catch (error) {
			ctx.logger.warn(`[dsh-chatgpt-subscription] optional providers unavailable; Codex remains active: ${safeLogMessage(error)}`);
		}
		const disposeSubagentReportCompat = installSubagentReportDedupCompat(ctx);
		return () => {
			disposeSubagentReportCompat();
			for (const disposeProviderAdapter of disposeProviderAdapters.reverse()) disposeProviderAdapter();
			disposeAdapter();
			disposeProviderRoutes();
			disposeRoutes();
			providerRuntime?.dispose().catch((error) => {
				ctx.logger.warn(`[dsh-chatgpt-subscription] provider disposal failed: ${safeLogMessage(error)}`);
			});
			oauth.dispose();
		};
	}, "dsh-chatgpt-subscription: adapter, routes, and lifecycle");
}
function safeLogMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/gi, "[redacted-url]").replace(/((?:token|secret|authorization|code|verifier|api.?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]").replace(/\s+/g, " ").slice(0, 300);
}
function localWebServerBaseUrl(host, port) {
	return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}
//#endregion
export { CodexChatGptAdapter, LinuxFileTokenStore, MultiProviderAdapter, MultiProviderRuntime, OAuthService, PlatformProviderSecretStore, ResponsesClient, SUBSCRIPTION_PROVIDER_IDS, UsageService, WindowsDpapiTokenStore, apply, createPlatformTokenStore, inject, mapCodexUsage, parseResponsesStream };
