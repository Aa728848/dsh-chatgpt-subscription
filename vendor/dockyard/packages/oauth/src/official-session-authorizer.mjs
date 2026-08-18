import { randomUUID } from "node:crypto";

import { redactError } from "../../providers/src/provider-utils.mjs";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    providerId: session.providerId,
    status: session.status,
    instructions: session.instructions,
    startedAt: session.startedAt,
    diagnostic: session.diagnostic ?? null,
    ...(session.browserOpened ? { browserOpened: true } : {}),
  };
}

/**
 * Authorizer for an official desktop/client session whose login is owned by
 * another process. The provider supplies a public session reader; this layer
 * only polls it and never handles raw credentials.
 */
export function createOfficialSessionAuthorizer({
  providerId,
  source = "official_client",
  instructions = "请在官方客户端完成登录，完成后回到 Dockyard DSH。",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  browserOpened = false,
  readSession,
  onCancel = null,
} = {}) {
  if (!providerId) throw new Error("Official session authorizer requires providerId");
  if (typeof readSession !== "function") throw new Error(`Official session authorizer requires a reader for ${providerId}`);
  const sessions = new Map();

  function missing(sessionId) {
    return {
      sessionId,
      providerId,
      status: "missing",
      instructions,
      diagnostic: "官方客户端登录会话不存在或已结束，请重新开始授权。",
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
      startedAt: new Date().toISOString(),
      diagnostic: null,
      result: null,
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
          diagnostic: null,
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
    const session = sessions.get(sessionId);
    if (!session) return missing(sessionId);
    try {
      await onCancel?.(context);
    } finally {
      sessions.delete(sessionId);
    }
    return { sessionId, providerId, status: "cancelled" };
  }

  async function submitAuthorizationCode(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return missing(sessionId);
    throw new Error("当前官方客户端授权流程不接收验证码");
  }

  return Object.freeze({ begin, poll, cancel, submitAuthorizationCode });
}

export const officialSessionAuthorizerConstants = Object.freeze({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
});
