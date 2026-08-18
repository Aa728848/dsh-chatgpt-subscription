import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createAntigravityNativeExecutor,
  createAntigravityProjectResolver,
} from "../modules/provider-antigravity/src/index.mjs";
import { createClaudeNativeExecutor } from "../modules/provider-claude/src/index.mjs";
import { createGrokNativeExecutor } from "../modules/provider-grok/src/index.mjs";
import { createCursorNativeExecutor } from "../modules/provider-cursor/src/index.mjs";
import { bytesField, frameConnectMessage, stringField } from "../modules/provider-cursor/src/native-protocol.mjs";
import {
  fetchNativeResponse,
  readSseEvents,
  validateNativeEndpoint,
} from "../packages/providers/src/native-transport.mjs";

function responseFor(events) {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return {
    ok: true,
    status: 200,
    body: (async function* stream() {
      yield new TextEncoder().encode(payload);
    })(),
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("native transports reject plaintext remote endpoints before attaching credentials", () => {
  assert.equal(validateNativeEndpoint("http://127.0.0.1:3000", { providerId: "test" }), "http://127.0.0.1:3000/");
  assert.throws(
    () => validateNativeEndpoint("http://provider.test/v1", { providerId: "test" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => validateNativeEndpoint("https://user:pass@provider.test/v1", { providerId: "test" }),
    /embedded credentials/,
  );
  assert.throws(
    () => createGrokNativeExecutor({ endpoint: "http://provider.test/v1/chat/completions" }),
    /must use HTTPS/,
  );
});

test("native SSE timeout remains active while the response body is stalled", async () => {
  let signal;
  const response = await fetchNativeResponse("https://provider.test/stream", {
    method: "GET",
  }, {
    providerId: "test-provider",
    timeoutMs: 15,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              read() {
                return new Promise((_, reject) => {
                  signal.addEventListener("abort", () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                  }, { once: true });
                });
              },
              releaseLock() {},
            };
          },
        },
      };
    },
  });
  await assert.rejects(
    (async () => {
      for await (const _event of readSseEvents(response)) {
        // The stalled body should be aborted by the native deadline.
      }
    })(),
    (error) => error.code === "ETIMEDOUT",
  );
});

test("Claude subscription transport refuses environment and plaintext-file fallback", async () => {
  const executor = createClaudeNativeExecutor({
    env: { ANTHROPIC_API_KEY: "must-not-be-used", CLAUDE_CODE_OAUTH_TOKEN: "must-not-be-used" },
    home: "C:/must-not-be-read",
    fetchImpl: async () => { throw new Error("network must not be reached"); },
  });
  await assert.rejects(
    () => executor({ request: { model: "claude-model", messages: [] } }),
    /authorize Claude first/,
  );
});

test("Claude native transport posts Anthropic Messages and streams the first text delta", async () => {
  let call;
  const executor = createClaudeNativeExecutor({
    endpoint: "https://anthropic.test/v1/messages",
    tokenResolver: async () => ({ token: "oauth-token", kind: "oauth" }),
    fetchImpl: async (url, init) => {
      call = { url, init };
      return responseFor([
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      ]);
    },
  });
  const chunks = await collect(await executor({
    request: { model: "claude-sonnet", system: "Be concise.", messages: [{ role: "user", content: "Hi" }] },
  }));
  const body = JSON.parse(call.init.body);
  assert.equal(call.url, "https://anthropic.test/v1/messages");
  assert.equal(call.init.headers.authorization, "Bearer oauth-token");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
  assert.deepEqual(chunks.filter((chunk) => chunk.type === "text-delta"), [{ type: "text-delta", index: 0, text: "hello" }]);
  assert.deepEqual(chunks.find((chunk) => chunk.type === "usage")?.usage, { inputTokens: 2, outputTokens: 3 });
});

