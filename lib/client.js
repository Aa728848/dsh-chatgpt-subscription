window.__ModuleLoader__.load({
	id: "@eddyskywalker/dsh-chatgpt-subscription",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const ROUTE_PREFIX = "/api/dsh-chatgpt-subscription";
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
			testConnection() {
				return post(`${ROUTE_PREFIX}/connection/test`, {});
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
		const MODELS = [
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.2"
		];
		function CodexSubscriptionSection({ t }) {
			const apiRef = (0, react.useRef)(new SubscriptionApi());
			const eventSourceRef = (0, react.useRef)(null);
			const [status, setStatus] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [authUrl, setAuthUrl] = (0, react.useState)(null);
			const [popupBlocked, setPopupBlocked] = (0, react.useState)(false);
			const [connection, setConnection] = (0, react.useState)(null);
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
			const testConnection = async () => run("test", async () => {
				const result = await apiRef.current.testConnection();
				setConnection({
					latencyMs: result.latencyMs,
					checkedAt: result.checkedAt
				});
			});
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
				try {
					await task();
				} catch (cause) {
					setError(messageOf(cause));
				} finally {
					setBusy(null);
				}
			};
			const account = status?.account;
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
										value: formatDate(account?.tokenExpiresAt)
									})
								] }) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InfoRow, {
									label: t("storage"),
									value: t("storageValue")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-notice",
									children: t("securityNotice")
								}),
								status?.login.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
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
									children: [status?.login.active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										disabled: busy !== null,
										onClick: cancelLogin,
										children: t("cancel")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Button, {
										primary: true,
										disabled: busy !== null,
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
									value: `${connection.latencyMs} ms · ${formatDate(connection.checkedAt)}`
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-codex-models",
									"aria-label": t("models"),
									children: MODELS.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: model }, model))
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
								status?.quota.state === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-empty",
									children: t("quotaSignedOut")
								}) : null,
								status?.quota.buckets.map((bucket) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBucket, {
									bucket,
									t
								}, bucket.id)),
								status?.quota.state === "empty" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-empty",
									children: t("noQuota")
								}) : null,
								status?.quota.stale ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-warning",
									role: "status",
									children: t("stale")
								}) : null,
								status?.quota.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "dsh-codex-error",
									role: "alert",
									children: status.quota.error.message
								}) : null,
								status?.quota.fetchedAt ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: "dsh-codex-timestamp",
									children: [
										t("updated"),
										": ",
										formatDate(status.quota.fetchedAt)
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
		function QuotaBucket({ bucket, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: "dsh-codex-quota-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-codex-quota-title",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: bucket.name }), bucket.planType ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: bucket.planType }) : null]
					}),
					bucket.primary ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
						label: windowLabel(bucket.primary.windowDurationMins, t),
						window: bucket.primary,
						t
					}) : null,
					bucket.secondary ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
						label: windowLabel(bucket.secondary.windowDurationMins, t),
						window: bucket.secondary,
						t
					}) : null
				]
			});
		}
		function QuotaBar({ label, window, t }) {
			const percent = window.usedPercent;
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
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { width: `${percent}%` } })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-codex-meter-meta",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: percent >= 100 ? `${t("exhausted")} · ${formatPercent(remaining)} ${t("remaining")}` : `${formatPercent(percent)} ${t("used")} · ${formatPercent(remaining)} ${t("remaining")}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: window.resetsAt === null ? "—" : `${t("resets")}: ${formatReset(window.resetsAt)}` })]
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
			if (minutes === null) return t("limitWindow");
			const [value, unit] = minutes >= 1440 && minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes >= 60 && minutes % 60 === 0 ? [minutes / 60, "hour"] : [Math.round(minutes), "minute"];
			return `${new Intl.NumberFormat(void 0, {
				style: "unit",
				unit,
				unitDisplay: "long"
			}).format(value)} ${t("limitWindow")}`;
		}
		function formatPercent(value) {
			return `${new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(value)}%`;
		}
		function formatDate(seconds) {
			if (seconds === void 0) return "—";
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(seconds * 1e3);
		}
		function formatReset(seconds) {
			const absolute = formatDate(seconds);
			const diff = seconds * 1e3 - Date.now();
			const abs = Math.abs(diff);
			const [amount, unit] = abs >= 864e5 ? [Math.round(diff / 864e5), "day"] : abs >= 36e5 ? [Math.round(diff / 36e5), "hour"] : [Math.round(diff / 6e4), "minute"];
			return `${absolute} (${new Intl.RelativeTimeFormat(void 0, { numeric: "auto" }).format(amount, unit)})`;
		}
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		//#endregion
		//#region src/client/locales.ts
		const NS = "dsh-chatgpt-subscription";
		const dictionaries = {
			zh: {
				title: "Codex 订阅",
				intro: "使用 ChatGPT 账号登录，在 DSH 中使用订阅可用的 Codex 模型。",
				account: "账号",
				signedOut: "尚未登录",
				signedIn: "已登录",
				plan: "套餐",
				accountId: "账号 ID",
				expires: "令牌到期",
				storage: "凭据存储",
				storageValue: "Windows DPAPI（当前用户加密）",
				securityNotice: "令牌仅保存在 Host 端的 DPAPI 加密文件中，不会进入浏览器、settings.yaml 或日志。",
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
				exhausted: "额度已用尽",
				resets: "重置",
				retry: "重试",
				unknown: "未知"
			},
			en: {
				title: "Codex subscription",
				intro: "Sign in with ChatGPT to use Codex models available to your subscription in DSH.",
				account: "Account",
				signedOut: "Not signed in",
				signedIn: "Signed in",
				plan: "Plan",
				accountId: "Account ID",
				expires: "Token expires",
				storage: "Credential storage",
				storageValue: "Windows DPAPI (current-user encrypted)",
				securityNotice: "Tokens stay in a Host-side DPAPI-encrypted file and never enter the browser, settings.yaml, or logs.",
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
				exhausted: "Quota exhausted",
				resets: "Resets",
				retry: "Retry",
				unknown: "Unknown"
			}
		};
		//#endregion
		//#region src/client/process-folding.ts
		const ROW_CLASS = "dsh-codex-process-row";
		const GROUP_HEAD_CLASS = "dsh-codex-process-group-head";
		const GROUP_COLLAPSED_CLASS = "dsh-codex-process-group-collapsed";
		const GROUP_HIDDEN_CLASS = "dsh-codex-process-group-hidden";
		const USER_TOGGLED_ATTR = "data-dsh-codex-process-user-toggled";
		const TITLE_ATTR = "data-dsh-codex-process-title";
		const TITLE = "Click to expand or collapse process details";
		const DEFAULT_AUTO_COLLAPSE_MS = 350;
		const MAX_PROCESS_LABELS_PER_ROW = 3;
		const MAX_SCAN_ROOTS_PER_FRAME = 80;
		const MAX_TEXT_SAMPLE = 2e4;
		const PROCESS_CANDIDATE_SELECTOR = "article,section,li,div,p,span,button,h1,h2,h3,h4,h5,h6,[role=\"button\"],[role=\"listitem\"]";
		const PROCESS_PREFIX_PATTERN = "(?:上下文注入|Think|Search|Code|代码|Pwsh|PowerShell|Bash|Shell|Read|Glob|Grep|Web(?:\\s+Search)?|Tool|工具|思考)";
		const COMMAND_PATTERN = /(?:Code|代码|Pwsh|PowerShell|Bash|Shell|Read|Glob|Grep|Tool|工具)/i;
		const SEARCH_PATTERN = /(?:Search|Web\s+Search|搜索)/i;
		const PROCESS_PREFIX_RE = new RegExp(`^\\s*(?:[•●◦▪▫·#-]\\s*)?${PROCESS_PREFIX_PATTERN}\\s*(?:[·:：-]|$)`, "i");
		const PROCESS_LINE_RE = new RegExp(`(?:^|\\n)\\s*(?:[•●◦▪▫·#-]\\s*)?${PROCESS_PREFIX_PATTERN}\\s*(?:[·:：-]|$)`, "gi");
		function installProcessFolding(options = {}) {
			if (typeof document === "undefined") return () => void 0;
			if (document.body === null) {
				let dispose = () => void 0;
				let started = false;
				const start = () => {
					if (started) return;
					started = true;
					dispose = installProcessFolding(options);
				};
				document.addEventListener("DOMContentLoaded", start, { once: true });
				return () => {
					document.removeEventListener("DOMContentLoaded", start);
					dispose();
				};
			}
			const autoCollapseMs = options.autoCollapseMs ?? DEFAULT_AUTO_COLLAPSE_MS;
			const groups = /* @__PURE__ */ new Map();
			const pending = /* @__PURE__ */ new Set();
			let frame = null;
			const scheduleFlush = () => {
				if (frame !== null) return;
				frame = requestAnimationFrame(() => {
					frame = null;
					flush();
				});
			};
			const queue = (element) => {
				if (element === null || !element.isConnected) return;
				pending.add(element);
				scheduleFlush();
			};
			const scheduleAutoCollapse = (head) => {
				const state = groups.get(head);
				if (state === void 0 || head.hasAttribute(USER_TOGGLED_ATTR)) return;
				if (state.timer !== null) clearTimeout(state.timer);
				state.timer = setTimeout(() => {
					state.timer = null;
					if (head.isConnected && !head.hasAttribute(USER_TOGGLED_ATTR)) setGroupCollapsed(head, true);
				}, autoCollapseMs);
			};
			const syncGroup = (rows, previous) => {
				const head = rows[0];
				const title = titleForProcessRows(rows);
				const click = (event) => {
					if (isInteractiveTarget(event.target, head)) return;
					markUserToggled(head);
					setGroupCollapsed(head, !head.classList.contains(GROUP_COLLAPSED_CLASS));
				};
				const keydown = (event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					markUserToggled(head);
					setGroupCollapsed(head, !head.classList.contains(GROUP_COLLAPSED_CLASS));
				};
				groups.set(head, {
					rows,
					click,
					keydown,
					timer: null
				});
				for (const row of rows) row.classList.add(ROW_CLASS);
				head.classList.add(GROUP_HEAD_CLASS);
				if (!head.hasAttribute("tabindex")) head.tabIndex = 0;
				head.setAttribute("aria-expanded", String(!(previous?.collapsed ?? false)));
				head.setAttribute(TITLE_ATTR, title);
				head.title ||= TITLE;
				if (previous?.userToggled === true) head.setAttribute(USER_TOGGLED_ATTR, "true");
				head.addEventListener("click", click);
				head.addEventListener("keydown", keydown);
				setGroupCollapsed(head, previous?.collapsed ?? false);
				scheduleAutoCollapse(head);
			};
			const rebuildParentGroups = (parent) => {
				const previous = /* @__PURE__ */ new Map();
				for (const [head, state] of groups) {
					if (head.parentElement !== parent) continue;
					previous.set(head, {
						collapsed: head.classList.contains(GROUP_COLLAPSED_CLASS),
						userToggled: head.hasAttribute(USER_TOGGLED_ATTR)
					});
					cleanupGroup(head, state);
					groups.delete(head);
				}
				let rows = [];
				const flushRows = () => {
					if (rows.length > 0) syncGroup(rows, previous.get(rows[0]));
					rows = [];
				};
				for (const child of Array.from(parent.children)) if (child instanceof HTMLElement && isProcessRow(child)) rows.push(child);
				else flushRows();
				flushRows();
			};
			const flush = () => {
				const parents = /* @__PURE__ */ new Set();
				let scanned = 0;
				for (const root of Array.from(pending)) {
					pending.delete(root);
					if (!root.isConnected) continue;
					for (const row of findProcessRows(root)) if (row.parentElement !== null) parents.add(row.parentElement);
					const grouped = nearestGroupHead(root);
					if (grouped !== null && grouped.parentElement !== null) parents.add(grouped.parentElement);
					scanned++;
					if (scanned >= MAX_SCAN_ROOTS_PER_FRAME && pending.size > 0) {
						scheduleFlush();
						break;
					}
				}
				for (const parent of parents) rebuildParentGroups(parent);
			};
			const observer = new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					if (mutation.type === "characterData") {
						queue(nodeElement(mutation.target)?.closest(PROCESS_CANDIDATE_SELECTOR) ?? nodeElement(mutation.target));
						continue;
					}
					for (const node of mutation.addedNodes) queue(nodeElement(node));
				}
			});
			observer.observe(document.body, {
				childList: true,
				characterData: true,
				subtree: true
			});
			queue(document.body);
			return () => {
				observer.disconnect();
				if (frame !== null) cancelAnimationFrame(frame);
				pending.clear();
				for (const [head, state] of groups) cleanupGroup(head, state);
				groups.clear();
			};
		}
		function cleanupGroup(head, state) {
			if (state.timer !== null) clearTimeout(state.timer);
			head.removeEventListener("click", state.click);
			head.removeEventListener("keydown", state.keydown);
			for (const row of state.rows) row.classList.remove(ROW_CLASS, GROUP_HIDDEN_CLASS);
			head.classList.remove(GROUP_HEAD_CLASS, GROUP_COLLAPSED_CLASS);
			head.removeAttribute("aria-expanded");
			head.removeAttribute(USER_TOGGLED_ATTR);
			head.removeAttribute(TITLE_ATTR);
			if (head.title === TITLE) head.removeAttribute("title");
		}
		function findProcessRows(root) {
			const rows = [];
			if (root instanceof HTMLElement && isProcessRow(root)) pushProcessRow(rows, root);
			for (const element of root.querySelectorAll(PROCESS_CANDIDATE_SELECTOR)) if (element instanceof HTMLElement && isProcessRow(element)) pushProcessRow(rows, element);
			return rows;
		}
		function pushProcessRow(rows, row) {
			if (rows.some((existing) => existing.contains(row))) return;
			rows.push(row);
		}
		function isProcessRow(element) {
			if (element.closest(".dsh-codex-page") !== null || shouldIgnore(element)) return false;
			const raw = (element.textContent ?? "").slice(0, MAX_TEXT_SAMPLE);
			const normalized = raw.replace(/\s+/g, " ").trim();
			if (!PROCESS_PREFIX_RE.test(normalized)) return false;
			const stats = processTextStats(raw);
			if (stats.processLabels === 0 || stats.processLabels > MAX_PROCESS_LABELS_PER_ROW) return false;
			return !(element.children.length > 0 && stats.hasNonProcessLine);
		}
		function processTextStats(text) {
			PROCESS_LINE_RE.lastIndex = 0;
			let processLabels = 0;
			while (PROCESS_LINE_RE.exec(text) !== null) processLabels++;
			const hasNonProcessLine = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).some((line) => line !== "" && !PROCESS_PREFIX_RE.test(line));
			return {
				processLabels,
				hasNonProcessLine
			};
		}
		function setGroupCollapsed(head, collapsed) {
			const state = findCurrentGroupState(head);
			if (state === null) return;
			head.classList.toggle(GROUP_COLLAPSED_CLASS, collapsed);
			head.setAttribute("aria-expanded", String(!collapsed));
			for (const row of state.rows.slice(1)) row.classList.toggle(GROUP_HIDDEN_CLASS, collapsed);
		}
		function findCurrentGroupState(head) {
			const rows = [head];
			let sibling = head.nextElementSibling;
			while (sibling instanceof HTMLElement && isProcessRow(sibling)) {
				rows.push(sibling);
				sibling = sibling.nextElementSibling;
			}
			return rows.length > 0 ? { rows } : null;
		}
		function markUserToggled(head) {
			head.setAttribute(USER_TOGGLED_ATTR, "true");
		}
		function nearestGroupHead(element) {
			const decorated = element.closest(`.${GROUP_HEAD_CLASS}`);
			return decorated instanceof HTMLElement ? decorated : null;
		}
		function titleForProcessRows(rows) {
			const text = rows.map((row) => row.textContent ?? "").join("\n");
			if (COMMAND_PATTERN.test(text)) return "运行了命令";
			if (SEARCH_PATTERN.test(text)) return "进行了搜索";
			return "思考过程";
		}
		function nodeElement(node) {
			if (node instanceof Element) return node;
			return node.parentElement;
		}
		function shouldIgnore(element) {
			return element.closest("textarea,input,select,a,[contenteditable=\"true\"],script,style") !== null;
		}
		function isInteractiveTarget(target, groupHead) {
			if (!(target instanceof Element)) return false;
			const interactive = target.closest("button,a,input,textarea,select,[role=\"button\"],[contenteditable=\"true\"]");
			return interactive !== null && interactive !== groupHead;
		}
		//#endregion
		//#region src/client/styles.ts
		const STYLE_ID = "@eddyskywalker/dsh-chatgpt-subscription/main";
		const CSS = `
.dsh-codex-page{box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;max-width:780px;min-width:0;padding:2px 0 30px}
.dsh-codex-page *{box-sizing:border-box}
.dsh-codex-title{font-size:15px;font-weight:650;line-height:1.4;margin:0 0 5px}
.dsh-codex-intro,.dsh-codex-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin:0}
.dsh-codex-group{border-top:1px solid var(--dsw-alias-border-l2);min-width:0}
.dsh-codex-grouphead{align-items:center;display:flex;gap:12px;justify-content:space-between;min-height:48px}
.dsh-codex-grouphead h3{font-size:14px;font-weight:650;margin:0}
.dsh-codex-row{align-items:center;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;gap:20px;justify-content:space-between;min-height:44px;padding:8px 0}
.dsh-codex-label{color:var(--dsw-alias-label-secondary);font-size:13px;flex:0 0 auto}
.dsh-codex-value{font-size:13px;min-width:0;overflow-wrap:anywhere;text-align:right}
.dsh-codex-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding-top:12px}
.dsh-codex-button{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:8px 13px;white-space:nowrap}
.dsh-codex-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-codex-button:focus-visible,.dsh-codex-link:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-button:disabled{cursor:default;opacity:.5}
.dsh-codex-button-primary{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsh-codex-notice{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;margin:12px 0 0;padding:10px 12px}
.dsh-codex-error,.dsh-codex-warning{font-size:12px;line-height:1.5;margin:8px 0 0}
.dsh-codex-error{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-warning{color:var(--dsw-alias-label-warning,#c77a18)}
.dsh-codex-errorbar{align-items:center;background:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 9%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 28%,transparent);border-radius:7px;color:var(--dsw-alias-label-danger,#d94b4b);display:flex;font-size:13px;gap:12px;justify-content:space-between;padding:10px 12px}
.dsh-codex-link{color:var(--dsw-alias-label-link,#3278d4);display:inline-block;font-size:13px;margin-top:8px}
.dsh-codex-models{display:flex;flex-wrap:wrap;gap:6px;padding-top:12px}
.dsh-codex-models code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:4px 6px}
.dsh-codex-quota-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:12px;padding:12px}
.dsh-codex-quota-title{align-items:center;display:flex;font-size:13px;gap:8px;justify-content:space-between}
.dsh-codex-quota-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase}
.dsh-codex-meter-wrap{margin-top:13px}
.dsh-codex-meter-label,.dsh-codex-meter-meta{display:flex;gap:10px;justify-content:space-between}
.dsh-codex-meter-label{font-size:12px;margin-bottom:6px}
.dsh-codex-meter-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45;margin-top:6px}
.dsh-codex-meter{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.15));border-radius:999px;height:7px;overflow:hidden;width:100%}
.dsh-codex-meter>span{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:inherit;display:block;height:100%;max-width:100%;min-width:0;transition:width .25s ease}
.dsh-codex-meter-warning>span{background:var(--dsw-alias-label-warning,#d58a24)}
.dsh-codex-meter-danger>span{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin:12px 0 0;padding:16px;text-align:center}
.dsh-codex-timestamp{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:10px 0 0;text-align:right}
.dsh-codex-skeleton{display:grid;gap:9px;padding-top:10px}
.dsh-codex-skeleton span{animation:dsh-codex-pulse 1.4s ease-in-out infinite;background:var(--dsw-alias-bg-layer-2);border-radius:5px;height:42px}
.dsh-codex-skeleton span:nth-child(2){animation-delay:.12s}.dsh-codex-skeleton span:nth-child(3){animation-delay:.24s}
.dsh-codex-sr{height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;clip:rect(0 0 0 0);white-space:nowrap}
.dsh-codex-process-group-head{border-radius:6px;cursor:pointer;transition:background-color .15s ease,opacity .15s ease}
.dsh-codex-process-group-head:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18)) 72%,transparent)}
.dsh-codex-process-group-head:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-process-group-head.dsh-codex-process-group-collapsed{align-items:center!important;color:transparent!important;display:flex!important;font-size:0!important;line-height:28px!important;max-height:28px!important;min-height:28px!important;overflow:hidden!important;opacity:.78}
.dsh-codex-process-group-head.dsh-codex-process-group-collapsed>*{display:none!important}
.dsh-codex-process-group-head.dsh-codex-process-group-collapsed::before{color:var(--dsw-alias-label-secondary);content:"▸ " attr(data-dsh-codex-process-title);display:block;font-size:13px;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-codex-process-group-hidden{display:none!important}
@keyframes dsh-codex-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media(max-width:560px){.dsh-codex-row{align-items:flex-start;flex-direction:column;gap:3px}.dsh-codex-value{text-align:left}.dsh-codex-actions{justify-content:flex-start}.dsh-codex-grouphead{align-items:flex-start;flex-direction:column;gap:0;padding:12px 0}.dsh-codex-meter-meta{align-items:flex-start;flex-direction:column;gap:2px}.dsh-codex-errorbar{align-items:flex-start;flex-direction:column}}
@media(prefers-reduced-motion:reduce){.dsh-codex-meter>span,.dsh-codex-process-group-head{transition:none}.dsh-codex-skeleton span{animation:none}}
`;
		function installStyles() {
			if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => void 0;
			const element = document.createElement("style");
			element.dataset.plugin = "@eddyskywalker/dsh-chatgpt-subscription";
			element.dataset.pluginCss = STYLE_ID;
			element.textContent = CSS;
			document.head.appendChild(element);
			return () => element.remove();
		}
		//#endregion
		//#region src/client/index.tsx
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-chatgpt-subscription: dictionaries");
			ctx.effect(() => installStyles(), "dsh-chatgpt-subscription: styles");
			ctx.effect(() => installProcessFolding(), "dsh-chatgpt-subscription: process folding");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "codex-subscription",
				order: 45,
				label: "Codex 订阅",
				locale: NS
			}, CodexSubscriptionSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map