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
    // 渠道默认 disabled，但调用方强制 enabled → 请求不带 thinking 参数（模型正常思考）
    const gw = new LlmGateway(
      [{ ...mockProviders[0], thinking: "disabled" }],
      {
        transport: mockTransport(async (_p, body) => {
          expect(body.thinking).toBeUndefined();
          return { content: "ok" };
        }),
      },
    );
    await gw.chat({ model: "fake/model-a", messages: [], thinking: "enabled" });
    // 渠道默认 disabled，调用方也传 disabled → 请求带 thinking:{type:"disabled"}
    let seen: unknown;
    const gw2 = new LlmGateway(
      [{ ...mockProviders[0], thinking: "disabled" }],
      {
        transport: mockTransport(async (_p, body) => {
          seen = body.thinking;
          return { content: "ok" };
        }),
      },
    );
    await gw2.chat({ model: "fake/model-a", messages: [], thinking: "disabled" });
    expect(seen).toEqual({ type: "disabled" });
  });

  test("per-call reasoningEffort is forwarded to the request body", async () => {
    let seen: unknown;
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async (_p, body) => {
        seen = body.reasoning_effort;
        return { content: "ok" };
      }),
    });
    await gw.chat({ model: "fake/model-a", messages: [], reasoningEffort: "low" });
    expect(seen).toBe("low");
  });

  test("unknown provider throws", async () => {
    const gw = new LlmGateway(mockProviders, { transport: mockTransport(async () => ({ content: "" })) });
    expect(gw.chat({ model: "nope/m", messages: [] })).rejects.toThrow(/unknown provider/);
  });
});
