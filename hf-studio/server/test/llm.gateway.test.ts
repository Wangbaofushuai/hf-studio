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
  });

  test("unknown provider throws", async () => {
    const gw = new LlmGateway(mockProviders, { transport: mockTransport(async () => ({ content: "" })) });
    expect(gw.chat({ model: "nope/m", messages: [] })).rejects.toThrow(/unknown provider/);
  });
});
