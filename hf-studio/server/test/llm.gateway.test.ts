import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { LlmGateway, LlmApiError } from "../src/llm/gateway";
import { mockTransport, mockProviders } from "./fixtures/mock-transport";

describe("LlmGateway", () => {
  test("chat routes provider/model and returns content", async () => {
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async (provider, body) => {
        expect(provider.id).toBe("fake");
        expect(body.model).toBe("model-a");
        expect((body.messages as { role: string }[])[0].role).toBe("system");
        return { content: "hello" };
      }),
    });
    const r = await gw.chat({ model: "fake/model-a", messages: [{ role: "system", content: "hi" }] });
    expect(r.content).toBe("hello");
  });

  test("chatJson strips code fences and parses JSON via zod", async () => {
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async () => ({ content: '```json\n{"a": 1}\n```' })),
    });
    const schema = z.object({ a: z.number() });
    const { data } = await gw.chatJson({ model: "fake/model-a", messages: [] }, schema);
    expect(data.a).toBe(1);
  });

  test("chatJson throws ZodError on invalid output", async () => {
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async () => ({ content: "not json" })),
    });
    const schema = z.object({ a: z.number() });
    expect(gw.chatJson({ model: "fake/model-a", messages: [] }, schema)).rejects.toThrow();
  });

  test("chat rejects within timeoutMs when server hangs (never resolves)", async () => {
    const server = Bun.serve({ port: 39989, fetch: () => new Promise(() => {}) });
    try {
      const gw = new LlmGateway([{ id: "hang", baseURL: "http://127.0.0.1:39989/v1", apiKey: "k", models: ["m"] }]);
      const t0 = Date.now();
      let err: unknown;
      try { await gw.chat({ model: "hang/m", messages: [], timeoutMs: 1500 }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(LlmApiError);
      expect((err as LlmApiError).retryable).toBe(true);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(10000);
    } finally {
      server.stop(true);
    }
  });

  test("chat rejects via timeout race fallback even when fetch ignores abort signal", async () => {
    // 回归保护：Bun 的 fetch 对真实 TLS 长连接挂起时 AbortSignal 中止不可靠（本地 HTTP 正常、
    // 实测真实长请求 300s 超时不触发），fetch promise 可能永久挂起。若只依赖 AbortController，
    // chat 永不 reject → 引擎永久卡死。本测试用忽略 signal 的假 fetch 模拟该场景，
    // 断言 Promise.race 兜底保证 timeoutMs 内一定 reject。
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch; // 永不 resolve，且忽略 signal
    try {
      const gw = new LlmGateway([{ id: "hang", baseURL: "http://hang/v1", apiKey: "k", models: ["m"] }]);
      const t0 = Date.now();
      let err: unknown;
      try { await gw.chat({ model: "hang/m", messages: [], timeoutMs: 1200 }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(LlmApiError);
      expect((err as LlmApiError).retryable).toBe(true);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(1100);
      expect(elapsed).toBeLessThan(10000);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("retryChat retries on retryable errors and fails after attempts", async () => {
    let calls = 0;
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async () => {
        calls++;
        if (calls < 3) throw new LlmApiError("rate limited", "rate_limit", true);
        return { content: "ok" };
      }),
    });
    const r = await gw.retryChat({ model: "fake/model-a", messages: [] }, 3);
    expect(r.content).toBe("ok");
    expect(calls).toBe(3);

    const gw2 = new LlmGateway(mockProviders, {
      transport: mockTransport(async () => {
        throw new LlmApiError("always fails", "server", true);
      }),
    });
    expect(gw2.retryChat({ model: "fake/model-a", messages: [] }, 2)).rejects.toThrow(LlmApiError);
  }, 20000); // 退避 1s+2s+4s 超过 bun 默认 5s 单测超时（预置 flake），显式放宽

  test("chat sends thinking disabled when provider configures it", async () => {
    let seen: unknown;
    const gw = new LlmGateway(
      [{ ...mockProviders[0], thinking: "disabled" }],
      {
        transport: mockTransport(async (_p, body) => {
          seen = body.thinking;
          return { content: "ok" };
        }),
      },
    );
    await gw.chat({ model: "fake/model-a", messages: [] });
    expect(seen).toEqual({ type: "disabled" });
  });

  test("chat omits thinking param when provider does not configure it", async () => {
    let seen: unknown = "unset";
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async (_p, body) => {
        seen = body.thinking;
        return { content: "ok" };
      }),
    });
    await gw.chat({ model: "fake/model-a", messages: [] });
    expect(seen).toBeUndefined();
  });

  test("per-call thinking override wins over provider config", async () => {
    // 渠道默认 disabled，但调用方强制 enabled → 对称发送 thinking:{type:"enabled"}。
    // 只对 disabled 处理（enabled 不发送）会让请求缺 thinking 字段，deepseek-v4-flash
    // 走默认行为、行为不可预期——显式透传让渠道按调用方意图执行。
    let seen: unknown;
    const gw = new LlmGateway(
      [{ ...mockProviders[0], thinking: "disabled" }],
      {
        transport: mockTransport(async (_p, body) => {
          seen = body.thinking;
          return { content: "ok" };
        }),
      },
    );
    await gw.chat({ model: "fake/model-a", messages: [], thinking: "enabled" });
    expect(seen).toEqual({ type: "enabled" });
    // 渠道默认 disabled，调用方也传 disabled → 请求带 thinking:{type:"disabled"}
    let seen2: unknown;
    const gw2 = new LlmGateway(
      [{ ...mockProviders[0], thinking: "disabled" }],
      {
        transport: mockTransport(async (_p, body) => {
          seen2 = body.thinking;
          return { content: "ok" };
        }),
      },
    );
    await gw2.chat({ model: "fake/model-a", messages: [], thinking: "disabled" });
    expect(seen2).toEqual({ type: "disabled" });
  });

  test("per-call reasoningEffort is forwarded to the request body when thinking is enabled", async () => {
    let seen: unknown;
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async (_p, body) => {
        seen = body.reasoning_effort;
        return { content: "ok" };
      }),
    });
    await gw.chat({ model: "fake/model-a", messages: [], thinking: "enabled", reasoningEffort: "low" });
    expect(seen).toBe("low");
  });

  test("reasoning_effort is omitted when thinking is disabled (ark rejects low + disabled)", async () => {
    // 回归：火山方舟 ark API 对 reasoning_effort + thinking:{type:"disabled"} 的组合
    // 返回 400 InvalidParameter（deepseek 官方接受、ark 拒绝）。思考关闭时 effort 无意义，
    // 必须省略该参数，避免构建步骤整批失败。
    let seen: unknown = "unset";
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async (_p, body) => {
        seen = body.reasoning_effort;
        return { content: "ok" };
      }),
    });
    await gw.chat({ model: "fake/model-a", messages: [], thinking: "disabled", reasoningEffort: "low" });
    expect(seen).toBeUndefined();
  });

  test("reasoning_effort is omitted when thinking is unset (no thinking param at all)", async () => {
    // 未显式声明思考模式时同样省略 effort（该组合在部分渠道无效）
    let seen: unknown = "unset";
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async (_p, body) => {
        seen = body.reasoning_effort;
        return { content: "ok" };
      }),
    });
    await gw.chat({ model: "fake/model-a", messages: [], reasoningEffort: "medium" });
    expect(seen).toBeUndefined();
  });

  test("unknown provider throws", async () => {
    const gw = new LlmGateway(mockProviders, { transport: mockTransport(async () => ({ content: "" })) });
    expect(gw.chat({ model: "nope/m", messages: [] })).rejects.toThrow(/unknown provider/);
  });
});