test("native transports frame reasoning blocks with matching start and end events", async () => {
  const claude = createClaudeNativeExecutor({
    endpoint: "https://anthropic.test/v1/messages",
    tokenResolver: async () => ({ token: "oauth-token", kind: "oauth" }),
    fetchImpl: async () => responseFor([
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    ]),
  });
  const claudeChunks = await collect(await claude({ request: { model: "claude", messages: [{ role: "user", content: "hi" }] } }));
  const claudeReasoning = claudeChunks.filter((chunk) => chunk.index === 1 && ["block-start", "reasoning-delta", "block-end"].includes(chunk.type));
  assert.deepEqual(claudeReasoning.map((chunk) => chunk.type), ["block-start", "reasoning-delta", "block-end"]);

  const grok = createGrokNativeExecutor({
    endpoint: "https://grok.test/v1/chat/completions",
    fetchImpl: async () => responseFor([
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
       { usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } },
    ]),
  });
  const grokChunks = await collect(await grok({ request: { model: "grok", messages: [{ role: "user", content: "hi" }] }, credential: { access: "token" } }));
  const grokReasoning = grokChunks.filter((chunk) => chunk.index === 1 && ["block-start", "reasoning-delta", "block-end"].includes(chunk.type));
  assert.deepEqual(grokReasoning.map((chunk) => chunk.type), ["block-start", "reasoning-delta", "block-end"]);
  assert.deepEqual(grokChunks.find((chunk) => chunk.type === "usage")?.usage, { inputTokens: 4, outputTokens: 5, totalTokens: 9 });

  const antigravity = createAntigravityNativeExecutor({
    endpoint: "https://gemini.test/v1internal:streamGenerateContent?alt=sse",
    tokenResolver: () => ({ token: "token" }),
    fetchImpl: async () => responseFor([
      { candidates: [{ content: { parts: [{ text: "think", thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }] },
       { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17, cachedContentTokenCount: 3 } },
    ]),
  });
  const antigravityChunks = await collect(await antigravity({ request: { model: "gemini", messages: [{ role: "user", content: "hi" }] } }));
  const antigravityReasoning = antigravityChunks.filter((chunk) => chunk.index === 1 && ["block-start", "reasoning-delta", "block-end"].includes(chunk.type));
  assert.deepEqual(antigravityReasoning.map((chunk) => chunk.type), ["block-start", "reasoning-delta", "block-end"]);
});

test("Antigravity native transport uses streamGenerateContent SSE", async () => {
  let call;
  const executor = createAntigravityNativeExecutor({
    endpoint: "https://gemini.test/v1internal:streamGenerateContent?alt=sse",
    tokenResolver: () => ({ token: "google-token", kind: "oauth" }),
    fetchImpl: async (url, init) => {
      call = { url, init };
      return responseFor([
        { candidates: [{ content: { parts: [{ text: "fast" }] } }] },
        { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17, cachedContentTokenCount: 3 } },
      ]);
    },
  });
  const chunks = await collect(await executor({
    request: { model: "gemini-3.7-flash-medium", reasoningEffort: "medium", messages: [{ role: "user", content: "Hi" }] },
  }));
  const body = JSON.parse(call.init.body);
  assert.match(call.url, /streamGenerateContent\?alt=sse$/);
  assert.equal(call.init.headers.authorization, "Bearer google-token");
  assert.equal(call.init.headers.accept, undefined);
  assert.equal(body.project, "default-cli-project");
  assert.equal(body.model, "gemini-3.7-flash-medium");
  assert.deepEqual(body.request.contents[0], { role: "user", parts: [{ text: "Hi" }] });
  assert.deepEqual(body.request.generationConfig, { temperature: 0.7, maxOutputTokens: 4096 });
  assert.equal(body.request.generationConfig.thinkingConfig, undefined);
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "fast");
  assert.deepEqual(chunks.find((chunk) => chunk.type === "usage")?.usage, {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
    cacheReadTokens: 3,
  });
});

test("Antigravity native transport resolves a Code Assist project per selected account", async () => {
  const calls = [];
  const projectResolver = createAntigravityProjectResolver({
    endpoint: "https://gemini.test/v1internal:loadCodeAssist",
    tokenResolver: () => ({ token: "google-token" }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return { cloudaicompanionProject: "account-project" };
        },
      };
    },
  });
  const executor = createAntigravityNativeExecutor({
    endpoint: "https://gemini.test/v1internal:streamGenerateContent?alt=sse",
    project: null,
    projectResolver,
    tokenResolver: () => ({ token: "google-token" }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responseFor([{ candidates: [{ content: { parts: [{ text: "account" }] } }] }]);
    },
  });
  await collect(await executor({
    invocation: {
      account: { accountId: "account-a", auth: { credentialRef: "keychain://account-a" } },
    },
    request: { model: "gemini-3.7-flash", messages: [{ role: "user", content: "Hi" }] },
  }));
  const projectCall = calls.find((call) => call.url.includes("loadCodeAssist"));
  const streamCall = calls.find((call) => call.url.includes("streamGenerateContent"));
  assert.deepEqual(JSON.parse(projectCall.init.body), {});
  assert.equal(projectCall.init.headers.authorization, "Bearer google-token");
  assert.equal(JSON.parse(streamCall.init.body).project, "account-project");
});

