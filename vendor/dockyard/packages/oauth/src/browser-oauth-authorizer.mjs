import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { redactError } from "../../providers/src/provider-utils.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CALLBACK_PATH = "/oauth/callback";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function createPkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    providerId: session.providerId,
    status: session.status,
    authorizationUrl: session.authorizationUrl,
    instructions: session.instructions,
    startedAt: session.startedAt,
    diagnostic: session.diagnostic ?? null,
    ...(session.browserOpened ? { browserOpened: true } : {}),
    ...(session.authorizationCodeRequired ? { authorizationCodeRequired: true } : {}),
  };
}

function missingSession(sessionId, providerId, instructions) {
  return {
    sessionId,
    providerId,
    status: "missing",
    instructions,
    diagnostic: "OAuth 登录会话不存在或已结束，请重新点击登录添加账号。",
  };
}

function extractCodeInput(input) {
  const text = String(input ?? "").trim();
  if (!text) return { code: "", state: "" };
  try {
    const url = new URL(text);
    return {
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state") ?? "",
      error: url.searchParams.get("error") ?? "",
    };
  } catch {
    const [code, state] = text.split("#", 2);
    return { code: code.trim(), state: state?.trim() ?? "" };
  }
}

/**
 * Provider-neutral browser OAuth controller. Providers supply only their
 * registered OAuth endpoints and token/account adapters; this layer owns PKCE,
 * state validation, loopback callbacks, manual code input, and cleanup.
 */
