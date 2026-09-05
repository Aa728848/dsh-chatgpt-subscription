window.__ModuleLoader__.load({
	id: "@eddyskywalker/dsh-chatgpt-subscription",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		const ROUTE_PREFIX = "/api/dsh-chatgpt-subscription";
		const CODEX_CHATGPT_PROVIDER_ID = "codex-chatgpt";
		const CODEX_IMAGE_TOOL_NAME = "codex_image_generate";
		//#endregion
		//#region src/client/quota.ts
		function selectQuotaForModel(quota, modelId) {
			if (quota === void 0 || quota.buckets.length === 0) return null;
			const bucket = (modelId?.toLowerCase() ?? "").includes("spark") ? quota.buckets.find((candidate) => `${candidate.id} ${candidate.name}`.toLowerCase().includes("spark")) : quota.buckets.find((candidate) => candidate.id === "codex") ?? quota.buckets.find((candidate) => candidate.name.toLowerCase() === "codex");
			if (bucket === void 0) return null;
			const windows = quotaWindows(bucket);
			if (windows.length === 0) return null;
			const window = [...windows].sort((a, b) => {
				return (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity);
			})[0];
			return {
				bucket,
				window,
				remainingPercent: Math.max(0, 100 - window.usedPercent)
			};
		}
		function quotaWindows(bucket) {
			if (bucket.windows.length > 0) return bucket.windows;
			return [bucket.primary, bucket.secondary].filter((window) => window !== null);
		}
		//#endregion
		//#region src/client/CodexComposerQuota.tsx
		function CodexComposerQuota({ api, directory, loadModelDirectory, t }) {
			const modelState = useStore$1(directory);
			const [status, setStatus] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const mountedRef = (0, react.useRef)(false);
			const selected = modelState.current;
			const isCodex = selected?.provider === CODEX_CHATGPT_PROVIDER_ID;
			(0, react.useEffect)(() => {
				loadModelDirectory();
			}, [loadModelDirectory]);
			(0, react.useEffect)(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				if (!isCodex) return;
				let disposed = false;
				const refresh = async () => {
					setLoading(true);
					try {
						const next = await api.status();
						if (!disposed && mountedRef.current) setStatus(next);
					} catch {
						if (!disposed && mountedRef.current) setStatus(null);
					} finally {
						if (!disposed && mountedRef.current) setLoading(false);
					}
				};
				refresh();
				const timer = window.setInterval(() => {
					if (document.visibilityState === "visible") refresh();
				}, 6e4);
				return () => {
					disposed = true;
					window.clearInterval(timer);
				};
			}, [api, isCodex]);
			const quota = (0, react.useMemo)(() => selectQuotaForModel(status?.quota, selected?.model), [selected?.model, status?.quota]);
			if (!isCodex || status?.preferences.quickQuotaVisible !== true) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dsh-codex-composer-quota",
				"data-level": quota === null ? "normal" : quota.remainingPercent <= 5 ? "danger" : quota.remainingPercent <= 20 ? "warning" : "normal",
				"aria-label": quota === null ? t("quickQuotaLoading") : `${t("quickQuotaLabel")}: ${formatPercent$1(quota.remainingPercent)}`,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("quickQuotaLabel") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: quota === null ? loading ? t("quickQuotaLoading") : "—" : formatPercent$1(quota.remainingPercent) })]
			});
		}
		function useStore$1(store) {
			return (0, react.useSyncExternalStore)((listener) => store.subscribe(listener), () => store.getSnapshot(), () => store.getSnapshot());
		}
		function formatPercent$1(value) {
			return `${new Intl.NumberFormat(void 0, { maximumFractionDigits: 0 }).format(value)}%`;
		}
		//#endregion
		//#region src/client/CodexImageToolView.tsx
		function CodexImageToolView({ block, loadImage, t }) {
			const settled = "kind" in block;
			const isError = settled ? block.isError : false;
			const prompt = promptFromBlock(block);
			const images = settled && !isError ? imageBlocks(block.content) : [];
			const label = isError ? t("imageToolFailed") : settled ? t("imageToolDone") : t("imageToolRunning");
			const summary = prompt ?? textSummary(settled ? block.content : []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-codex-image-tool",
				"data-state": isError ? "error" : settled ? "done" : "running",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-codex-image-tool-head",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-codex-image-dot",
							"aria-hidden": "true"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-codex-image-title",
							children: label
						}),
						summary !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-codex-image-summary",
							children: summary
						}) : null
					]
				}), images.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-codex-image-grid",
					children: images.map((attachment) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GeneratedImage, {
						attachment,
						load: loadImage,
						label: attachment.name ?? t("image"),
						t
					}, String(attachment.attachmentId)))
				}) : null]
			});
		}
		function GeneratedImage({ attachment, load, label, t }) {
			const [src, setSrc] = (0, react.useState)(null);
			const [failed, setFailed] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let disposed = false;
				setSrc(null);
				setFailed(false);
				load(attachment).then((url) => {
					if (!disposed) setSrc(url);
				}, () => {
					if (!disposed) setFailed(true);
				});
				return () => {
					disposed = true;
				};
			}, [attachment, load]);
			if (failed) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-codex-image-failed",
				children: t("imageLoadFailed")
			});
			if (src === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-codex-image-loading",
				children: t("imageLoading")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
				className: "dsh-codex-image-preview",
				src,
				alt: label
			});
		}
		function promptFromBlock(block) {
			const raw = "kind" in block ? block.call?.argsRaw : block.argsRaw;
			if (typeof raw !== "string" || raw.trim() === "") return null;
			try {
				const value = JSON.parse(raw);
				return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.prompt === "string" ? value.prompt : null;
			} catch {
				return null;
			}
		}
		function imageBlocks(blocks) {
			const result = [];
			for (const block of blocks) {
				if (block.type === "image") result.push(block.attachment);
				if (block.type === "tool-result") result.push(...imageBlocks(block.content));
			}
			return result;
		}
		function textSummary(blocks) {
			const text = blocks.map((block) => block.type === "text" || block.type === "reasoning" ? block.text : "").filter(Boolean).join(" ").trim();
			return text === "" ? null : text;
		}
		//#endregion
		//#region src/shared/model-catalog.ts
		const GPT_56_MAX_CONTEXT_WINDOW = 1e6;
		const GPT_6_ASTRA_MAX_CONTEXT_WINDOW = 872e3;
		const CODEX_MODEL_CATALOG = [
			{
				id: "gpt-5.6-sol",
				name: "5.6 Sol",
				contextWindow: 272e3,
				inputModalities: ["text", "image"],
				defaultReasoningEffort: "medium",
				reasoningProfile: "gpt-5.6",
				supportsReasoningSummary: true,
				fallbackModelId: "gpt-5.6-terra"
			},
			{
				id: "gpt-6-astra",
				name: "6 Astra",
				contextWindow: 272e3,
				inputModalities: ["text", "image"],
				defaultReasoningEffort: "medium",
				reasoningProfile: "gpt-6-astra",
				supportsReasoningSummary: true
			},
			{
				id: "gpt-5.6-terra",
				name: "5.6 Terra",
				contextWindow: 272e3,
				inputModalities: ["text", "image"],
				defaultReasoningEffort: "medium",
				reasoningProfile: "gpt-5.6",
				supportsReasoningSummary: true,
				fallbackModelId: "gpt-5.5"
			},
			{
				id: "gpt-5.6-luna",
				name: "5.6 Luna",
				contextWindow: 272e3,
				inputModalities: ["text", "image"],
				defaultReasoningEffort: "medium",
				reasoningProfile: "gpt-5.6",
				supportsReasoningSummary: true,
				fallbackModelId: "gpt-5.5"
			},
			{
				id: "gpt-5.5",
				name: "5.5",
				contextWindow: 272e3,
				inputModalities: ["text", "image"],
				defaultReasoningEffort: "medium",
				reasoningProfile: "standard",
				supportsReasoningSummary: true
			},
			{
				id: "gpt-5.4",
				name: "5.4",
				contextWindow: 272e3,
				inputModalities: ["text", "image"],
				defaultReasoningEffort: "none",
				reasoningProfile: "standard",
				supportsReasoningSummary: true,
				fallbackModelId: "gpt-5.4-mini"
			},
			{
				id: "gpt-5.4-mini",
				name: "5.4 Mini",
				contextWindow: 272e3,
				inputModalities: ["text", "image"],
				defaultReasoningEffort: "none",
				reasoningProfile: "standard",
				supportsReasoningSummary: true
			},
			{
				id: "gpt-5.3-codex-spark",
				name: "5.3 Codex Spark",
				contextWindow: 258e3,
				inputModalities: ["text"],
				defaultReasoningEffort: "high",
				reasoningProfile: "standard",
				supportsReasoningSummary: false
			}
		];
		const DEFAULT_VISIBLE_CODEX_MODEL_IDS = [
			"gpt-5.6-sol",
			"gpt-6-astra",
			"gpt-5.6-terra",
			"gpt-5.6-luna"
		];
		const DEFAULT_CODEX_MODEL = CODEX_MODEL_CATALOG[0];
		const CONFIGURABLE_CONTEXT_MODEL_IDS = [
			"gpt-6-astra",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna"
		];
		function contextWindowLimitForModel(model) {
			return model === "gpt-6-astra" ? GPT_6_ASTRA_MAX_CONTEXT_WINDOW : GPT_56_MAX_CONTEXT_WINDOW;
		}
		function resolveCodexCatalogEntry(model) {
			return CODEX_MODEL_CATALOG.find((entry) => entry.id === model) ?? DEFAULT_CODEX_MODEL;
		}
		//#endregion
		//#region src/client/api.ts
		var SubscriptionApi = class {
			status() {
				return request(`${ROUTE_PREFIX}/status`);
			}
			startLogin() {
				return post(`${ROUTE_PREFIX}/login/start`, {});
			}
			cancelLogin(loginId) {
				return post(`${ROUTE_PREFIX}/login/cancel`, { loginId });
			}
			logout() {
				return post(`${ROUTE_PREFIX}/logout`, {});
			}
			refresh() {
				return post(`${ROUTE_PREFIX}/token/refresh`, {});
			}
			refreshQuota() {
				return post(`${ROUTE_PREFIX}/quota/refresh`, {});
			}
			useResetCredit() {
				return post(`${ROUTE_PREFIX}/quota/reset-credit/use`, {});
			}
			testConnection() {
				return post(`${ROUTE_PREFIX}/connection/test`, {});
			}
			updatePreferences(patch) {
				return post(`${ROUTE_PREFIX}/preferences/update`, patch);
			}
			events(loginId) {
				return new EventSource(`${ROUTE_PREFIX}/login/events?loginId=${encodeURIComponent(loginId)}`);
			}
		};
		async function post(url, body) {
			return request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
		}
		async function request(url, init) {
			const response = await fetch(url, {
				...init,
				credentials: "same-origin"
			});
			const envelope = await response.json();
			if (!response.ok || !envelope.ok) throw new Error(envelope.ok ? `Request failed (${response.status})` : envelope.error.message);
			return envelope.value;
		}
		function parseLoginEvent(event) {
			try {
				const value = JSON.parse(event.data);
				return typeof value === "object" && value !== null && typeof value.type === "string" ? value : null;
			} catch {
				return null;
			}
		}
		//#endregion
		//#region src/client/CodexSubscriptionSection.tsx
		function CodexSubscriptionSection({ t }) {
			const apiRef = (0, react.useRef)(new SubscriptionApi());
			const eventSourceRef = (0, react.useRef)(null);
			const [status, setStatus] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [authUrl, setAuthUrl] = (0, react.useState)(null);
			const [popupBlocked, setPopupBlocked] = (0, react.useState)(false);
			const [resetCreditNotice, setResetCreditNotice] = (0, react.useState)(null);
			const [connection, setConnection] = (0, react.useState)(null);
			const [contextDrafts, setContextDrafts] = (0, react.useState)({});
			const [subagentContextDraft, setSubagentContextDraft] = (0, react.useState)(null);
			const [customProxyDraft, setCustomProxyDraft] = (0, react.useState)(null);
			const load = (0, react.useCallback)(async (quiet = false) => {
				if (!quiet) setError(null);
				try {
					const next = await apiRef.current.status();
					setStatus(next);
					if (next.error !== void 0) setError(next.error.message);
				} catch (cause) {
					if (!quiet) setError(messageOf(cause));
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
				const refreshWhenVisible = () => {
					if (document.visibilityState === "visible") load(true);
				};
				document.addEventListener("visibilitychange", refreshWhenVisible);
				const timer = window.setInterval(refreshWhenVisible, 6e4);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", refreshWhenVisible);
					eventSourceRef.current?.close();
				};
			}, [load]);
			const watchLogin = (0, react.useCallback)((loginId) => {
				eventSourceRef.current?.close();
				const source = apiRef.current.events(loginId);
				eventSourceRef.current = source;
				const finish = async (message) => {
					source.close();
					eventSourceRef.current = null;
					setBusy(null);
					setAuthUrl(null);
					if (message !== void 0) setError(message);
					await load(true);
				};
				source.addEventListener("completed", (event) => {
					if (parseLoginEvent(event)?.type === "completed") finish();
				});
				source.addEventListener("cancelled", () => void finish());
				source.addEventListener("failed", (event) => {
					const parsed = parseLoginEvent(event);
					finish(parsed?.type === "failed" ? parsed.error.message : "ChatGPT sign-in failed.");
				});
			}, [load]);
			(0, react.useEffect)(() => {
				const loginId = status?.login.active ? status.login.loginId : null;
				if (loginId !== null && loginId !== void 0 && eventSourceRef.current === null) watchLogin(loginId);
			}, [
				status?.login.active,
				status?.login.loginId,
				watchLogin
			]);
			const startLogin = async () => {
				setBusy("login");
				setError(null);
				setPopupBlocked(false);
				const popup = window.open("about:blank", "dsh-chatgpt-oauth", "popup,width=560,height=760");
				try {
					const login = await apiRef.current.startLogin();
					setAuthUrl(login.authUrl);
					if (popup === null) setPopupBlocked(true);
					else popup.location.replace(login.authUrl);
					watchLogin(login.loginId);
					await load(true);
				} catch (cause) {
					popup?.close();
					setBusy(null);
					setError(messageOf(cause));
				}
			};
			const cancelLogin = async () => {
				const loginId = status?.login.loginId;
				if (loginId === null || loginId === void 0) return;
				setBusy("login");
				try {
					await apiRef.current.cancelLogin(loginId);
					eventSourceRef.current?.close();
					eventSourceRef.current = null;
					setAuthUrl(null);
					await load();
				} catch (cause) {
					setError(messageOf(cause));
				} finally {
					setBusy(null);
				}
			};
			const refreshToken = async () => run("token", async () => {
				setStatus(await apiRef.current.refresh());
			});
			const refreshQuota = async () => run("quota", async () => {
				const quota = await apiRef.current.refreshQuota();
				setStatus((current) => current === null ? current : {
					...current,
					quota
				});
			});
			const useResetCredit = async () => {
				if (!window.confirm(t("useResetCreditConfirm"))) return;
				await run("reset-credit", async () => {
					const quota = await apiRef.current.useResetCredit();
					setStatus((current) => current === null ? current : {
						...current,
						quota
					});
					setResetCreditNotice(t("resetCreditUsed"));
				});
			};
			const testConnection = async () => run("test", async () => {
				const result = await apiRef.current.testConnection();
				setConnection({
					latencyMs: result.latencyMs,
					checkedAt: result.checkedAt
				});
			});
			const updatePreferences = async (patch) => run("preferences", async () => {
				const preferences = await apiRef.current.updatePreferences(patch);
				setStatus((current) => current === null ? current : {
					...current,
					preferences
				});
			});
			const selectSearchProvider = (provider) => {
				setStatus((current) => current ? {
					...current,
					preferences: {
						...current.preferences,
						searchProvider: provider
					}
				} : current);
				updatePreferences({ searchProvider: provider });
			};
			const toggleVisibleModel = async (modelId, checked) => {
				const current = status?.preferences.visibleModelIds ?? [...DEFAULT_VISIBLE_CODEX_MODEL_IDS];
				const visibleModelIds = checked ? [...current, modelId] : current.filter((id) => id !== modelId);
				if (visibleModelIds.length === 0) return;
				await updatePreferences({ visibleModelIds });
			};
			const updateContextWindow = async (model) => {
				const current = status?.preferences.contextWindowOverrides[model] ?? resolveCodexCatalogEntry(model).contextWindow;
				const parsed = parseCapacity(contextDrafts[model] ?? String(current), contextWindowLimitForModel(model));
				if (parsed === null) {
					setError(t("contextWindowInvalid"));
					return;
				}
				await updatePreferences({ contextWindowOverrides: { [model]: parsed } });
				setContextDrafts((drafts) => ({
					...drafts,
					[model]: String(parsed)
				}));
			};
			const updateSubagentContextWindow = async () => {
				const draft = subagentContextDraft?.trim();
				if (draft === void 0 || draft === "") {
					await updatePreferences({ subagentContextWindow: null });
					setSubagentContextDraft(null);
					return;
				}
				const parsed = parsePositiveCapacity$1(draft);
				if (parsed === null) {
					setError(t("contextWindowInvalid"));
					return;
				}
				await updatePreferences({ subagentContextWindow: parsed });
				setSubagentContextDraft(null);
			};
			const updateCustomProxyUrl = async () => {
				const draft = customProxyDraft?.trim();
				await updatePreferences({ customProxyUrl: draft ? draft : null });
				setCustomProxyDraft(null);
			};
			const logout = async () => run("logout", async () => {
				await apiRef.current.logout();
				eventSourceRef.current?.close();
				eventSourceRef.current = null;
				setAuthUrl(null);
				setConnection(null);
				await load();
			});
			const run = async (action, task) => {
				setBusy(action);
				setError(null);
				setResetCreditNotice(null);
				try {
					await task();
				} catch (cause) {
					setError(messageOf(cause));
				} finally {
					setBusy(null);
				}
			};
			const account = status?.account;
			const preferences = status?.preferences;
			const quota = status?.quota;
			const storage = status?.storage;
			const login = status?.login;
			const visibleModelIds = preferences?.visibleModelIds ?? DEFAULT_VISIBLE_CODEX_MODEL_IDS;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dsh-codex-page",
				"aria-labelledby": "dsh-codex-title",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						id: "dsh-codex-title",
						className: "dsh-codex-title",
						children: t("title")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dsh-codex-intro",
						children: t("intro")
					})] }),
					error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-codex-errorbar",
						role: "alert",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: error }), status === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
							disabled: busy !== null,
							onClick: () => load(),
							children: t("retry")
						}) : null]
					}) : null,
					status === null && error === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Skeleton, { label: t("loading") }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("account"),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
									label: status?.authenticated ? t("signedIn") : t("signedOut"),
									value: account?.email ?? "—"
								}),
								status?.authenticated ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
										label: t("plan"),
										value: account?.planType ?? t("unknown")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
										label: t("accountId"),
										value: account?.accountIdSuffix ?? "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
										label: t("expires"),
										value: formatDate$1(account?.tokenExpiresAt)
									})
								] }) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
									label: t("storage"),
									value: storageLabel(storage, t)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-notice",
									children: storageNotice(storage, t)
								}),
								login?.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-muted",
									role: "status",
									children: t("pending")
								}) : null,
								popupBlocked ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-error",
									children: t("popupBlocked")
								}) : null,
								authUrl !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: "dsh-codex-link",
									href: authUrl,
									target: "_blank",
									rel: "noreferrer",
									children: t("continueLogin")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-actions",
									children: [login?.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										disabled: busy !== null,
										onClick: cancelLogin,
										children: t("cancel")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										primary: true,
										disabled: busy !== null || storage?.available === false,
										onClick: startLogin,
										children: status?.authenticated ? t("signInAgain") : t("signIn")
									}), status?.authenticated ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										disabled: busy !== null,
										onClick: refreshToken,
										children: t("refreshToken")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										disabled: busy !== null,
										onClick: logout,
										children: t("signOut")
									})] }) : null]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("connection"),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
									label: t("provider"),
									value: "Codex（ChatGPT 订阅） · codex-chatgpt"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
									label: t("connectionState"),
									value: connection === null ? t("untested") : t("connected")
								}),
								connection !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
									label: t("latency"),
									value: `${connection.latencyMs} ms · ${formatDate$1(connection.checkedAt)}`
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-muted dsh-codex-models-hint",
									children: t("modelsHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-codex-models",
									"aria-label": t("models"),
									children: CODEX_MODEL_CATALOG.map((model) => {
										const checked = visibleModelIds.some((id) => id === model.id);
										const lastVisible = checked && visibleModelIds.length === 1;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											title: model.id,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked,
												disabled: busy !== null || lastVisible,
												onChange: (event) => void toggleVisibleModel(model.id, event.currentTarget.checked)
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name })]
										}, model.id);
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-codex-actions",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										disabled: !status?.authenticated || busy !== null,
										onClick: testConnection,
										children: busy === "test" ? t("testing") : t("testConnection")
									})
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("proxySettings"),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-pref-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("proxyMode") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("proxyModeHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: "dsh-codex-select",
										"aria-label": t("proxyMode"),
										value: preferences?.proxyMode ?? "auto",
										disabled: busy !== null,
										onChange: (event) => {
											const mode = event.currentTarget.value;
											setStatus((current) => current ? {
												...current,
												preferences: {
													...current.preferences,
													proxyMode: mode
												}
											} : current);
											updatePreferences({ proxyMode: mode });
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "auto",
												children: t("proxyModeAuto")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "custom",
												children: t("proxyModeCustom")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "direct",
												children: t("proxyModeDirect")
											})
										]
									})]
								}),
								(preferences?.proxyMode ?? "auto") === "auto" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-codex-proxy-status",
									children: status?.detectedProxy ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [t("proxyDetected"), ":"] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
											className: "dsh-codex-proxy-tag",
											children: status.detectedProxy
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-codex-success",
											children: t("proxyDetectedEffective")
										})
									] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-codex-muted",
										children: t("proxyNoneDetected")
									})
								}) : null,
								preferences?.proxyMode === "direct" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-muted",
									style: { margin: "8px 0 0" },
									children: t("proxyDirectHint")
								}) : null,
								preferences?.proxyMode === "custom" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-context-settings",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("customProxyUrl") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("customProxyUrlHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-codex-context-row",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-codex-proxy-control",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												id: "dsh-codex-custom-proxy",
												type: "text",
												placeholder: t("customProxyUrlPlaceholder"),
												value: customProxyDraft ?? preferences?.customProxyUrl ?? "",
												disabled: busy !== null,
												"aria-label": t("customProxyUrl"),
												onChange: (event) => {
													setCustomProxyDraft(event.currentTarget.value);
												},
												onKeyDown: (event) => {
													if (event.key !== "Enter") return;
													event.preventDefault();
													updateCustomProxyUrl();
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												className: "dsh-codex-context-save",
												type: "button",
												"aria-label": t("saveProxyUrl"),
												disabled: busy !== null || customProxyDraft === null,
												onClick: () => void updateCustomProxyUrl(),
												children: t("save")
											})]
										})
									})]
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("enhancements"),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-pref-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("searchProvider") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("searchProviderHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-codex-segments",
										role: "group",
										"aria-label": t("searchProvider"),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: preferences?.searchProvider === "dsh" ? "active" : "",
											"aria-pressed": preferences?.searchProvider === "dsh",
											disabled: busy !== null,
											onClick: () => selectSearchProvider("dsh"),
											children: t("searchProviderDsh")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: preferences?.searchProvider === "codex" ? "active" : "",
											"aria-pressed": preferences?.searchProvider === "codex",
											disabled: busy !== null,
											onClick: () => selectSearchProvider("codex"),
											children: t("searchProviderCodex")
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-pref-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("outputVerbosity") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("outputVerbosityHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: "dsh-codex-select",
										"aria-label": t("outputVerbosity"),
										value: preferences?.outputVerbosity ?? "",
										disabled: busy !== null,
										onChange: (event) => {
											const value = event.currentTarget.value;
											updatePreferences({ outputVerbosity: value === "" ? null : value });
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: t("providerDefault")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "low",
												children: t("verbosityLow")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "medium",
												children: t("verbosityMedium")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "high",
												children: t("verbosityHigh")
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-pref-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("reasoningSummary") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("reasoningSummaryHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: "dsh-codex-select",
										"aria-label": t("reasoningSummary"),
										value: preferences?.reasoningSummary ?? "",
										disabled: busy !== null,
										onChange: (event) => {
											const value = event.currentTarget.value;
											updatePreferences({ reasoningSummary: value === "" ? null : value });
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: t("providerDefault")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "auto",
												children: t("summaryAuto")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "concise",
												children: t("summaryConcise")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "detailed",
												children: t("summaryDetailed")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "none",
												children: t("summaryNone")
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-pref-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("subagentMaxDepth") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("subagentMaxDepthHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: "dsh-codex-select",
										"aria-label": t("subagentMaxDepth"),
										value: preferences?.subagentMaxDepth === null || preferences?.subagentMaxDepth === void 0 ? "" : String(preferences.subagentMaxDepth),
										disabled: busy !== null,
										onChange: (event) => {
											const value = event.currentTarget.value;
											updatePreferences({ subagentMaxDepth: value === "" ? null : Number(value) });
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: t("providerDefault")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: "0",
												children: [
													"0 (",
													t("subagentDisabled"),
													")"
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: "1",
												children: ["1 ", t("levels")]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: "2",
												children: ["2 ", t("levels")]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: "3",
												children: ["3 ", t("levels")]
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-context-settings",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("subagentContextWindow") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("subagentContextWindowHint")
									})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-codex-context-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											htmlFor: "dsh-codex-subagent-context",
											children: t("subagentContextWindow")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-codex-capacity-control",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													id: "dsh-codex-subagent-context",
													type: "text",
													inputMode: "numeric",
													placeholder: t("providerDefault"),
													value: subagentContextDraft ?? (preferences?.subagentContextWindow ? formatCapacity$1(preferences.subagentContextWindow) : ""),
													disabled: busy !== null,
													"aria-label": t("subagentContextWindow"),
													onChange: (event) => {
														setSubagentContextDraft(event.currentTarget.value);
													},
													onKeyDown: (event) => {
														if (event.key !== "Enter") return;
														event.preventDefault();
														updateSubagentContextWindow();
													}
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("tokens") }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													className: "dsh-codex-context-save",
													type: "button",
													"aria-label": t("save") + " " + t("subagentContextWindow"),
													disabled: busy !== null || subagentContextDraft === null,
													onClick: () => void updateSubagentContextWindow(),
													children: t("save")
												})
											]
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-codex-context-settings",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("contextWindows") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dsh-codex-muted",
										children: t("contextWindowsHint")
									})] }), CONFIGURABLE_CONTEXT_MODEL_IDS.map((model) => {
										const entry = resolveCodexCatalogEntry(model);
										const fallback = preferences?.contextWindowOverrides?.[model] ?? entry.contextWindow;
										const draft = contextDrafts[model];
										const parsedDraft = draft === void 0 ? fallback : parseCapacity(draft, contextWindowLimitForModel(model));
										const dirty = draft !== void 0 && parsedDraft !== fallback;
										const inputId = `dsh-codex-context-${model}`;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-codex-context-row",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
												htmlFor: inputId,
												children: entry.name
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dsh-codex-capacity-control",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														id: inputId,
														type: "text",
														inputMode: "numeric",
														value: draft ?? formatCapacity$1(fallback),
														disabled: busy !== null,
														"aria-label": entry.name + " " + t("contextWindow"),
														onChange: (event) => {
															const value = event.currentTarget.value;
															setContextDrafts((drafts) => ({
																...drafts,
																[model]: value
															}));
														},
														onKeyDown: (event) => {
															if (event.key !== "Enter" || !dirty) return;
															event.preventDefault();
															updateContextWindow(model);
														}
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("tokens") }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														className: "dsh-codex-context-save",
														type: "button",
														"data-model": model,
														"aria-label": entry.name + " " + t("saveContextWindow"),
														disabled: busy !== null || !dirty,
														onClick: () => void updateContextWindow(model),
														children: t("save")
													})
												]
											})]
										}, model);
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "dsh-codex-check",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: preferences?.fastMode === true,
										disabled: busy !== null,
										onChange: (event) => updatePreferences({ fastMode: event.currentTarget.checked })
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("fastMode") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("fastModeHint") })] })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "dsh-codex-check",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: preferences?.quickQuotaVisible === true,
										disabled: busy !== null,
										onChange: (event) => updatePreferences({ quickQuotaVisible: event.currentTarget.checked })
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("quickQuota") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("quickQuotaHint") })] })]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
							title: t("quota"),
							aside: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
								disabled: !status?.authenticated || busy !== null,
								onClick: refreshQuota,
								children: busy === "quota" ? t("refreshing") : t("refreshQuota")
							}),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-muted",
									children: t("quotaIntro")
								}),
								quota?.state === "signed-out" || !status?.authenticated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-empty",
									children: t("quotaSignedOut")
								}) : null,
								quota?.buckets?.map((bucket) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBucket, {
									bucket,
									t
								}, bucket.id)),
								quota?.credits !== null && quota?.credits !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaFact, {
									label: t("credits"),
									value: quota.credits.unlimited ? t("unlimited") : quota.credits.balance ?? (quota.credits.hasCredits ? t("available") : t("unavailable"))
								}) : null,
								quota?.individualLimit !== null && quota?.individualLimit !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaFact, {
									label: t("monthlySpend"),
									value: individualLimitLabel(quota.individualLimit, t)
								}) : null,
								quota?.resetCredits !== null && quota?.resetCredits !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ResetCreditsFact, {
									resetCredits: quota.resetCredits,
									busy,
									onUse: useResetCredit,
									t
								}) : null,
								resetCreditNotice !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-success",
									role: "status",
									children: resetCreditNotice
								}) : null,
								quota?.spendControlReached === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-warning",
									role: "status",
									children: t("spendControlReached")
								}) : null,
								quota?.state === "empty" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-empty",
									children: t("noQuota")
								}) : null,
								quota?.stale ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-warning",
									role: "status",
									children: t("stale")
								}) : null,
								quota?.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-error",
									role: "alert",
									children: quota.error.message
								}) : null,
								quota?.fetchedAt ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "dsh-codex-timestamp",
									children: [
										t("updated"),
										": ",
										formatDate$1(quota.fetchedAt)
									]
								}) : null
							]
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsh-codex-sr",
						"aria-live": "polite",
						children: busy === null ? "" : busy
					})
				]
			});
		}
		function Section({ title, aside, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dsh-codex-group",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-codex-grouphead",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: title }), aside]
				}), children]
			});
		}
		function Button({ primary = false, disabled, onClick, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				className: `dsh-codex-button${primary ? " dsh-codex-button-primary" : ""}`,
				type: "button",
				disabled,
				onClick: () => void onClick(),
				children
			});
		}
		function InfoRow({ label, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-codex-row",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-codex-label",
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-codex-value",
					children: value
				})]
			});
		}
		function storageLabel(storage, t) {
			if (storage === void 0 || !storage.available) return t("storageUnavailable");
			if (storage.kind === "windows-dpapi") return t("storageWindows");
			if (storage.kind === "macos-keychain") return t("storageMacKeychain");
			if (storage.kind === "linux-file") return t("storageLinuxFile");
			if (storage.kind === "memory") return t("storageMemory");
			return t("storageUnavailable");
		}
		function storageNotice(storage, t) {
			if (storage === void 0 || !storage.available) return t("securityUnavailable");
			if (storage.kind === "windows-dpapi") return t("securityWindows");
			if (storage.kind === "macos-keychain") return t("securityMacKeychain");
			if (storage.kind === "linux-file") return t("securityLinuxFile");
			if (storage.kind === "memory") return t("securityMemory");
			return t("securityUnavailable");
		}
		function QuotaBucket({ bucket, t }) {
			const windows = quotaWindows(bucket);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: "dsh-codex-quota-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-codex-quota-title",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: bucket.name }), bucket.planType ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: bucket.planType }) : null]
				}), windows.map((window, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
					label: windowLabel(window.windowDurationMins, t),
					window,
					t
				}, `${window.windowDurationMins ?? "x"}:${window.resetsAt ?? "x"}:${index}`))]
			});
		}
		function QuotaFact({ label, value }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-codex-quota-fact",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: value })]
			});
		}
		function ResetCreditsFact({ resetCredits, busy, onUse, t }) {
			const available = resetCredits.availableCount > 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-codex-reset-credits",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-codex-reset-credits-info",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("resetCredits") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: resetCredits.availableCount }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
							t("resetCreditExpires"),
							": ",
							resetCredits.expiresAt == null ? t("unknown") : formatReset(resetCredits.expiresAt)
						] })
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
					primary: true,
					disabled: !available || busy !== null,
					onClick: onUse,
					children: busy === "reset-credit" ? t("usingResetCredit") : t("useResetCredit")
				})]
			});
		}
		function QuotaBar({ label, window, t }) {
			const percent = typeof window?.usedPercent === "number" && Number.isFinite(window.usedPercent) ? window.usedPercent : 0;
			const level = percent >= 95 ? "danger" : percent >= 80 ? "warning" : "normal";
			const remaining = Math.max(0, 100 - percent);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-codex-meter-wrap",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-codex-meter-label",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: formatPercent(percent) })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: `dsh-codex-meter dsh-codex-meter-${level}`,
						role: "progressbar",
						"aria-label": `${label}: ${formatPercent(percent)} ${t("used")}`,
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-valuenow": percent,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { width: `${Math.min(100, Math.max(0, percent))}%` } })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-codex-meter-meta",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: percent >= 100 ? `${t("exhausted")} · ${formatPercent(remaining)} ${t("remaining")}` : `${formatPercent(percent)} ${t("used")} · ${formatPercent(remaining)} ${t("remaining")}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: window?.resetsAt == null ? "—" : `${t("resets")}: ${formatReset(window.resetsAt)}` })]
					})
				]
			});
		}
		function Skeleton({ label }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-codex-skeleton",
				role: "status",
				"aria-label": label,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {})]
			});
		}
		function windowLabel(minutes, t) {
			if (minutes === null || minutes === void 0 || typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return t("limitWindow");
			const [value, unit] = minutes >= 1440 && minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes >= 60 && minutes % 60 === 0 ? [minutes / 60, "hour"] : [Math.round(minutes), "minute"];
			try {
				return `${new Intl.NumberFormat(void 0, {
					style: "unit",
					unit,
					unitDisplay: "long"
				}).format(value)} ${t("limitWindow")}`;
			} catch {
				return `${value} ${t("limitWindow")}`;
			}
		}
		function parsePositiveCapacity$1(value) {
			const matched = value.trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?$/);
			if (matched === null) return null;
			const multiplier = matched[2] === "m" ? 1e6 : matched[2] === "k" ? 1e3 : 1;
			const parsed = Number(matched[1]) * multiplier;
			return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
		}
		function parseCapacity(value, maxContextWindow = GPT_56_MAX_CONTEXT_WINDOW) {
			const parsed = parsePositiveCapacity$1(value);
			return parsed !== null && parsed <= maxContextWindow ? parsed : null;
		}
		function formatCapacity$1(value) {
			if (value % 1e3 === 0) return `${value / 1e3}K`;
			return String(value);
		}
		function formatPercent(value) {
			if (value === void 0 || value === null || typeof value !== "number" || !Number.isFinite(value)) return "0%";
			try {
				return `${new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(value)}%`;
			} catch {
				return `${value}%`;
			}
		}
		function individualLimitLabel(limit, t) {
			const parts = [
				limit.remainingPercent !== null && limit.remainingPercent !== void 0 ? `${formatPercent(limit.remainingPercent)} ${t("remaining")}` : null,
				limit.limit !== null && limit.limit !== void 0 ? `${t("limit")}: ${limit.limit}` : null,
				limit.used !== null && limit.used !== void 0 ? `${t("used")}: ${limit.used}` : null,
				limit.resetsAt !== null && limit.resetsAt !== void 0 ? `${t("resets")}: ${formatReset(limit.resetsAt)}` : null
			].filter((part) => part !== null);
			return parts.length > 0 ? parts.join(" · ") : t("unknown");
		}
		function formatDate$1(seconds) {
			if (seconds === void 0 || seconds === null || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
			const ms = seconds > 1e10 ? seconds : seconds * 1e3;
			try {
				return new Intl.DateTimeFormat(void 0, {
					dateStyle: "medium",
					timeStyle: "short"
				}).format(ms);
			} catch {
				return "—";
			}
		}
		function formatReset(seconds) {
			if (seconds === void 0 || seconds === null || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
			const ms = seconds > 1e10 ? seconds : seconds * 1e3;
			const absolute = formatDate$1(seconds);
			const diff = ms - Date.now();
			const abs = Math.abs(diff);
			const [amount, unit] = abs >= 864e5 ? [Math.round(diff / 864e5), "day"] : abs >= 36e5 ? [Math.round(diff / 36e5), "hour"] : [Math.round(diff / 6e4), "minute"];
			try {
				return `${absolute} (${new Intl.RelativeTimeFormat(void 0, { numeric: "auto" }).format(amount, unit)})`;
			} catch {
				return absolute;
			}
		}
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		//#endregion
		//#region src/client/locales.ts
		const NS = "dsh-chatgpt-subscription";
		const dictionaries$1 = {
			zh: {
				title: "ChatGPT",
				intro: "使用 ChatGPT 账号登录，在 DSH 中使用订阅可用的模型。",
				account: "账号",
				signedOut: "尚未登录",
				signedIn: "已登录",
				plan: "套餐",
				accountId: "账号 ID",
				expires: "令牌到期",
				storage: "凭据存储",
				storageWindows: "Windows DPAPI（当前用户加密）",
				storageMacKeychain: "macOS 钥匙串（Keychain 加密）",
				storageLinuxFile: "Linux 用户私有文件（权限 0600）",
				storageMemory: "仅 Host 内存（不持久化）",
				storageUnavailable: "凭据存储不可用",
				securityWindows: "令牌由 Host 使用 Windows CurrentUser DPAPI 加密，不会进入浏览器、settings.yaml 或日志。",
				securityMacKeychain: "令牌由 Host 存入 macOS 登录钥匙串（Keychain），在本机加密保存，不会进入浏览器、settings.yaml 或日志。",
				securityLinuxFile: "令牌仅写入 Host 上当前 Linux 用户可读的 0600 文件，但不会额外加密；同 UID 进程、root、备份和磁盘快照仍可能读取。",
				securityMemory: "令牌仅保留在 Host 内存中，Host 退出后丢失。",
				securityUnavailable: "Host 无法安全访问凭据存储；请修复文件所有者或权限后重试。",
				signIn: "使用 ChatGPT 登录",
				signInAgain: "重新登录",
				cancel: "取消登录",
				signOut: "注销",
				refreshToken: "刷新凭据",
				pending: "请在浏览器中完成登录。",
				popupBlocked: "浏览器拦截了登录窗口，请使用下面的链接继续。",
				continueLogin: "打开 ChatGPT 登录页",
				loading: "正在读取状态…",
				connection: "连接",
				provider: "Provider",
				connectionState: "连接状态",
				connected: "可用",
				untested: "尚未测试",
				testConnection: "测试连接",
				testing: "测试中…",
				latency: "最近延迟",
				models: "可用模型",
				modelsHint: "勾选后模型才会显示在对话页的模型选择列表中；至少保留一个。",
				proxySettings: "网络代理",
				proxyMode: "代理模式",
				proxyModeHint: "GPT 与 Antigravity（Gemini）共用此代理设置；支持自动读取系统代理，修改后对后续请求生效。",
				proxyModeAuto: "系统代理（自动检测）",
				proxyModeCustom: "自定义代理",
				proxyModeDirect: "直连（禁用代理）",
				customProxyUrl: "自定义代理地址",
				customProxyUrlHint: "支持 HTTP/HTTPS/SOCKS5 代理地址，例如 http://127.0.0.1:7890",
				customProxyUrlPlaceholder: "例如: http://127.0.0.1:7890",
				saveProxyUrl: "保存代理地址",
				proxyDetected: "检测到系统代理",
				proxyDetectedEffective: "（已自动生效）",
				proxyNoneDetected: "未检测到系统代理，将使用直连",
				proxyDirectHint: "所有网络请求将直接连接，不经过任何代理服务器。",
				enhancements: "增强功能",
				fastMode: "快速模式（1.5x 速度）",
				fastModeHint: "提升 Token 生成速度至约 1.5 倍；将以约 2x–2.5x 速度消耗 Codex 订阅额度。",
				outputVerbosity: "输出详细程度",
				outputVerbosityHint: "控制 Codex 最终回答的详细程度；不影响思考深度。",
				verbosityLow: "低（保持回答简洁）",
				verbosityMedium: "中（兼顾细节与简洁）",
				verbosityHigh: "高（在回答中包含更多细节）",
				reasoningSummary: "推理摘要",
				reasoningSummaryHint: "选择 ChatGPT 总结其推理的方式；不影响思考深度。",
				summaryAuto: "自动（让模型选择摘要详细程度）",
				summaryConcise: "简洁（显示简要推理摘要）",
				summaryDetailed: "详细（显示更详细的推理摘要）",
				summaryNone: "无（不显示推理摘要）",
				searchProvider: "搜索与抓取来源",
				searchProviderHint: "选择 DSH 联网工具使用默认来源，或改用当前 ChatGPT 订阅的 Codex 来源（自动走代理隧道）。",
				searchProviderDsh: "DSH 默认",
				searchProviderCodex: "ChatGPT（代理隧道）",
				providerDefault: "使用 Provider 默认值",
				subagentEnhancements: "子代理设置",
				subagentContextWindow: "子代理上下文预算",
				subagentContextWindowHint: "限制子代理运行时的最大上下文 Token 数（例如 128K、256K）；留空跟随模型主设置。",
				subagentMaxDepth: "子代理最大嵌套深度",
				subagentMaxDepthHint: "限制子代理的递归层级（0–3）；0 禁止创建子代理。",
				subagentDisabled: "已禁用",
				levels: "层",
				contextWindows: "模型上下文窗口",
				contextWindowsHint: "默认 272K；6 Astra 最高 872K，GPT-5.6 最高 1M。该值用于 DSH 的压缩与溢出判断，可输入 872K、512K 等容量。",
				contextWindow: "上下文窗口",
				contextWindowInvalid: "上下文窗口必须是正整数，且不能超过模型上限（6 Astra 为 872K，GPT-5.6 为 1M）；可使用 K 或 M 后缀。",
				saveContextWindow: "保存上下文窗口",
				save: "保存",
				tokens: "tokens",
				quickQuota: "在输入框旁显示快捷用量",
				quickQuotaHint: "仅在当前会话选中 codex-chatgpt 模型时显示。",
				quota: "用量与限额",
				quotaIntro: "数据来自 ChatGPT Codex 用量服务。页面可见时最多每 60 秒刷新一次。",
				refreshQuota: "刷新用量",
				refreshing: "刷新中…",
				noQuota: "当前套餐未返回可显示的限额窗口。",
				quotaSignedOut: "登录后可查看订阅限额。",
				stale: "显示的是上次成功获取的数据。",
				updated: "更新时间",
				primary: "主要窗口",
				secondary: "次要窗口",
				limitWindow: "额度",
				used: "已使用",
				remaining: "剩余",
				available: "可用",
				unavailable: "不可用",
				unlimited: "无限",
				credits: "Credits",
				monthlySpend: "月度消费控制",
				resetCredits: "重置次数",
				resetCreditExpires: "到期时间",
				useResetCredit: "使用重置卡",
				usingResetCredit: "使用中…",
				useResetCreditConfirm: "使用后会立即消耗 1 次重置机会，并重置符合条件的 Codex 额度窗口。确定继续吗？",
				resetCreditUsed: "重置卡已使用，用量数据已刷新。",
				spendControlReached: "已触发月度消费控制，新的订阅调用可能被限制。",
				limit: "上限",
				exhausted: "额度已用尽",
				resets: "重置",
				quickQuotaLabel: "Codex 剩余",
				quickQuotaLoading: "用量…",
				imageToolRunning: "正在生成图片",
				imageToolDone: "已生成图片",
				imageToolFailed: "图片生成失败",
				image: "图片",
				openImage: "打开图片",
				openNamedImage: "打开 {name}",
				imageLoading: "加载图片…",
				imageLoadFailed: "图片加载失败，点击重试",
				imagePreviewClose: "关闭",
				imagePreviewOpenOriginal: "打开原图",
				retry: "重试",
				unknown: "未知"
			},
			en: {
				title: "ChatGPT",
				intro: "Sign in with ChatGPT to use models available to your subscription in DSH.",
				account: "Account",
				signedOut: "Not signed in",
				signedIn: "Signed in",
				plan: "Plan",
				accountId: "Account ID",
				expires: "Token expires",
				storage: "Credential storage",
				storageWindows: "Windows DPAPI (current-user encrypted)",
				storageMacKeychain: "macOS Keychain (encrypted)",
				storageLinuxFile: "Linux user-private file (mode 0600)",
				storageMemory: "Host memory only (not persistent)",
				storageUnavailable: "Credential storage unavailable",
				securityWindows: "The Host encrypts tokens with Windows CurrentUser DPAPI; they never enter the browser, settings.yaml, or logs.",
				securityMacKeychain: "The Host stores tokens in the macOS login Keychain, encrypted on this machine; they never enter the browser, settings.yaml, or logs.",
				securityLinuxFile: "Tokens are stored in a mode-0600 file readable only by the current Linux user, but are not additionally encrypted; same-UID processes, root, backups, and disk snapshots can still read them.",
				securityMemory: "Tokens remain only in Host memory and are lost when the Host exits.",
				securityUnavailable: "The Host cannot safely access credential storage. Fix the file owner or permissions and retry.",
				signIn: "Sign in with ChatGPT",
				signInAgain: "Sign in again",
				cancel: "Cancel sign-in",
				signOut: "Sign out",
				refreshToken: "Refresh credentials",
				pending: "Complete sign-in in your browser.",
				popupBlocked: "The sign-in window was blocked. Use the link below to continue.",
				continueLogin: "Open ChatGPT sign-in",
				loading: "Reading status…",
				connection: "Connection",
				provider: "Provider",
				connectionState: "Connection status",
				connected: "Available",
				untested: "Not tested",
				testConnection: "Test connection",
				testing: "Testing…",
				latency: "Last latency",
				models: "Available models",
				modelsHint: "Checked models appear in the conversation model picker; at least one must remain enabled.",
				proxySettings: "Network Proxy",
				proxyMode: "Proxy Mode",
				proxyModeHint: "GPT and Antigravity (Gemini) share these proxy settings. Supports system proxy detection; changes apply to subsequent requests.",
				proxyModeAuto: "System Proxy (Auto-detect)",
				proxyModeCustom: "Custom Proxy",
				proxyModeDirect: "Direct (No Proxy)",
				customProxyUrl: "Custom Proxy URL",
				customProxyUrlHint: "Supports HTTP/HTTPS/SOCKS5 proxy URLs, e.g. http://127.0.0.1:7890",
				customProxyUrlPlaceholder: "e.g. http://127.0.0.1:7890",
				saveProxyUrl: "Save Proxy URL",
				proxyDetected: "Detected system proxy",
				proxyDetectedEffective: " (active)",
				proxyNoneDetected: "No system proxy detected; connecting directly",
				proxyDirectHint: "All requests connect directly without using any proxy server.",
				enhancements: "Enhancements",
				fastMode: "Fast mode (1.5x speed)",
				fastModeHint: "Generates tokens ~1.5x faster; consumes Codex subscription quota at ~2x–2.5x the normal rate.",
				outputVerbosity: "Output verbosity",
				outputVerbosityHint: "Controls the detail level of final Codex answers without changing reasoning effort.",
				verbosityLow: "Low (keep answers concise)",
				verbosityMedium: "Medium (balance detail and brevity)",
				verbosityHigh: "High (include more detail)",
				reasoningSummary: "Reasoning summary",
				reasoningSummaryHint: "Controls how ChatGPT summarizes its chain of thought; does not change reasoning depth.",
				summaryAuto: "Auto (let model determine detail)",
				summaryConcise: "Concise (brief summary)",
				summaryDetailed: "Detailed (in-depth summary)",
				summaryNone: "None (hide reasoning summary)",
				searchProvider: "Search & Fetch provider",
				searchProviderHint: "Choose whether DSH web tools use the default provider or the Codex proxy-backed source from this ChatGPT subscription.",
				searchProviderDsh: "DSH default",
				searchProviderCodex: "ChatGPT (Proxy tunnel)",
				providerDefault: "Use provider default",
				subagentEnhancements: "Subagent settings",
				subagentContextWindow: "Subagent context window budget",
				subagentContextWindowHint: "Limits context capacity in tokens for subagents (e.g. 128K, 256K); leave empty to follow main model settings.",
				subagentMaxDepth: "Subagent maximum nesting depth",
				subagentMaxDepthHint: "Limits child levels for subagents (0–3); 0 disables subagents.",
				subagentDisabled: "Disabled",
				levels: "levels",
				contextWindows: "Model context windows",
				contextWindowsHint: "Defaults to 272K, with up to 872K for 6 Astra and 1M for GPT-5.6. DSH uses it for compaction and overflow detection; values such as 872K and 512K are accepted.",
				contextWindow: "Context window",
				contextWindowInvalid: "The context window must be a positive integer within the model limit (872K for 6 Astra, 1M for GPT-5.6). K and M suffixes are accepted.",
				saveContextWindow: "Save context window",
				save: "Save",
				tokens: "tokens",
				quickQuota: "Show quick usage beside the composer",
				quickQuotaHint: "Shown only when the current session uses a codex-chatgpt model.",
				quota: "Usage and limits",
				quotaIntro: "Data comes from the ChatGPT Codex usage service and refreshes at most once per minute while visible.",
				refreshQuota: "Refresh usage",
				refreshing: "Refreshing…",
				noQuota: "Your plan did not return any displayable limit windows.",
				quotaSignedOut: "Sign in to view subscription limits.",
				stale: "Showing the last successfully fetched data.",
				updated: "Updated",
				primary: "Primary window",
				secondary: "Secondary window",
				limitWindow: "limit",
				used: "used",
				remaining: "remaining",
				available: "Available",
				unavailable: "Unavailable",
				unlimited: "Unlimited",
				credits: "Credits",
				monthlySpend: "Monthly spend control",
				resetCredits: "Reset credits",
				resetCreditExpires: "Expires",
				useResetCredit: "Use reset credit",
				usingResetCredit: "Using…",
				useResetCreditConfirm: "This immediately spends one reset credit and resets eligible Codex limit windows. Continue?",
				resetCreditUsed: "The reset credit was used and usage data was refreshed.",
				spendControlReached: "Monthly spend control has been reached; new subscription calls may be limited.",
				limit: "Limit",
				exhausted: "Quota exhausted",
				resets: "Resets",
				quickQuotaLabel: "Codex left",
				quickQuotaLoading: "Usage…",
				imageToolRunning: "Generating image",
				imageToolDone: "Generated image",
				imageToolFailed: "Image generation failed",
				image: "Image",
				openImage: "Open image",
				openNamedImage: "Open {name}",
				imageLoading: "Loading image…",
				imageLoadFailed: "Image failed to load. Click to retry",
				imagePreviewClose: "Close",
				imagePreviewOpenOriginal: "Open original",
				retry: "Retry",
				unknown: "Unknown"
			}
		};
		//#endregion
		//#region src/client/styles.ts
		const STYLE_ID$1 = "@eddyskywalker/dsh-chatgpt-subscription/main";
		const CSS = `