test("native HTTP errors keep the upstream rate-limit signal without leaking raw JSON", async () => {
  const executor = createAntigravityNativeExecutor({
    endpoint: "https://gemini.test/v1internal:streamGenerateContent?alt=sse",
    tokenResolver: () => ({ token: "google-token", kind: "oauth" }),
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota)",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
    }),
  });

  await assert.rejects(
    () => executor({ request: { model: "gemini-3.7-flash-medium", messages: [{ role: "user", content: "Hi" }] } }),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, 429);
      assert.equal(error.upstreamCode, 429);
      assert.equal(error.upstreamStatus, "RESOURCE_EXHAUSTED");
      assert.equal(error.quotaExhausted, true);
      assert.equal(error.rateLimited, true);
      assert.match(error.message, /额度或上游资源已耗尽/);
      assert.equal(error.upstreamMessage, "Resource has been exhausted (e.g. check quota)");
      assert.doesNotMatch(error.message, /\"error\"/);
      return true;
    },
  );
});

test("Grok native transport uses xAI chat completions SSE and forwards OAuth directly", async () => {
  let call;
  const executor = createGrokNativeExecutor({
    endpoint: "https://xai.test/v1/chat/completions",
    fetchImpl: async (url, init) => {
      call = { url, init };
      return responseFor([{ choices: [{ delta: { content: "xAI" } }] }, { choices: [{ finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 4, completion_tokens: 5 } }]);
    },
  });
  const chunks = await collect(await executor({
    credential: { access: "grok-oauth" },
    request: { model: "grok-4.5", messages: [{ role: "user", content: "Hi" }] },
  }));
  const body = JSON.parse(call.init.body);
  assert.equal(call.url, "https://xai.test/v1/chat/completions");
  assert.equal(call.init.headers.authorization, "Bearer grok-oauth");
  assert.equal(body.messages[0].content, "Hi");
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "xAI");
  assert.deepEqual(chunks.find((chunk) => chunk.type === "usage")?.usage, { inputTokens: 4, outputTokens: 5 });
});

test("Grok subscription transport refuses API-key environment fallback", async () => {
  const executor = createGrokNativeExecutor({
    env: { XAI_API_KEY: "must-not-be-used", GROK_API_KEY: "must-not-be-used" },
    fetchImpl: async () => { throw new Error("network must not be reached"); },
  });
  await assert.rejects(
    () => executor({ request: { model: "grok-4", messages: [] } }),
    /OAuth token is missing from secure storage/,
  );
});

test("Grok native transport maps images, tools, tool results, and streamed tool calls", async () => {
  let requestBody;
  const executor = createGrokNativeExecutor({
    endpoint: "https://xai.test/v1/chat/completions",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return responseFor([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "lookup", arguments: "{\"q\":" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"weather\"}" } }] } }] },
        { choices: [{ finish_reason: "tool_calls", delta: {} }] },
      ]);
    },
  });
  const chunks = await collect(await executor({
    credential: { access: "grok-oauth" },
    request: {
      model: "grok-vision",
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", data: "aGVsbG8=", mediaType: "image/png" }] },
        { role: "tool", toolCallId: "previous", content: "sunny" },
      ],
    },
  }));
  assert.equal(requestBody.messages[0].content[1].image_url.url, "data:image/png;base64,aGVsbG8=");
  assert.equal(requestBody.messages[1].role, "tool");
  assert.equal(requestBody.messages[1].tool_call_id, "previous");
  assert.equal(requestBody.tools[0].function.name, "lookup");
  assert.equal(chunks.filter((chunk) => chunk.type === "tool-call-delta").length, 2);
  assert.equal(chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call")?.block.arguments, "{\"q\":\"weather\"}");
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
});

test("Grok token-validation errors mark the OAuth account unusable", async () => {
  const executor = createGrokNativeExecutor({
    endpoint: "https://xai.test/v1/chat/completions",
    fetchImpl: async () => responseFor([{
      error: {
        code: "unauthorized",
        message: "access token could not be validated",
      },
    }]),
  });
  await assert.rejects(
    collect(await executor({
      credential: { access: "stale-grok-oauth" },
      request: { model: "grok-4.6", messages: [{ role: "user", content: "Hi" }] },
    })),
    (error) => {
      assert.equal(error.authExpired, true);
      assert.equal(error.authForbidden, false);
      assert.match(error.message, /access token could not be validated/);
      return true;
    },
  );
});

