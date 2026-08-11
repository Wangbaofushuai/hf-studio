import { z } from "zod";
import { LlmApiError } from "./errors";
import type { LlmProvider } from "../types";

export { LlmApiError } from "./errors"; // 再导出，测试与调用方统一从 gateway 入口引用
export type { LlmProvider } from "../types"; // 从共享类型再导出，避免循环依赖
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatParams { model: string; messages: ChatMessage[]; temperature?: number; seed?: number; maxTokens?: number; timeoutMs?: number; thinking?: "enabled" | "disabled"; reasoningEffort?: "low" | "medium" | "high" }
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
    // 默认 600s：推理模型（如 deepseek-v4-flash）先思考后输出，长 HTML 生成实测可达 20+ 分钟；
    // 调用方可传 timeoutMs 覆盖（step4 的 beat 生成传 15 分钟）
    const t = timeoutMs ?? this.opts.timeoutMs ?? 600_000;
    const abortTimer = setTimeout(() => controller.abort(), t);
    // 双保险超时：Bun 的 fetch 对真实 TLS 长连接挂起时 AbortSignal 中止不可靠（本地 HTTP 正常，
    // 实测真实长请求 300s 超时不触发），fetch promise 可能永久挂起导致引擎卡死。
    // 用 Promise.race 保证 timeoutMs 内一定 reject，调用方（引擎重试循环）得以恢复。
    let raceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutRace = new Promise<never>((_, reject) => {
      raceTimer = setTimeout(() => reject(new LlmApiError(`timeout after ${t}ms`, "timeout", true)), t);
    });
    try {
      return await Promise.race([
        fetch(`${provider.baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        }).then(async (res) => {
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
        }),
        timeoutRace,
      ]);
    } catch (e) {
      if (e instanceof LlmApiError) throw e;
      if (e instanceof Error && e.name === "AbortError") throw new LlmApiError(`timeout after ${t}ms`, "timeout", true);
      throw new LlmApiError(`network error: ${e instanceof Error ? e.message : String(e)}`, "network", true);
    } finally {
      clearTimeout(abortTimer);
      if (raceTimer) clearTimeout(raceTimer);
    }
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const { provider, modelId } = this.resolve(params.model);
    const body: Record<string, unknown> = {
      model: modelId,
      messages: params.messages,
      temperature: params.temperature ?? provider.temperature ?? 0.7,
    };
    // 推理模型思考开关：渠道配置 thinking:"disabled" 时默认关闭思考（如 deepseek-v4-flash，
    // 生成速度提升一个数量级）；调用方可用 params.thinking 覆盖——
    // 例如 step4/step5 的 HTML 生成要求严格遵守 composition 契约，强制 thinking:"enabled"
    const thinking = params.thinking ?? provider.thinking;
    if (thinking === "disabled") {
      body.thinking = { type: "disabled" };
      // 思考关闭时 effort 无意义；部分渠道（火山方舟 ark）直接拒绝 reasoning_effort +
      // thinking:disabled 组合（400 InvalidParameter），故此时一律省略 reasoning_effort。
    } else if (thinking === "enabled") {
      // 对称透传 enabled：调用方强制开启思考时也显式发送，避免请求缺 thinking 字段让渠道走默认行为。
      // （deepseek-v4-flash 在未显式指定思考模式时行为不可预期，曾致 step4 生成行为异常）
      body.thinking = { type: "enabled" };
      // 仅思考模式下 effort 才有效且被渠道接受，放这里一并发送
      if (params.reasoningEffort) body.reasoning_effort = params.reasoningEffort;
    } else if (params.reasoningEffort) {
      // 未显式声明思考模式（thinking 与渠道都未配置）：同样省略 effort（该组合在部分渠道无效），
      // 不发送。若未来需要在此场景下发 effort，应同时显式开启 thinking。
    }
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