.dsh-codex-page{box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;max-width:780px;min-width:0;padding:2px 0 30px}
.dsh-codex-page *{box-sizing:border-box}
.dsh-codex-title{font-size:15px;font-weight:650;line-height:1.4;margin:0 0 5px}
.dsh-codex-intro,.dsh-codex-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin:0}
.dsh-codex-group{border-top:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.dsh-codex-grouphead{align-items:center;display:flex;gap:12px;justify-content:space-between;min-height:48px}
.dsh-codex-grouphead h3{font-size:14px;font-weight:650;margin:0}
.dsh-codex-row{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:20px;justify-content:space-between;min-height:44px;padding:8px 0}
.dsh-codex-label{color:var(--dsw-alias-label-secondary);font-size:13px;flex:0 0 auto}
.dsh-codex-value{font-size:13px;min-width:0;overflow-wrap:anywhere;text-align:right}
.dsh-codex-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding-top:12px}
.dsh-codex-button{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:8px 13px;white-space:nowrap}
.dsh-codex-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-codex-button:focus-visible,.dsh-codex-link:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-button:disabled{cursor:default;opacity:.5}
.dsh-codex-button-primary{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsh-codex-notice{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;margin:12px 0 0;padding:10px 12px}
.dsh-codex-error,.dsh-codex-warning,.dsh-codex-success{font-size:12px;line-height:1.5;margin:8px 0 0}
.dsh-codex-error{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-warning{color:var(--dsw-alias-label-warning,#c77a18)}
.dsh-codex-success{color:var(--dsw-alias-label-success,#2e9b62)}
.dsh-codex-errorbar{align-items:center;background:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 9%,transparent);border:0.5px solid color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 28%,transparent);border-radius:7px;color:var(--dsw-alias-label-danger,#d94b4b);display:flex;font-size:13px;gap:12px;justify-content:space-between;padding:10px 12px}
.dsh-codex-link{color:var(--dsw-alias-label-link,#3278d4);display:inline-block;font-size:13px;margin-top:8px}
.dsh-codex-models-hint{padding-top:10px}
.dsh-codex-models{display:flex;flex-wrap:wrap;gap:7px;padding-top:8px}
.dsh-codex-models label{cursor:pointer;display:block;position:relative}
.dsh-codex-models input{position:absolute;opacity:0;pointer-events:none}
.dsh-codex-models span{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:5px 8px}
.dsh-codex-models input:checked+span{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 14%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 55%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.dsh-codex-models input:focus-visible+span{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-models input:disabled+span{cursor:default;opacity:.5}
.dsh-codex-pref-row{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:16px;justify-content:space-between;min-height:58px;padding:10px 0}
.dsh-codex-pref-row strong,.dsh-codex-check strong{display:block;font-size:13px;font-weight:600;line-height:1.35}
.dsh-codex-segments{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;display:inline-flex;flex-wrap:nowrap;gap:3px;padding:3px}
.dsh-codex-segments label{cursor:pointer;display:block;margin:0}
.dsh-codex-segments input{position:absolute;opacity:0;pointer-events:none}
.dsh-codex-segments span,.dsh-codex-segments button{border:0.5px solid transparent;border-radius:6px;color:var(--dsw-alias-label-secondary);display:block;font:inherit;font-size:12px;font-weight:500;line-height:1.2;padding:6px 12px;transition:all .15s ease;user-select:none;white-space:nowrap}
.dsh-codex-segments button{background:transparent;cursor:pointer}
.dsh-codex-segments label:hover span,.dsh-codex-segments button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-codex-segments input:checked+span,.dsh-codex-segments button.active,.dsh-codex-segments button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 22%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 60%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.dsh-codex-segments input:focus-visible+span,.dsh-codex-segments button:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-segments input:disabled+span,.dsh-codex-segments button:disabled{cursor:default;opacity:.5}
.dsh-codex-select,.dsh-codex-capacity-control input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 9px}
.dsh-codex-select{max-width:210px;min-width:150px}
.dsh-codex-context-settings{border-bottom:0.5px solid var(--dsw-alias-border-l2);display:grid;gap:10px;padding:12px 0}
.dsh-codex-context-settings>div>strong{font-size:13px;font-weight:600}
.dsh-codex-context-row{align-items:center;display:flex;font-size:12px;gap:14px;justify-content:space-between}
.dsh-codex-proxy-control{align-items:center;display:flex;gap:8px;width:100%}
.dsh-codex-proxy-control input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);flex:1;font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;min-width:220px;padding:7px 10px;text-align:left}
.dsh-codex-proxy-status{align-items:center;color:var(--dsw-alias-label-secondary);display:flex;flex-wrap:wrap;font-size:12px;gap:6px;margin:6px 0 0}
.dsh-codex-proxy-tag{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 18%,transparent);border:0.5px solid color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 45%,transparent);border-radius:4px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:2px 6px}
.dsh-codex-capacity-control{align-items:center;display:flex;gap:7px}
.dsh-codex-capacity-control input{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-align:right;width:90px}
.dsh-codex-capacity-control input[type=number]{width:110px}
.dsh-codex-capacity-control small{color:var(--dsw-alias-label-tertiary);font-size:11px;width:42px}
.dsh-codex-context-save{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:1;padding:8px 10px;white-space:nowrap}
.dsh-codex-context-save:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-codex-context-save:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-context-save:disabled{cursor:default;opacity:.45}
.dsh-codex-check{align-items:flex-start;border-bottom:0.5px solid var(--dsw-alias-border-l2);cursor:pointer;display:flex;gap:10px;padding:12px 0}
.dsh-codex-check input{flex:none;margin-top:2px}
.dsh-codex-check small{color:var(--dsw-alias-label-secondary);display:block;font-size:12px;line-height:1.45;margin-top:2px}
.dsh-codex-quota-card{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:12px;padding:12px}
.dsh-codex-quota-title{align-items:center;display:flex;font-size:13px;gap:8px;justify-content:space-between}
.dsh-codex-quota-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase}
.dsh-codex-quota-fact{align-items:flex-start;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;font-size:12px;gap:12px;justify-content:space-between;line-height:1.45;padding:10px 0}
.dsh-codex-quota-fact span{color:var(--dsw-alias-label-secondary);flex:none}
.dsh-codex-quota-fact strong{font-weight:600;min-width:0;overflow-wrap:anywhere;text-align:right}
.dsh-codex-reset-credits{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:16px;justify-content:space-between;padding:10px 0}
.dsh-codex-reset-credits-info{display:grid;font-size:12px;gap:2px;grid-template-columns:auto auto}
.dsh-codex-reset-credits-info>span{color:var(--dsw-alias-label-secondary)}
.dsh-codex-reset-credits-info>strong{font-weight:650;text-align:right}
.dsh-codex-reset-credits-info>small{color:var(--dsw-alias-label-tertiary);font-size:11px;grid-column:1/-1}
.dsh-codex-meter-wrap{margin-top:13px}
.dsh-codex-meter-label,.dsh-codex-meter-meta{display:flex;gap:10px;justify-content:space-between}
.dsh-codex-meter-label{font-size:12px;margin-bottom:6px}
.dsh-codex-meter-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45;margin-top:6px}
.dsh-codex-meter{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.15));border-radius:999px;corner-shape:round;height:7px;overflow:hidden;width:100%}
.dsh-codex-meter>span{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:inherit;display:block;height:100%;max-width:100%;min-width:0;transition:width .25s ease}
.dsh-codex-meter-warning>span{background:var(--dsw-alias-label-warning,#d58a24)}
.dsh-codex-meter-danger>span{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-empty{border:0.5px dashed var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin:12px 0 0;padding:16px;text-align:center}
.dsh-codex-timestamp{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:10px 0 0;text-align:right}
.dsh-codex-skeleton{display:grid;gap:9px;padding-top:10px}
.dsh-codex-skeleton span{animation:dsh-codex-pulse 1.4s ease-in-out infinite;background:var(--dsw-alias-bg-layer-2);border-radius:5px;height:42px}
.dsh-codex-skeleton span:nth-child(2){animation-delay:.12s}.dsh-codex-skeleton span:nth-child(3){animation-delay:.24s}
.dsh-codex-sr{height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;clip:rect(0 0 0 0);white-space:nowrap}
.dsh-codex-composer-quota{align-items:center;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-secondary);display:inline-flex;font-size:11px;gap:6px;height:28px;line-height:1;max-width:160px;padding:0 9px;white-space:nowrap}
.dsh-codex-composer-quota strong{color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650}
.dsh-codex-composer-quota[data-level=warning] strong{color:var(--dsw-alias-label-warning,#d58a24)}
.dsh-codex-composer-quota[data-level=danger] strong{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-image-tool{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex-direction:column;gap:8px;margin:4px 0 4px 4px;max-width:520px;padding:10px 12px}
.dsh-codex-image-tool-head{align-items:center;display:flex;font-size:13px;gap:8px;min-width:0}
.dsh-codex-image-dot{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:50%;corner-shape:round;display:inline-block;flex:none;height:8px;width:8px}
.dsh-codex-image-tool[data-state=error] .dsh-codex-image-dot{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-image-title{font-weight:600}
.dsh-codex-image-summary{color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-codex-image-grid{display:flex;flex-wrap:wrap;gap:8px}
.dsh-codex-image-preview{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;display:block;max-height:260px;max-width:min(100%,360px);object-fit:contain}
.dsh-codex-image-loading,.dsh-codex-image-failed{border:0.5px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);display:inline-flex;font-size:12px;line-height:1.4;padding:18px 20px}
.dsh-codex-image-failed{color:var(--dsw-alias-label-danger,#d94b4b)}
@keyframes dsh-codex-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media(max-width:560px){.dsh-codex-row,.dsh-codex-pref-row,.dsh-codex-quota-fact,.dsh-codex-reset-credits{align-items:flex-start;flex-direction:column;gap:3px}.dsh-codex-value,.dsh-codex-quota-fact strong{text-align:left}.dsh-codex-actions{justify-content:flex-start}.dsh-codex-grouphead{align-items:flex-start;flex-direction:column;gap:0;padding:12px 0}.dsh-codex-meter-meta{align-items:flex-start;flex-direction:column;gap:2px}.dsh-codex-errorbar{align-items:flex-start;flex-direction:column}.dsh-codex-segments{width:100%}.dsh-codex-select{max-width:none;width:100%}.dsh-codex-context-row{align-items:flex-start;flex-direction:column;gap:5px}.dsh-codex-segments label{flex:1}.dsh-codex-segments span{text-align:center}.dsh-codex-image-tool{max-width:100%;margin-left:0}}
@media(prefers-reduced-motion:reduce){.dsh-codex-meter>span{transition:none}.dsh-codex-skeleton span{animation:none}}
`;
		function installStyles() {
			if (document.querySelector(`style[data-plugin-css="${STYLE_ID$1}"]`) !== null) return () => void 0;
			const element = document.createElement("style");
			element.dataset.plugin = "@eddyskywalker/dsh-chatgpt-subscription";
			element.dataset.pluginCss = STYLE_ID$1;
			element.textContent = CSS;
			document.head.appendChild(element);
			return () => element.remove();
		}
		//#endregion
		//#region src/client/antigravity/locales.ts
		const NS_ANTIGRAVITY = "dsh-antigravity";
		const zh = {
			title: "Antigravity",
			pageDesc: "登录 Google Antigravity / Cloud Code Assist，并查看当前账号的共享额度。",
			account: "已登录",
			signedIn: "已登录",
			signedOut: "未登录",
			plan: "套餐",
			accountId: "账号 ID",
			expires: "令牌到期",
			storage: "凭据存储",
			storageNotice: "令牌由 Host 保存于本地安全存储 ($DSH_HOME/storages/antigravity-oauth.json)，不会进入浏览器。",
			signInAgain: "重新登录",
			refreshToken: "刷新凭据",
			signOut: "注销",
			signIn: "登录",
			signingIn: "登录中...",
			connection: "连接",
			provider: "Provider",
			providerValue: "Google Antigravity · antigravity",
			connectionState: "连接状态",
			connected: "已连接",
			untested: "未测试",
			modelsHint: "勾选后模型才会显示在对话页的模型选择列表中；至少保留一个。",
			selectAll: "全选",
			unselectAll: "全不选",
			enhanced: "增强功能",
			defaultReasoningEffort: "默认思考深度",
			defaultReasoningEffortHint: "控制支持推理的模型在未单独指定时的思考强度。",
			defaultEffortAuto: "使用 Provider 默认值",
			contextWindowSection: "模型上下文窗口",
			contextWindowHint: "默认按模型标准；可选应用最高容量，该值用于 DSH 的压缩与溢出判断，可输入 1M、512K、200K 等容量。",
			save: "保存",
			saved: "已保存",
			saving: "保存中...",
			quotaSection: "用量与配额",
			quotaDesc: "数据来自 Google Cloud Code Assist 配额服务，页面可见时最多每 60 秒刷新一次。",
			refreshQuota: "刷新用量",
			refreshingQuota: "刷新中...",
			resetPrefix: "重置: {time}",
			resetUnavailable: "重置: n/a",
			resetNow: "现在",
			timeDayHour: "{days}天 {hours}时",
			timeHourMin: "{hours}h {minutes}m",
			timeMin: "{minutes}m",
			updatedAt: "更新时间：{time}",
			loading: "加载中...",
			loginFailed: "登录失败",
			tokens: "tokens"
		};
		const en = {
			title: "Antigravity",
			pageDesc: "Sign in to Google Antigravity / Cloud Code Assist and view shared quotas.",
			account: "Signed in",
			signedIn: "Signed in",
			signedOut: "Not signed in",
			plan: "Plan",
			accountId: "Account ID",
			expires: "Token expires",
			storage: "Credential storage",
			storageNotice: "Tokens are stored locally by the Host ($DSH_HOME/storages/antigravity-oauth.json) and never sent to browser.",
			signInAgain: "Sign in again",
			refreshToken: "Refresh token",
			signOut: "Sign out",
			signIn: "Sign in",
			signingIn: "Signing in...",
			connection: "Connection",
			provider: "Provider",
			providerValue: "Google Antigravity · antigravity",
			connectionState: "Connection state",
			connected: "Connected",
			untested: "Untested",
			modelsHint: "Checked models will appear in DSH conversation model list; keep at least one.",
			selectAll: "Select all",
			unselectAll: "Deselect all",
			enhanced: "Enhanced Features",
			defaultReasoningEffort: "Default reasoning effort",
			defaultReasoningEffortHint: "Controls reasoning effort for reasoning models when not explicitly specified in conversation.",
			defaultEffortAuto: "Use Provider default",
			contextWindowSection: "Model Context Window",
			contextWindowHint: "Defaults to model specification; configure custom capacity used by DSH for compaction and overflow judgments (e.g., 1M, 512K, 200K).",
			save: "Save",
			saved: "Saved",
			saving: "Saving...",
			quotaSection: "Usage & Quota",
			quotaDesc: "Data from Google Cloud Code Assist quota service; refreshes up to once every 60 seconds when visible.",
			refreshQuota: "Refresh quota",
			refreshingQuota: "Refreshing...",
			resetPrefix: "Reset: {time}",
			resetUnavailable: "Reset: n/a",
			resetNow: "now",
			timeDayHour: "{days}d {hours}h",
			timeHourMin: "{hours}h {minutes}m",
			timeMin: "{minutes}m",
			updatedAt: "Updated at: {time}",
			loading: "Loading...",
			loginFailed: "Login failed",
			tokens: "tokens"
		};
		const dictionaries = {
			zh,
			"zh-CN": zh,
			en,
			"en-US": en
		};
		//#endregion
		//#region src/client/antigravity/AntigravitySection.tsx
		const API$1 = "/antigravity/api";
		async function fetchApi$1(path, options) {
			const res = await fetch(`${API$1}${path}`, {
				...options,
				headers: {
					"Content-Type": "application/json",
					...options?.headers
				}
			});
			const json = await res.json();
			if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
			return json.value;
		}
		function parsePositiveCapacity(value) {
			const matched = value.trim().toLowerCase().replace(/[,_\s]/g, "").match(/^(\d+(?:\.\d+)?)(k|m)?$/);
			if (matched === null) return null;
			const multiplier = matched[2] === "m" ? 1e6 : matched[2] === "k" ? 1e3 : 1;
			const parsed = Number(matched[1]) * multiplier;
			return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
		}
		function formatCapacity(value) {
			if (value >= 1e6 && value % 1e5 === 0) return `${value / 1e6}M`;
			if (value % 1e3 === 0) return `${value / 1e3}K`;
			return String(value);
		}
		function formatResetTime(resetTime) {
			if (!resetTime) return "";
			const diff = new Date(resetTime).getTime() - Date.now();
			if (diff <= 0) return "现在";
			const mins = Math.floor(diff / 6e4);
			const hours = Math.floor(mins / 60);
			const days = Math.floor(hours / 24);
			if (days > 0) return `${days}天 ${hours % 24}时`;
			if (hours > 0) return `${hours}h ${mins % 60}m`;
			return `${mins}m`;
		}
		function formatDate(ms) {
			if (!ms || ms <= 0) return "—";
			try {
				return new Intl.DateTimeFormat(void 0, {
					dateStyle: "medium",
					timeStyle: "short"
				}).format(ms);
			} catch {
				return "—";
			}
		}
		function AntigravitySection({ onModelChange, loadModelDirectory }) {
			const [status, setStatus] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(true);
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [contextDrafts, setContextDrafts] = (0, react.useState)({});
			const [savingModel, setSavingModel] = (0, react.useState)(null);
			const t = zh;
			const notifyChange = (0, react.useCallback)(() => {
				onModelChange?.();
				loadModelDirectory?.();
			}, [onModelChange, loadModelDirectory]);
			const loadStatus = (0, react.useCallback)(async (quiet = false) => {
				if (!quiet) setError(null);
				try {
					const data = await fetchApi$1("/status");
					setStatus(data);
					const drafts = {};
					for (const m of data.models) {
						const val = data.contextWindowOverrides[m.id] || m.defaultContextWindow;
						drafts[m.id] = formatCapacity(val);
					}
					setContextDrafts(drafts);
				} catch (err) {
					if (!quiet) setError(err instanceof Error ? err.message : String(err));
				} finally {
					setLoading(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				loadStatus();
				const refreshWhenVisible = () => {
					if (document.visibilityState === "visible") loadStatus(true);
				};
				document.addEventListener("visibilitychange", refreshWhenVisible);
				const timer = window.setInterval(refreshWhenVisible, 6e4);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", refreshWhenVisible);
				};
			}, [loadStatus]);
			const handleLogin = async () => {
				try {
					setBusy("login");
					setError(null);
					const flow = await fetchApi$1("/login", { method: "POST" });
					if (flow.authUrl) window.open(flow.authUrl, "_blank");
					const pollTimer = setInterval(async () => {
						try {
							const pollStatus = await fetchApi$1("/login/status");
							if (pollStatus.status === "complete") {
								clearInterval(pollTimer);
								setBusy(null);
								await loadStatus();
								notifyChange();
							} else if (pollStatus.status === "error") {
								clearInterval(pollTimer);
								setBusy(null);
								setError(t.loginFailed);
							}
						} catch {}
					}, 1500);
					setTimeout(() => {
						clearInterval(pollTimer);
						setBusy(null);
					}, 300 * 1e3);
				} catch (err) {
					setBusy(null);
					setError(err instanceof Error ? err.message : String(err));
				}
			};
			const handleRefreshQuota = async () => {
				try {
					setBusy("quota");
					setError(null);
					const updated = await fetchApi$1("/quota", { method: "POST" });
					setStatus(updated);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(null);
				}
			};
			const handleLogout = async () => {
				try {
					setBusy("logout");
					setError(null);
					const updated = await fetchApi$1("/logout", { method: "POST" });
					setStatus(updated);
					notifyChange();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setBusy(null);
				}
			};
			const toggleModel = async (modelId, checked) => {
				if (!status) return;
				const currentEnabled = status.models.filter((m) => m.enabled).map((m) => m.id);
				const nextEnabled = checked ? [.../* @__PURE__ */ new Set([...currentEnabled, modelId])] : currentEnabled.filter((id) => id !== modelId);
				if (nextEnabled.length === 0) return;
				try {
					const updated = await fetchApi$1("/models", {
						method: "POST",
						body: JSON.stringify({ enabledModelIds: nextEnabled })
					});
					setStatus(updated);
					notifyChange();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};
			const setAllModels = async (selectAll) => {
				if (!status) return;
				const nextEnabled = selectAll ? status.models.map((m) => m.id) : [status.models[0].id];
				try {
					const updated = await fetchApi$1("/models", {
						method: "POST",
						body: JSON.stringify({ enabledModelIds: nextEnabled })
					});
					setStatus(updated);
					notifyChange();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};
			const handleUpdateEffort = async (effort) => {
				try {
					const updated = await fetchApi$1("/settings", {
						method: "POST",
						body: JSON.stringify({ defaultReasoningEffort: effort })
					});
					setStatus(updated);
					notifyChange();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			};
			const handleSaveContextWindow = async (modelId) => {
				const raw = contextDrafts[modelId] || "";
				const parsed = parsePositiveCapacity(raw);
				if (parsed === null) {
					setError(`无效的上下文容量值: ${raw}`);
					return;
				}
				try {
					setSavingModel(modelId);
					setError(null);
					const updated = await fetchApi$1("/settings", {
						method: "POST",
						body: JSON.stringify({ contextWindowOverrides: { [modelId]: parsed } })
					});
					setStatus(updated);
					setContextDrafts((prev) => ({
						...prev,
						[modelId]: formatCapacity(parsed)
					}));
					notifyChange();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				} finally {
					setSavingModel(null);
				}
			};
			if (loading) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsha-page",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsha-empty",
					children: t.loading
				})
			});
			const quota = status?.quota;
			const groups = quota?.groups || [];
			const visibleCount = status?.models.filter((m) => m.enabled).length || 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsha-page",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dsha-group",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-grouphead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: status?.authenticated ? t.account : t.signedOut })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-label",
									children: status?.authenticated ? t.signedIn : t.signedOut
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-value",
									children: status?.email || "—"
								})]
							}),
							status?.authenticated && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsha-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsha-label",
										children: t.plan
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsha-value",
										children: quota?.planLabel || "Google AI Ultra"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsha-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsha-label",
										children: t.accountId
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsha-value",
										children: status.projectId || "antigravity-default"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsha-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsha-label",
										children: t.expires
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsha-value",
										children: formatDate(Date.now() + 864e5 * 30)
									})]
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-label",
									children: t.storage
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-value",
									children: "本地安全存储 (JSON)"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsha-notice",
								children: t.storageNotice
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-actions",
								children: !status?.authenticated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsha-btn dsha-btn-primary",
									disabled: busy !== null,
									onClick: handleLogin,
									children: busy === "login" ? t.signingIn : t.signIn
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "dsha-btn dsha-btn-primary",
										disabled: busy !== null,
										onClick: handleLogin,
										children: t.signInAgain
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "dsha-btn",
										disabled: busy !== null,
										onClick: handleRefreshQuota,
										children: busy === "quota" ? t.refreshingQuota : t.refreshToken
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: "dsha-btn",
										disabled: busy !== null,
										onClick: handleLogout,
										children: t.signOut
									})
								] })
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dsha-group",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-grouphead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t.connection })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-label",
									children: t.provider
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-value",
									children: t.providerValue
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-row",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-label",
									children: t.connectionState
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsha-value",
									children: status?.authenticated ? t.connected : t.untested
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsha-muted dsha-models-hint",
								children: t.modelsHint
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-models",
								"aria-label": "Antigravity Models",
								children: status?.models.map((model) => {
									const checked = model.enabled;
									const lastVisible = checked && visibleCount === 1;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										title: model.id,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked,
											disabled: busy !== null || lastVisible,
											onChange: (e) => void toggleModel(model.id, e.currentTarget.checked)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name })]
									}, model.id);
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsha-btn",
									disabled: busy !== null,
									onClick: () => setAllModels(true),
									children: t.selectAll
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsha-btn",
									disabled: busy !== null,
									onClick: () => setAllModels(false),
									children: t.unselectAll
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dsha-group",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsha-grouphead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t.enhanced })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsha-pref-row",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t.defaultReasoningEffort }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsha-muted",
								children: t.defaultReasoningEffortHint
							})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "dsha-select",
								"aria-label": t.defaultReasoningEffort,
								value: status?.defaultReasoningEffort ?? "",
								disabled: busy !== null,
								onChange: (e) => {
									const val = e.currentTarget.value;
									handleUpdateEffort(val === "" ? null : val);
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t.defaultEffortAuto
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "low",
										children: "Low"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "medium",
										children: "Medium"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "high",
										children: "High"
									})
								]
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dsha-group",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-grouphead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t.contextWindowSection })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsha-muted",
								children: t.contextWindowHint
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-context-settings",
								children: status?.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsha-context-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsha-capacity-control",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "text",
												value: contextDrafts[model.id] ?? "",
												onChange: (e) => setContextDrafts({
													...contextDrafts,
													[model.id]: e.target.value
												}),
												onKeyDown: (e) => {
													if (e.key === "Enter") handleSaveContextWindow(model.id);
												}
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t.tokens }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dsha-context-save",
												disabled: savingModel === model.id,
												onClick: () => void handleSaveContextWindow(model.id),
												children: savingModel === model.id ? t.saving : t.save
											})
										]
									})]
								}, model.id))
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dsha-group",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-grouphead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t.quotaSection }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsha-btn",
									disabled: busy !== null || !status?.authenticated,
									onClick: handleRefreshQuota,
									children: busy === "quota" ? t.refreshingQuota : t.refreshQuota
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsha-muted",
								children: t.quotaDesc
							}),
							!status?.authenticated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-empty",
								children: t.signedOut
							}) : groups.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsha-empty",
								children: "暂无配额数据，点击右上角刷新用量。"
							}) : groups.map((group, gIdx) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-quota-card",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsha-quota-title",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: group.displayName }), group.description && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: group.description })]
								}), group.buckets.map((bucket, bIdx) => {
									const isCyan = /claude|gpt|3p/i.test(group.displayName);
									const pct = Math.round(bucket.remainingFraction * 100);
									const resetText = formatResetTime(bucket.resetTime);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsha-meter-wrap",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dsha-meter-label",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: bucket.displayName }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [pct, "% 剩余"] })]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: `dsha-meter ${isCyan ? "dsha-meter-cyan" : "dsha-meter-green"}`,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { width: `${pct}%` } })
											}),
											resetText && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: "dsha-meter-meta",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["重置: ", resetText] })
											})
										]
									}, bIdx);
								})]
							}, gIdx)),
							quota?.fetchedAt && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsha-timestamp",
								children: ["更新时间: ", new Date(quota.fetchedAt).toLocaleString()]
							})
						]
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsha-error",
						children: error
					})
				]
			});
		}
		//#endregion
		//#region src/client/antigravity/styles.ts
		const STYLE_ID = "dsh-antigravity-settings-style";
		function installAntigravityStyles() {
			if (typeof document === "undefined" || document.getElementById("dsh-antigravity-settings-style")) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = `
.dsha-page{box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;max-width:780px;min-width:0;padding:2px 0 30px}
.dsha-page *{box-sizing:border-box}
.dsha-group{border-top:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.dsha-group:first-of-type{border-top:0}
.dsha-grouphead{align-items:center;display:flex;gap:12px;justify-content:space-between;min-height:48px}
.dsha-grouphead h3{font-size:14px;font-weight:650;margin:0;color:var(--dsw-alias-label-primary)}
.dsha-row{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:20px;justify-content:space-between;min-height:44px;padding:8px 0}
.dsha-label{color:var(--dsw-alias-label-secondary);font-size:13px;flex:0 0 auto}
.dsha-value{font-size:13px;min-width:0;overflow-wrap:anywhere;text-align:right;color:var(--dsw-alias-label-primary)}
.dsha-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding-top:12px}
.dsha-btn{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:8px 13px;white-space:nowrap}
.dsha-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsha-btn:disabled{cursor:default;opacity:.5}
.dsha-btn-primary{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsha-btn-primary:hover:not(:disabled){opacity:.9}
.dsha-notice{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;margin:12px 0 0;padding:10px 12px}
.dsha-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin:0}
.dsha-models-hint{padding-top:10px}
.dsha-models{display:flex;flex-wrap:wrap;gap:7px;padding-top:8px}
.dsha-models label{cursor:pointer;display:block;position:relative}
.dsha-models input{position:absolute;opacity:0;pointer-events:none}
.dsha-models span{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:5px 8px;transition:all .15s ease}
.dsha-models input:checked+span{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 14%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 55%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary);font-weight:600}
.dsha-models input:disabled+span{cursor:default;opacity:.5}
.dsha-pref-row{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:16px;justify-content:space-between;min-height:58px;padding:10px 0}
.dsha-pref-row strong{display:block;font-size:13px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary)}
.dsha-select{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 9px;max-width:220px;min-width:160px}
.dsha-context-settings{border-bottom:0.5px solid var(--dsw-alias-border-l2);display:grid;gap:10px;padding:12px 0}
.dsha-context-settings>div>strong{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsha-context-row{align-items:center;display:flex;font-size:12px;gap:14px;justify-content:space-between}
.dsha-capacity-control{align-items:center;display:flex;gap:7px}
.dsha-capacity-control input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:7px 9px;text-align:right;width:90px}
.dsha-capacity-control small{color:var(--dsw-alias-label-tertiary);font-size:11px;width:42px}
.dsha-context-save{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:1;padding:8px 10px;white-space:nowrap}
.dsha-context-save:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsha-context-save:disabled{cursor:default;opacity:.45}
.dsha-quota-card{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:12px;padding:12px}
.dsha-quota-title{align-items:center;display:flex;font-size:13px;gap:8px;justify-content:space-between;color:var(--dsw-alias-label-primary);font-weight:650}
.dsha-quota-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase}
.dsha-meter-wrap{margin-top:13px}
.dsha-meter-label,.dsha-meter-meta{display:flex;gap:10px;justify-content:space-between}
.dsha-meter-label{font-size:12px;margin-bottom:6px;color:var(--dsw-alias-label-primary)}
.dsha-meter-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45;margin-top:6px}
.dsha-meter{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.15));border-radius:999px;corner-shape:round;height:7px;overflow:hidden;width:100%}
.dsha-meter>span{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:inherit;display:block;height:100%;max-width:100%;min-width:0;transition:width .25s ease}
.dsha-meter-green>span{background:var(--dsw-alias-label-success,#10b981)}
.dsha-meter-cyan>span{background:#06b6d4}
.dsha-timestamp{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:10px 0 0;text-align:right}
.dsha-mini-btn{border:0;background:transparent;color:var(--dsw-alias-label-link,#397ee8);font-size:12px;line-height:18px;cursor:pointer;padding:0;margin-left:8px}
.dsha-mini-btn:hover{text-decoration:underline}
.dsha-empty{border:0.5px dashed var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin:12px 0 0;padding:16px;text-align:center}
.dsha-error{color:var(--dsw-alias-label-danger,#d94b4b);font-size:12px;margin:8px 0 0}
.dsha-composer-quota{align-items:center;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;font-size:11px;gap:6px;height:28px;line-height:1;max-width:160px;padding:0 9px;white-space:nowrap;user-select:none;transition:all .15s ease}
.dsha-composer-quota:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dsha-composer-quota strong{color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650}
.dsha-composer-quota[data-level=warning] strong{color:var(--dsw-alias-label-warning,#d58a24)}
.dsha-composer-quota[data-level=danger] strong{color:var(--dsw-alias-label-danger,#d94b4b)}
`;
			document.head.append(style);
		}
		//#endregion
		//#region src/client/antigravity/AntigravityComposerQuota.tsx
		const API = "/antigravity/api";
		async function fetchApi(path, options) {
			const res = await fetch(`${API}${path}`, {
				...options,
				headers: {
					"Content-Type": "application/json",
					...options?.headers
				}
			});
			const json = await res.json();
			if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
			return json.value;
		}
		function selectQuotaBucketForModel(groups, modelId) {
			if (!groups || groups.length === 0) return null;
			const isClaudeOrGpt = modelId ? /claude|gpt/i.test(modelId) : false;
			const targetGroup = groups.find((g) => {
				const match = /claude|gpt|3p/i.test(g.displayName);
				return isClaudeOrGpt ? match : !match;
			}) || groups[0];
			if (!targetGroup || !targetGroup.buckets || targetGroup.buckets.length === 0) return null;
			const shortBucket = targetGroup.buckets.find((b) => /5\s*小时|hour|5h/i.test(b.displayName)) || targetGroup.buckets[0];
			return {
				groupName: targetGroup.displayName,
				bucketName: shortBucket.displayName,
				remainingPercent: Math.round(shortBucket.remainingFraction * 100),
				resetTime: shortBucket.resetTime
			};
		}
		function formatResetCountdown(resetTime) {
			if (!resetTime) return "";
			try {
				const diff = new Date(resetTime).getTime() - Date.now();
				if (diff <= 0) return "即将重置";
				const h = Math.floor(diff / 36e5);
				const m = Math.floor(diff % 36e5 / 6e4);
				if (h > 0) return `${h}小时${m}分后重置`;
				return `${m}分钟后重置`;
			} catch {
				return "";
			}
		}
		function AntigravityComposerQuota({ directory, loadModelDirectory }) {
			const modelState = useStore(directory);
			const [status, setStatus] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const mountedRef = (0, react.useRef)(false);
			const selected = modelState.current;
			const isAntigravity = selected?.provider === "antigravity";
			(0, react.useEffect)(() => {
				loadModelDirectory();
			}, [loadModelDirectory]);
			(0, react.useEffect)(() => {
				mountedRef.current = true;
				return () => {
					mountedRef.current = false;
				};
			}, []);
			const fetchStatus = (0, react.useCallback)(async (refresh = false) => {
				if (!mountedRef.current) return;
				setLoading(true);
				try {
					const data = refresh ? await fetchApi("/quota", { method: "POST" }) : await fetchApi("/status");
					if (mountedRef.current) setStatus(data);
				} catch {} finally {
					if (mountedRef.current) setLoading(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				if (!isAntigravity) return;
				fetchStatus(false);
				const timer = window.setInterval(() => {
					if (document.visibilityState === "visible") fetchStatus(false);
				}, 6e4);
				return () => {
					window.clearInterval(timer);
				};
			}, [fetchStatus, isAntigravity]);
			const quotaInfo = (0, react.useMemo)(() => {
				return selectQuotaBucketForModel(status?.quota?.groups || [], selected?.model);
			}, [status?.quota?.groups, selected?.model]);
			if (!isAntigravity || !status?.authenticated) return null;
			const level = quotaInfo === null ? "normal" : quotaInfo.remainingPercent <= 5 ? "danger" : quotaInfo.remainingPercent <= 20 ? "warning" : "normal";
			const countdown = quotaInfo?.resetTime ? formatResetCountdown(quotaInfo.resetTime) : "";
			const tooltip = quotaInfo ? `[Antigravity] ${quotaInfo.groupName} - ${quotaInfo.bucketName}: 剩余 ${quotaInfo.remainingPercent}%${countdown ? " (" + countdown + ")" : ""}，点击刷新` : "点击刷新 Antigravity 配额";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dsha-composer-quota",
				"data-level": level,
				title: tooltip,
				"aria-label": tooltip,
				onClick: () => void fetchStatus(true),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsha-composer-quota-label",
					children: "额度"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
					className: "dsha-composer-quota-val",
					children: loading ? "…" : quotaInfo === null ? "—" : `${quotaInfo.remainingPercent}%`
				})]
			});
		}
		function useStore(store) {
			return (0, react.useSyncExternalStore)((listener) => store.subscribe(listener), () => store.getSnapshot(), () => store.getSnapshot());
		}
		//#endregion
		//#region src/client/mermaid/sanitize.ts
		const STRIP_ELEMENTS = /* @__PURE__ */ new Set([
			"foreignobject",
			"script",
			"img",
			"iframe",
			"object",
			"embed",
			"video",
			"audio",
			"input",
			"button",
			"form",
			"link",
			"meta",
			"base"
		]);
		function sanitizeSvg(svg) {
			if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return "";
			let doc;
			try {
				doc = new DOMParser().parseFromString(svg, "image/svg+xml");
			} catch {
				return "";
			}
			if (doc.querySelector("parsererror") !== null) return "";
			if (doc.documentElement === null || doc.documentElement.localName !== "svg") return "";
			doc.querySelectorAll("*").forEach((node) => {
				if (STRIP_ELEMENTS.has(node.localName.toLowerCase())) {
					node.remove();
					return;
				}
				for (const attribute of [...node.attributes]) {
					const name = attribute.name;
					const normalized = name.toLowerCase();
					if (normalized.startsWith("@") || normalized.startsWith("on")) {
						node.removeAttribute(name);
						continue;
					}
					if (normalized === "href" || normalized === "xlink:href") node.removeAttribute(name);
				}
			});
			return new XMLSerializer().serializeToString(doc.documentElement);
		}
		//#endregion
		//#region src/client/mermaid/styles.ts
		const MERMAID_STYLE_ID = "dsh-mermaid-renderer-style";
		function installMermaidStyles() {
			if (typeof document === "undefined" || document.getElementById("dsh-mermaid-renderer-style")) return;
			const style = document.createElement("style");
			style.id = MERMAID_STYLE_ID;
			style.textContent = `
.dsh-mermaid-wrapper{margin:12px 0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12));border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#1a1a1a);box-shadow:0 2px 8px rgba(0,0,0,0.15)}
.dsh-mermaid-header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,0.25));border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.08));font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dsh-mermaid-title{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--dsw-alias-label-tertiary,#aaa);font-weight:600}
.dsh-mermaid-controls{display:flex;gap:8px;align-items:center}
.dsh-mermaid-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.15));border-radius:4px;color:var(--dsw-alias-label-secondary,#ccc);padding:2px 8px;font-size:11px;cursor:pointer;line-height:18px;transition:all .15s}
.dsh-mermaid-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08));color:var(--dsw-alias-label-primary,#fff);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,0.3))}
.dsh-mermaid-chart{padding:18px;overflow-x:auto;display:flex;justify-content:center;align-items:center;min-height:100px;background:var(--dsw-alias-bg-layer-2,#181818);cursor:zoom-in}
.dsh-mermaid-chart svg{max-width:100%;height:auto;display:block;margin:0 auto}
.dsh-mermaid-source{display:none;margin:0;padding:12px;background:var(--dsw-alias-bg-layer-1,#121212);border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.08));font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.dsh-mermaid-source.is-visible{display:block}

/* 全屏缩放预览模态框 */
.dsh-mermaid-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);z-index:99999;display:flex;flex-direction:column;justify-content:center;align-items:center}
.dsh-mermaid-modal-toolbar{position:absolute;top:20px;right:24px;display:flex;gap:8px;background:rgba(20,20,20,0.85);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.5)}
.dsh-mermaid-modal-btn{background:transparent;border:0;color:#fff;font-size:14px;padding:6px 12px;cursor:pointer;border-radius:4px}
.dsh-mermaid-modal-btn:hover{background:rgba(255,255,255,0.15)}
.dsh-mermaid-modal-stage{flex:1;width:100%;height:100%;overflow:auto;display:flex;justify-content:center;align-items:center;padding:40px}
.dsh-mermaid-modal-stage svg{max-width:90vw;max-height:85vh;height:auto}
`;
			document.head.append(style);
		}
		//#endregion
		//#region src/client/mermaid/renderer.ts
		let mermaidSeq = 0;
		let mermaidPromise = null;
		const processedHosts = /* @__PURE__ */ new WeakSet();
		function loadMermaid() {
			if (typeof window === "undefined") return Promise.resolve(null);
			const existing = window.mermaid;
			if (existing) return Promise.resolve(existing);
			if (mermaidPromise) return mermaidPromise;
			mermaidPromise = new Promise((resolve) => {
				const current = window.mermaid;
				if (current) {
					resolve(current);
					return;
				}
				const script = document.createElement("script");
				script.src = "/api/dsh-chatgpt-subscription/mermaid.min.js";
				script.async = true;
				script.onload = () => {
					resolve(window.mermaid || null);
				};
				script.onerror = () => {
					const cdn = document.createElement("script");
					cdn.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
					cdn.async = true;
					cdn.onload = () => resolve(window.mermaid || null);
					cdn.onerror = () => resolve(null);
					document.head.appendChild(cdn);
				};
				document.head.appendChild(script);
			});
			return mermaidPromise;
		}
		function isDarkTheme() {
			if (typeof document === "undefined") return false;
			const root = document.documentElement;
			return root.classList.contains("dark") || root.getAttribute("data-theme") === "dark" || root.getAttribute("data-color-mode") === "dark" || window.matchMedia("(prefers-color-scheme: dark)").matches;
		}
		async function initMermaidConfig() {
			const m = await loadMermaid();
			if (!m) return null;
			try {
				m.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					htmlLabels: false,
					theme: isDarkTheme() ? "dark" : "default",
					fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
				});
			} catch {}
			return m;
		}
		function openZoomModal(svgHtml) {
			const overlay = document.createElement("div");
			overlay.className = "dsh-mermaid-modal-overlay";
			let scale = 1;
			overlay.innerHTML = `
    <div class="dsh-mermaid-modal-toolbar">
      <button type="button" class="dsh-mermaid-modal-btn" data-action="zoom-out" title="缩小">− 缩小</button>
      <button type="button" class="dsh-mermaid-modal-btn" data-action="zoom-in" title="放大">+ 放大</button>
      <button type="button" class="dsh-mermaid-modal-btn" data-action="reset" title="重置">⟳ 重置</button>
      <button type="button" class="dsh-mermaid-modal-btn" data-action="close" title="关闭">✕ 关闭</button>
    </div>
    <div class="dsh-mermaid-modal-stage">
      <div class="dsh-mermaid-zoom-container">${svgHtml}</div>
    </div>
  `;
			const stage = overlay.querySelector(".dsh-mermaid-zoom-container");
			const updateTransform = () => {
				if (stage) stage.style.transform = `scale(${scale})`;
			};
			overlay.addEventListener("click", (e) => {
				const target = e.target;
				const action = target?.getAttribute("data-action");
				if (action === "close" || target === overlay) {
					overlay.remove();
					document.removeEventListener("keydown", onKeyDown);
				} else if (action === "zoom-in") {
					scale = Math.min(5, scale * 1.25);
					updateTransform();
				} else if (action === "zoom-out") {
					scale = Math.max(.2, scale / 1.25);
					updateTransform();
				} else if (action === "reset") {
					scale = 1;
					updateTransform();
				}
			});
			const onKeyDown = (e) => {
				if (e.key === "Escape") {
					overlay.remove();
					document.removeEventListener("keydown", onKeyDown);
				}
			};
			document.addEventListener("keydown", onKeyDown);
			document.body.appendChild(overlay);
		}
		function findMermaidCandidate(codeEl) {
			if (codeEl.closest(".dsh-mermaid-wrapper")) return null;
			const host = codeEl.closest(".md-code-block") || codeEl.closest("pre") || codeEl;
			if (processedHosts.has(host) || host.getAttribute("data-dsh-mermaid-status")) return null;
			if (host.previousElementSibling?.classList.contains("dsh-mermaid-wrapper")) return null;
			const codeText = (codeEl.textContent || "").trim();
			if (!codeText || codeText.length < 5) return null;
			const hasMermaidClass = [...codeEl.classList].some((c) => c.toLowerCase().includes("mermaid"));
			const topText = host.firstElementChild?.textContent?.trim().toLowerCase();
			const isHeaderMermaid = topText === "mermaid" || topText?.startsWith("mermaid ");
			const isGrammarStart = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline)\b/i.test(codeText);
			if (hasMermaidClass || isHeaderMermaid || isGrammarStart) return {
				host,
				code: codeText
			};
			return null;
		}
		async function renderMermaidHost(host, code) {
			processedHosts.add(host);
			host.setAttribute("data-dsh-mermaid-status", "processing");
			const m = await initMermaidConfig();
			if (!m) {
				processedHosts.delete(host);
				host.removeAttribute("data-dsh-mermaid-status");
				return;
			}
			const renderId = `dsh-mermaid-${++mermaidSeq}`;
			try {
				const { svg } = await m.render(renderId, code);
				const cleanSvg = sanitizeSvg(svg);
				if (!cleanSvg) {
					processedHosts.delete(host);
					host.removeAttribute("data-dsh-mermaid-status");
					return;
				}
				if (host.previousElementSibling?.classList.contains("dsh-mermaid-wrapper")) {
					host.setAttribute("data-dsh-mermaid-status", "done");
					host.style.display = "none";
					return;
				}
				const wrapper = document.createElement("div");
				wrapper.className = "dsh-mermaid-wrapper";
				let showSource = false;
				wrapper.innerHTML = `
      <div class="dsh-mermaid-header">
        <span class="dsh-mermaid-title">Mermaid 图表</span>
        <div class="dsh-mermaid-controls">
          <button type="button" class="dsh-mermaid-btn" data-btn="toggle-source">源码</button>
          <button type="button" class="dsh-mermaid-btn" data-btn="copy">复制</button>
          <button type="button" class="dsh-mermaid-btn" data-btn="zoom" title="放大查看">放大 ↗</button>
        </div>
      </div>
      <div class="dsh-mermaid-chart" title="点击放大">${cleanSvg}</div>
      <div class="dsh-mermaid-source"><code>${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></div>
    `;
				const sourceEl = wrapper.querySelector(".dsh-mermaid-source");
				const toggleBtn = wrapper.querySelector("[data-btn=\"toggle-source\"]");
				const copyBtn = wrapper.querySelector("[data-btn=\"copy\"]");
				const chartEl = wrapper.querySelector(".dsh-mermaid-chart");
				toggleBtn?.addEventListener("click", (e) => {
					e.stopPropagation();
					showSource = !showSource;
					if (showSource) {
						sourceEl.classList.add("is-visible");
						toggleBtn.textContent = "图表";
					} else {
						sourceEl.classList.remove("is-visible");
						toggleBtn.textContent = "源码";
					}
				});
				copyBtn?.addEventListener("click", async (e) => {
					e.stopPropagation();
					try {
						await navigator.clipboard.writeText(code);
						copyBtn.textContent = "已复制";
						setTimeout(() => {
							copyBtn.textContent = "复制";
						}, 1500);
					} catch {}
				});
				const handleZoom = (e) => {
					e.stopPropagation();
					openZoomModal(cleanSvg);
				};
				wrapper.querySelector("[data-btn=\"zoom\"]")?.addEventListener("click", handleZoom);
				chartEl?.addEventListener("click", handleZoom);
				host.style.display = "none";
				host.parentNode?.insertBefore(wrapper, host);
				host.setAttribute("data-dsh-mermaid-status", "done");
			} catch {
				processedHosts.delete(host);
				host.removeAttribute("data-dsh-mermaid-status");
				const errContainer = document.getElementById(renderId);
				if (errContainer) errContainer.remove();
			}
		}
		function scanAndRenderMermaid() {
			if (typeof document === "undefined") return;
			const codeElements = document.querySelectorAll("pre code, .md-code-block code");
			for (const codeEl of codeElements) {
				const candidate = findMermaidCandidate(codeEl);
				if (candidate) renderMermaidHost(candidate.host, candidate.code);
			}
		}
		function setupMermaidObserver() {
			if (typeof document === "undefined") return () => {};
			installMermaidStyles();
			let timer;
			const debouncedScan = () => {
				window.clearTimeout(timer);
				timer = window.setTimeout(() => {
					scanAndRenderMermaid();
				}, 250);
			};
			debouncedScan();
			const observer = new MutationObserver((mutations) => {
				let shouldScan = false;
				for (const m of mutations) {
					for (const node of m.addedNodes) if (node.nodeType === 1) {
						const el = node;
						if (el.classList?.contains("dsh-mermaid-wrapper") || el.closest?.(".dsh-mermaid-wrapper")) continue;
						shouldScan = true;
						break;
					}
					if (shouldScan) break;
				}
				if (shouldScan) debouncedScan();
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			const themeObserver = new MutationObserver(() => {
				initMermaidConfig();
				for (const el of document.querySelectorAll("[data-dsh-mermaid-status=\"done\"]")) {
					processedHosts.delete(el);
					el.removeAttribute("data-dsh-mermaid-status");
					const prevWrapper = el.previousElementSibling;
					if (prevWrapper && prevWrapper.classList.contains("dsh-mermaid-wrapper")) prevWrapper.remove();
					el.style.display = "";
				}
				debouncedScan();
			});
			themeObserver.observe(document.documentElement, {
				attributes: true,
				attributeFilter: [
					"class",
					"data-theme",
					"data-color-mode"
				]
			});
			return () => {
				observer.disconnect();
				themeObserver.disconnect();
				window.clearTimeout(timer);
			};
		}
		//#endregion
		//#region src/client/index.tsx
		const inject = [
			"slots",
			"locale",
			"modelDirectories",
			"conversation"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, dictionaries$1), "dsh-chatgpt-subscription: dictionaries");
			ctx.effect(() => installStyles(), "dsh-chatgpt-subscription: styles");
			ctx.effect(() => ctx.locale.register(NS_ANTIGRAVITY, dictionaries), "dsh-antigravity: dictionaries");
			ctx.effect(() => {
				installAntigravityStyles();
				return () => {};
			}, "dsh-antigravity: styles");
			ctx.effect(() => setupMermaidObserver(), "dsh-mermaid: observer");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "codex-subscription",
				order: 45,
				label: () => t("title"),
				locale: NS
			}, CodexSubscriptionSection));
			const AntigravitySectionWrapper = () => {
				const handleModelChange = () => {
					try {
						const conv = ctx.conversation;
						const activeSessionId = conv?.activeSessionId || conv?.currentSessionId || conv?.activeId;
						if (activeSessionId && ctx.modelDirectories) ctx.modelDirectories.directoryFor(activeSessionId)?.load?.().catch?.(() => void 0);
					} catch {}
				};
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AntigravitySection, { onModelChange: handleModelChange });
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "antigravity",
				order: 46,
				label: () => "Antigravity",
				locale: NS_ANTIGRAVITY
			}, AntigravitySectionWrapper));
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "codex-subscription-quota",
				order: 35,
				locale: NS,
				inject: (sessionId) => {
					const directory = ctx.modelDirectories.directoryFor(sessionId);
					return {
						api: new SubscriptionApi(),
						directory: directory.store,
						loadModelDirectory: () => {
							directory.load().catch(() => void 0);
						}
					};
				}
			}, CodexComposerQuota));
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "antigravity-quota",
				order: 36,
				locale: NS_ANTIGRAVITY,
				inject: (sessionId) => {
					const directory = ctx.modelDirectories.directoryFor(sessionId);
					return {
						directory: directory.store,
						loadModelDirectory: () => {
							directory.load().catch(() => void 0);
						}
					};
				}
			}, AntigravityComposerQuota));
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: CODEX_IMAGE_TOOL_NAME,
				locale: NS,
				inject: (sessionId) => ({ loadImage: imageLoader(ctx, sessionId) })
			}, CodexImageToolView));
		}
		function imageLoader(ctx, sessionId) {
			const conversation = ctx.conversation;
			return (attachment) => conversation.resolveImage(sessionId, attachment);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map