test("Cursor native transport rejects oversized Connect frames and cumulative responses", async () => {
  const run = async ({ chunks, maxFrameBytes = 16, maxBufferBytes = 21, maxResponseBytes = 32 }) => {
    const fakeHttp2 = {
      constants: { NGHTTP2_CANCEL: 8 },
      connect() {
        const session = new EventEmitter();
        session.closed = false; session.destroyed = false; session.close = () => { session.closed = true; };
        session.request = () => {
          const stream = new EventEmitter();
          stream.destroyed = false; stream.closed = false;
          stream.write = () => setImmediate(() => {
            stream.emit("response", { ":status": 200 });
            for (const chunk of chunks) stream.emit("data", Buffer.from(chunk));
          });
          stream.close = () => { stream.closed = true; };
          return stream;
        };
        return session;
      },
    };
    const executor = createCursorNativeExecutor({
      tokenResolver: () => ({ token: "cursor-oauth", kind: "oauth" }), http2Module: fakeHttp2,
      maxFrameBytes, maxBufferBytes, maxResponseBytes, timeoutMs: 100,
    });
    return collect(await executor({ request: { model: "cursor-model", messages: [{ role: "user", content: "Hi" }] } }));
  };
  const oversizedHeader = Uint8Array.from([0, 0, 0, 1, 0]);
  await assert.rejects(() => run({ chunks: [oversizedHeader] }), (error) => error.code === "CURSOR_FRAME_TOO_LARGE");
  await assert.rejects(
    () => run({ chunks: [Uint8Array.from([0, 0, 0, 0, 16]), new Uint8Array(17)], maxFrameBytes: 16, maxBufferBytes: 12 }),
    (error) => error.code === "CURSOR_BUFFER_TOO_LARGE",
  );
  await assert.rejects(
    () => run({ chunks: [frameConnectMessage(bytesField(1, stringField(1, "first"))), frameConnectMessage(bytesField(1, stringField(1, "second")))] , maxResponseBytes: 12 }),
    (error) => error.code === "CURSOR_RESPONSE_TOO_LARGE",
  );
});

test("Cursor native transport opens AgentService over HTTP/2 Connect frames", async () => {
  let written;
  const fakeHttp2 = {
    constants: { NGHTTP2_CANCEL: 8 },
    connect() {
      const session = new EventEmitter();
      session.closed = false;
      session.destroyed = false;
      session.close = () => { session.closed = true; };
      session.request = () => {
        const stream = new EventEmitter();
        stream.destroyed = false;
        stream.closed = false;
        stream.write = (value) => {
          written ??= Buffer.from(value);
          if (!written || written.length !== value.length) return;
          setImmediate(() => {
            stream.emit("response", { ":status": 200 });
            const interactionUpdate = bytesField(1, stringField(1, "cursor"));
            stream.emit("data", Buffer.from(frameConnectMessage(bytesField(1, interactionUpdate))));
             stream.emit("data", Buffer.from(frameConnectMessage(new Uint8Array(), 0x02)));
            stream.emit("end");
          });
        };
        stream.close = () => { stream.closed = true; };
        return stream;
      };
      return session;
    },
  };
  const executor = createCursorNativeExecutor({
    tokenResolver: () => ({ token: "cursor-oauth", kind: "oauth" }),
    http2Module: fakeHttp2,
  });
  const chunks = await collect(await executor({
    request: { model: "grok-4.5", requestId: "request-1", messages: [{ role: "user", content: "Hi" }] },
  }));
  assert.ok(written);
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "cursor");
  assert.equal(chunks.at(-1).type, "finish");
});

test("Cursor native transport enforces a hard request timeout", async () => {
  const fakeHttp2 = {
    constants: { NGHTTP2_CANCEL: 8 },
    connect() {
      const session = new EventEmitter();
      session.closed = false;
      session.destroyed = false;
      session.close = () => { session.closed = true; };
      session.request = () => {
        const stream = new EventEmitter();
        stream.destroyed = false;
        stream.closed = false;
        stream.write = () => {};
        stream.close = () => { stream.closed = true; };
        return stream;
      };
      return session;
    },
  };
  const executor = createCursorNativeExecutor({
    tokenResolver: () => ({ token: "cursor-oauth", kind: "oauth" }),
    http2Module: fakeHttp2,
    timeoutMs: 5,
  });
  await assert.rejects(
    async () => collect(await executor({ request: { model: "cursor-model", messages: [{ role: "user", content: "Hi" }] } })),
    (error) => error?.code === "CURSOR_REQUEST_TIMEOUT",
  );
});

