import { z } from "zod";
import { LlmApiError } from "./errors";
import type { LlmProvider } from "../types";

export { LlmApiError } from "./errors"; // 再导出，测试与调用方统一从 gateway 入口引用
export type { LlmProvider } from "../types"; // 从共享类型再导出，避免循环依赖
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatParams { model: string; messages: ChatMessage[]; temperature?: number; seed?: number; maxTokens?: number; timeoutMs?: number }
export interface ChatResult { content: string; promptTokens: number; completionTokens: number }
export type Transport = (provider: LlmProvider, body: Record<string, unknown>, timeoutMs?: number) => Promise<ChatResult>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlmGateway {
  private providers = new Map<string, LlmProvider>();
  constructor(providers: LlmProvider[], private opts: { transport?: Transport; timeoutMs?: number } = {}) {
    for (const p of providers) this.providers.set(p.id, p);
  }

  private resolve(model: string): { provider: LlmProvider; modelId: string } {
    const [pid, ...rest] = model.split("/");
    const provider = this.providers.get(pid);
    if (!provider) throw new Error(`unknown provider: ${pid} (configured: ${[...this.providers.keys()].join(", ")})`);
    return { provider, modelId: rest.join("/") };
  }

  private async defaultTransport(provider: LlmProvider, body: Record<string, unknown>, timeoutMs?: number): Promise<ChatResult> {
    const controller = new AbortController();
    // 默认 300s：推理模型（如 deepseek-v4-flash）先思考后输出，长 HTML 生成可超 120s；
    // 调用方可传 timeoutMs 覆盖（step4 的 beat 生成传更长超时）
    const t = timeoutMs ?? this.opts.timeoutMs ?? 300_000;
    const timer = setTimeout(() => controller.abort(), t);
    try {
      const res = await fetch(`${provider.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) throw new LlmApiError(`auth failed (${res.status})`, "auth", false);
      if (res.status === 429) throw new LlmApiError(`rate limited (${res.status})`, "rate_limit", true);
      if (res.status >= 500) throw new LlmApiError(`server error (${res.status})`, "server", true);
      if (!res.ok) throw new LlmApiError(`http ${res.status}: ${await res.text()}`, "server", true);
      const json = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = json.choices?.[0]?.message?.content ?? "";
      return {
        content,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      };
    } catch (e) {
      if (e instanceof LlmApiError) throw e;
      if (e instanceof Error && e.name === "AbortError") throw new LlmApiError(`timeout after ${t}ms`, "timeout", true);
      throw new LlmApiError(`network error: ${e instanceof Error ? e.message : String(e)}`, "network", true);
    }
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const { provider, modelId } = this.resolve(params.model);
    const body: Record<string, unknown> = {
      model: modelId,
      messages: params.messages,
      temperature: params.temperature ?? provider.temperature ?? 0.7,
    };
    if (params.seed !== undefined) body.seed = params.seed;
    if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
    const transport = this.opts.transport ?? this.defaultTransport.bind(this);
    return transport(provider, body, params.timeoutMs);
  }

  async chatJson<T>(params: ChatParams, schema: z.ZodType<T>): Promise<{ data: T; raw: string }> {
    const r = await this.chat(params);
    const raw = r.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const data = schema.parse(JSON.parse(raw));
    return { data, raw };
  }

  async retryChat(params: ChatParams, attempts = 3): Promise<ChatResult> {
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await this.chat(params);
      } catch (e) {
        last = e;
        if (!(e instanceof LlmApiError) || !e.retryable) throw e;
        await sleep(1000 * 2 ** (i - 1));
      }
    }
    throw last;
  }
}
