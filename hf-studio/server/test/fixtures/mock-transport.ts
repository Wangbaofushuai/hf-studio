import type { LlmProvider, Transport } from "../../src/llm/gateway";

export function mockTransport(handler: (provider: LlmProvider, body: Record<string, unknown>, timeoutMs?: number) => Promise<{ content: string; promptTokens?: number; completionTokens?: number }>): Transport {
  return async (provider, body, timeoutMs) => {
    const r = await handler(provider, body, timeoutMs);
    return { content: r.content, promptTokens: r.promptTokens ?? 10, completionTokens: r.completionTokens ?? 10 };
  };
}

export const mockProviders: LlmProvider[] = [
  { id: "fake", baseURL: "http://localhost:1/v1", apiKey: "k", models: ["fake/model-a"] },
];