export function createBrowserOAuthAuthorizer({
  providerId,
  authorizationUrlBuilder,
  exchangeCode = null,
  pollSession = null,
  importCredentials,
  redirectUri,
  callbackPath = DEFAULT_CALLBACK_PATH,
  callbackHost = "localhost",
  callbackPort = null,
  instructions = "请在官方授权页面选择账号并完成授权。",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  browserOpened = false,
  authorizationCodeRequired = false,
} = {}) {
  if (!providerId) throw new Error("Browser OAuth authorizer requires providerId");
  if (typeof authorizationUrlBuilder !== "function") {
    throw new Error(`Browser OAuth authorizer requires an authorization URL builder for ${providerId}`);
  }
  if (typeof exchangeCode !== "function" && typeof pollSession !== "function") {
    throw new Error(`Browser OAuth authorizer requires a code exchange or session poller for ${providerId}`);
  }
  if (typeof importCredentials !== "function") {
    throw new Error(`Browser OAuth authorizer requires an import callback for ${providerId}`);
  }
  if (!redirectUri && callbackPort === null && typeof pollSession !== "function") {
    throw new Error(`Browser OAuth authorizer requires redirectUri or callbackPort for ${providerId}`);
  }

  const sessions = new Map();

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
    res.end(`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title><p>${message}</p><p>可以关闭此页面并返回 Dockyard DSH。</p><script>history.replaceState(null,"","/")</script>`);
  }

  async function handleCallback(session, req, res) {
    const peer = String(req.socket?.remoteAddress ?? '').toLowerCase().replace(/^::ffff:/, '');
    if (!['127.0.0.1', '::1'].includes(peer)) {
      res.statusCode = 403;
      res.end('Forbidden');
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
      session.callback = { error, state };
      responseHtml(res, "授权未完成", "官方授权被拒绝，可以关闭此页面。");
      return;
    }
    if (!code) {
      session.callback = { error: "授权回调没有返回 code", state };
      responseHtml(res, "授权未完成", "回调缺少授权码，可以关闭此页面。");
      return;
    }
    session.callback = { code, state };
    responseHtml(res, "授权成功", "已收到授权回调，正在返回 Dockyard DSH。");
  }

  async function openCallbackServer(session) {
    if (session.callbackPort === null || session.callbackPort === undefined) return;
    const server = createServer((req, res) => {
      void handleCallback(session, req, res).catch((error) => {
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
      server.listen({ host: callbackHost, port: session.callbackPort });
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
        if (!callback && !session.credentials) return publicSession(session);
        if (callback?.error) throw new Error(callback.error);
        const exchanged = session.credentials ?? await exchangeCode({
          code: callback.code,
          state: callback.state,
          codeVerifier: session.codeVerifier,
          redirectUri: session.redirectUri,
          context,
        });
        const accounts = await importCredentials(exchanged, context);
        if (!Array.isArray(accounts) || accounts.length === 0) {
          throw new Error("官方授权完成，但 provider 没有返回可接入的订阅账号");
        }
        session.status = "completed";
        session.result = {
          ...publicSession(session),
          accounts,
          diagnostic: null,
        };
        return session.result;
      } catch (error) {
        session.status = "failed";
        session.diagnostic = redactError(error);
        return publicSession(session);
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
      startedAt: new Date().toISOString(),
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
      diagnostic: null,
    };
    sessions.set(session.sessionId, session);
    try {
      await openCallbackServer(session);
      session.nonce = base64Url(randomBytes(24));
      const built = await authorizationUrlBuilder({
        state: session.state,
        codeChallenge: pkce.challenge,
        redirectUri: session.redirectUri,
        nonce: session.nonce,
      });
      session.authorizationUrl = typeof built === "string" ? built : built?.url;
      session.metadata = typeof built === "object" ? built.metadata ?? null : null;
      if (!session.authorizationUrl) throw new Error("官方 OAuth 没有返回授权页面地址");
      session.timer = setTimeout(() => {
        if (session.status !== "pending") return;
        session.status = "failed";
        session.diagnostic = "官方 OAuth 登录超时，请重新点击登录添加账号。";
        void cleanup(session);
      }, timeoutMs);
      session.timer.unref?.();
    } catch (error) {
      session.status = "failed";
      session.diagnostic = `无法启动官方浏览器授权：${redactError(error)}`;
      await cleanup(session);
    }
    return publicSession(session);
  }

  async function poll(sessionId, context = {}) {
    const session = sessions.get(sessionId);
    if (!session) return missingSession(sessionId, providerId, instructions);
    if (session.status === "failed" || session.status === "completed") {
      const result = session.result ?? publicSession(session);
      sessions.delete(sessionId);
      return result;
    }
    if (!session.callback && typeof pollSession === "function") {
      try {
        const credentials = await pollSession({ metadata: session.metadata, context });
        if (credentials) session.credentials = credentials;
      } catch (error) {
        session.status = "failed";
        session.diagnostic = redactError(error);
        await cleanup(session);
        const result = publicSession(session);
        sessions.delete(sessionId);
        return result;
      }
    }
    if (!session.callback && !session.credentials) return publicSession(session);
    const result = await finalize(session, context);
    if (!["pending", "processing"].includes(result.status)) sessions.delete(sessionId);
    return result;
  }

  async function submitAuthorizationCode(sessionId, input, context = {}) {
    const session = sessions.get(sessionId);
    if (!session) return missingSession(sessionId, providerId, instructions);
    const parsed = extractCodeInput(input);
    if (parsed.state !== session.state) {
      session.callback = { error: "OAuth state 校验失败" };
    } else if (parsed.error) {
      session.callback = { error: parsed.error, state: parsed.state };
    } else if (!parsed.code) {
      session.diagnostic = "请粘贴包含 state 的完整回调地址，或使用 code#state 格式。";
      return publicSession(session);
    } else {
      session.callback = { code: parsed.code, state: parsed.state };
    }
    return finalize(session, context);
  }

  async function dispose() {
    const active = [...sessions.values()];
    sessions.clear();
    await Promise.all(active.map((session) => cleanup(session)));
  }

  async function cancel(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { sessionId, providerId, status: "missing" };
    await cleanup(session);
    sessions.delete(sessionId);
    return { sessionId, providerId, status: "cancelled" };
  }

  return Object.freeze({ begin, poll, submitAuthorizationCode, cancel, dispose });
}

export const browserOAuthAuthorizerConstants = Object.freeze({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  defaultCallbackPath: DEFAULT_CALLBACK_PATH,
});