test("Cursor native transport preserves text across split Connect frames", async () => {
  const textFrame = frameConnectMessage(bytesField(1, bytesField(1, stringField(1, "split"))));
  const completeFrame = frameConnectMessage(new Uint8Array(), 0x02);
  const bytes = Buffer.concat([Buffer.from(textFrame), Buffer.from(completeFrame)]);
  const fakeHttp2 = {
    constants: { NGHTTP2_CANCEL: 8 },
    connect() {
      const session = new EventEmitter();
      session.closed = false;
      session.destroyed = false;
      session.close = () => { session.closed = true; };
      session.request = () => {
        const stream = new EventEmitter();
        stream.destroyed = false;
        stream.closed = false;
        stream.write = () => {
          setImmediate(() => {
            stream.emit("response", { ":status": 200 });
            for (let index = 0; index < bytes.length; index += 1) {
              stream.emit("data", bytes.subarray(index, index + 1));
            }
            stream.emit("end");
          });
        };
        stream.close = () => { stream.closed = true; };
        return stream;
      };
      return session;
    },
  };
  const executor = createCursorNativeExecutor({
    tokenResolver: () => ({ token: "cursor-oauth", kind: "oauth" }),
    http2Module: fakeHttp2,
  });
  const chunks = await collect(await executor({
    request: { model: "composer-2.5", requestId: "request-split", messages: [{ role: "user", content: "Hi" }] },
  }));
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "split");
  assert.equal(chunks.at(-1).type, "finish");
});

test("Cursor native transport rejects a truncated Connect frame", async () => {
  const frame = frameConnectMessage(bytesField(1, bytesField(1, stringField(1, "truncated"))));
  const truncated = frame.slice(0, frame.length - 1);
  const fakeHttp2 = {
    constants: { NGHTTP2_CANCEL: 8 },
    connect() {
      const session = new EventEmitter();
      session.closed = false;
      session.destroyed = false;
      session.close = () => { session.closed = true; };
      session.request = () => {
        const stream = new EventEmitter();
        stream.destroyed = false;
        stream.closed = false;
        stream.write = () => {
          setImmediate(() => {
            stream.emit("response", { ":status": 200 });
            stream.emit("data", Buffer.from(truncated));
            stream.emit("end");
          });
        };
        stream.close = () => { stream.closed = true; };
        return stream;
      };
      return session;
    },
  };
  const executor = createCursorNativeExecutor({
    tokenResolver: () => ({ token: "cursor-oauth", kind: "oauth" }),
    http2Module: fakeHttp2,
  });
  await assert.rejects(
    collect(await executor({
      request: { model: "composer-2.5", requestId: "request-truncated", messages: [{ role: "user", content: "Hi" }] },
    })),
    (error) => {
      assert.equal(error.code, "CURSOR_INCOMPLETE_RESPONSE");
      assert.equal(error.cursorDiagnostics.at(-1).incomplete, true);
      return true;
    },
  );
});

test("Cursor native transport rejects a completed turn with no assistant text", async () => {
  const fakeHttp2 = {
    constants: { NGHTTP2_CANCEL: 8 },
    connect() {
      const session = new EventEmitter();
      session.closed = false;
      session.destroyed = false;
      session.close = () => { session.closed = true; };
      session.request = () => {
        const stream = new EventEmitter();
        stream.destroyed = false;
        stream.closed = false;
        stream.write = () => {
          setImmediate(() => {
            stream.emit("response", { ":status": 200 });
            stream.emit("data", Buffer.from(frameConnectMessage(bytesField(2, stringField(1, "ignored")))));
            stream.emit("data", Buffer.from(frameConnectMessage(new Uint8Array(), 0x02)));
            stream.emit("end");
          });
        };
        stream.close = () => { stream.closed = true; };
        return stream;
      };
      return session;
    },
  };
  const executor = createCursorNativeExecutor({
    tokenResolver: () => ({ token: "cursor-oauth", kind: "oauth" }),
    http2Module: fakeHttp2,
  });
  await assert.rejects(
    collect(await executor({
      request: { model: "composer-2.5", requestId: "request-empty", messages: [{ role: "user", content: "Hi" }] },
    })),
    (error) => {
      assert.equal(error.code, "CURSOR_EMPTY_RESPONSE");
      assert.match(error.message, /completed without assistant text/);
      assert.deepEqual(error.cursorDiagnostics[0].fieldPaths.map((field) => field.path), ["2", "2.1"]);
      assert.equal(error.cursorDiagnostics[0].flags, 0);
      return true;
    },
  );
});
