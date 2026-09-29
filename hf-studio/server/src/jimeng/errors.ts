// server/src/jimeng/errors.ts —— 即梦 CLI 错误分类（只在结构化字段/退出码上分支，不解析本地化文案）
// 依据：即梦画布 CLI SKILL《错误处置》《积分与人工批准》与 skill references/recovery-and-idempotency.md

export interface JimengError {
  code: string;
  class: string;
  message: string;
  retryable: boolean;
  requiredAction: string;
  creditConfirmation?: { reason: string; minimumCreditCeiling?: number };
  partialData?: { items?: Array<{ nodeId?: string; submitId?: string; resourceId?: string }> };
  validation?: { fieldPath?: string; detail?: string; reasonCode?: string };
}

/** 服务端要求积分确认（退出码 10；报价不等于授权） */
export function isConfirmationRequired(e?: JimengError | null): boolean {
  if (!e) return false;
  return e.requiredAction === "confirm" || e.code === "cli.generation_confirmation_required";
}

/** 需要登录 / 登录失效（退出码 11） */
export function isAuthRequired(e?: JimengError | null): boolean {
  if (!e) return false;
  return e.requiredAction === "login" || e.code.startsWith("cli.auth");
}

/** operation wait 本地等待超时（退出码 20）：任务仍在服务端，用原 submitId 续查，不得重提交 */
export function isWaitTimeout(code: number): boolean {
  return code === 20;
}

/** 可重试（传输/服务类）：退避后复用原提交身份重试 */
export function isRetryableCode(e: JimengError | undefined, code: number | undefined): boolean {
  if (code === 20 || code === 21) return true;
  return e?.retryable === true;
}

/** 需要积分确认时抛出；quote 含服务端建议 ceiling（可缺席 = occupancy_unknown，不得当 0 处理） */
export class JimengConfirmationRequiredError extends Error {
  constructor(
    public readonly reason: string,
    public readonly minimumCreditCeiling: number | undefined,
    public readonly items: Array<{ nodeId?: string; submitId?: string }> = [],
  ) {
    super(
      `即梦需要积分确认：报价${minimumCreditCeiling === undefined ? "未知（occupancy_unknown）" : ` ${minimumCreditCeiling} 积分`}` +
        `。Phase 1 请为任务设置 creditCap${minimumCreditCeiling === undefined ? "（报价未知，暂无法自动继续）" : ` ≥ ${minimumCreditCeiling}`} 后重跑。`,
    );
    this.name = "JimengConfirmationRequiredError";
  }
}

export class JimengAuthRequiredError extends Error {
  constructor() {
    super("即梦 CLI 未登录或登录已失效，请先完成 `dreamina-canvas auth login`（设备授权）");
    this.name = "JimengAuthRequiredError";
  }
}

/** wait 超时但任务仍在服务端：state 已保存 submitId，重跑续查即可 */
export class JimengWaitTimeoutError extends Error {
  constructor(public readonly submitId: string) {
    super(`即梦任务仍在生成中（submitId=${submitId}）。可稍后重跑续查，不会重复提交或二次计费。`);
    this.name = "JimengWaitTimeoutError";
  }
}
