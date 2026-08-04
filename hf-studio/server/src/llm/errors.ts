export class LlmApiError extends Error {
  constructor(message: string, public kind: "timeout" | "rate_limit" | "auth" | "server" | "network", public retryable: boolean) {
    super(message);
    this.name = "LlmApiError";
  }
}
