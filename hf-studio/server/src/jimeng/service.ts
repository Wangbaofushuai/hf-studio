// server/src/jimeng/service.ts —— 即梦直出服务状态机（Phase 1 单条 / Phase 2 分镜 / Phase 2.1 锚点）
// 职责：把"建画布→存节点→报价→运行→等待→下载"编排成幂等流程；
// 任何重跑复用已保存的 projectId/nodeId/submitId，绝不重复提交（见 spec §3.8 与 SKILL 恢复协议）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { JimengCli, CliResult } from "./cli";
import {
  isAuthRequired,
  isConfirmationRequired,
  isWaitTimeout,
  JimengAuthRequiredError,
  JimengConfirmationRequiredError,
  JimengWaitTimeoutError,
  type JimengError,
} from "./errors";

export interface JimengVideoRequest {
  prompt: string;
  model: string;
  ratio: string;
  resolution: string;
  durationSec: number;
  count?: number;
  title?: string;
  creditCap?: number;
  /** Phase 2：m2v（带参考素材）或 t2v；refs 形如 node:<id> */
  mode?: "t2v" | "m2v";
  refs?: string[];
}

export interface JimengImageRequest {
  prompt: string;
  model: string;
  ratio: string;
  resolution: string;
  title?: string;
  creditCap?: number;
}

export interface JimengQuote {
  totalMaxCredits: number;
  confirmationRequired: boolean;
}

export type JimengStatus = "new" | "quoted" | "submitted" | "succeeded" | "failed" | "needs_confirmation";

/** 分镜级：每个 beat 一个 item（key=beat-N）；单条模式（Phase 1）用顶层字段；anchor=定妆图 */
export interface JimengItemState {
  key: string;
  /** 请求指纹（prompt/mode/refs/时长/模型/分辨率）：请求变化时不得复用旧产物 */
  fingerprint?: string;
  status: JimengStatus;
  nodeId?: string;
  submitId?: string;
  resourceId?: string;
  clipPath?: string; // 相对 projectDir
  quote?: JimengQuote;
  error?: string;
}

export interface JimengState {
  status: JimengStatus;
  projectId?: string;
  webUrl?: string;
  items?: Record<string, JimengItemState>;
  /** 素材文件 → 画布图片节点 nodeId（m2v 复用，避免重复上传/建节点） */
  materials?: Record<string, string>;
  /** 视觉锚点：定妆图（Phase 2.1 连贯性） */
  anchor?: JimengItemState;
  // Phase 1 单条字段（保持兼容，旧任务重跑走 ensureVideo）
  nodeId?: string;
  submitId?: string;
  resourceId?: string;
  clipPath?: string;
  quote?: JimengQuote;
  error?: string;
  updatedAt?: string;
}

export interface JimengServiceOptions {
  projectDir: string;
  statePath?: string;
  waitTimeoutMs?: number; // 默认 10 分钟
  waitIntervalSec?: number; // 默认 5 秒
}

interface CanvasCreateData { project?: { projectId?: string; webUrl?: string } }
interface NodeCreateData { node?: { nodeId?: string } }
interface QuoteData { items?: Array<{ nodeId?: string; maxCredits?: number }>; totalMaxCredits?: number; confirmationRequired?: boolean }
interface RunData { items?: Array<{ nodeId?: string; submitId?: string; state?: string; resources?: Array<{ resourceId?: string }> }> }
interface WaitData { state?: string; resources?: Array<{ resourceId?: string; state?: string }> }
interface DownloadData { path?: string; resourceId?: string }
/** node confirm 真实返回（实测）：data.creditConfirmationToken + creditCeiling + expiresAt；
 *  旧猜测字段（items[].creditToken 等）保留兜底，避免不同 release 差异 */
interface ConfirmData {
  creditConfirmationToken?: string;
  creditCeiling?: number;
  expiresAt?: string;
  items?: Array<{ creditToken?: string }>;
  creditToken?: string;
  token?: string;
}
interface UploadData { resource?: { resourceId?: string }; resourceId?: string }

/** Phase 1 单条任务判定：state 顶层有工作字段且没有 items（新任务一律走 items） */
export function isLegacySingleState(state: JimengState): boolean {
  if (state.items && Object.keys(state.items).length > 0) return false;
  return Boolean(state.submitId || state.clipPath || state.nodeId);
}

/** 视频/图片请求指纹：请求参数变化（含首次带指纹）时，不复用旧产物 */
export function mediaRequestFingerprint(req: { prompt: string; model: string; ratio: string; resolution: string; durationSec?: number; mode?: string; refs?: string[] }): string {
  const payload = JSON.stringify({
    p: req.prompt,
    mo: req.model,
    ratio: req.ratio,
    res: req.resolution,
    d: req.durationSec ?? null,
    m: req.mode ?? "t2v",
    r: req.refs ?? [],
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function ts(): string {
  return new Date().toISOString();
}

/** 可承载一次生成流程的 item（顶层单条状态也满足该形状） */
type ItemLike = JimengItemState | JimengState;

export class JimengService {
  private statePath: string;
  private clipDir: string;
  private waitTimeoutMs: number;
  private waitIntervalSec: number;

  constructor(private cli: JimengCli, private opts: JimengServiceOptions) {
    this.statePath = opts.statePath ?? join(opts.projectDir, "jimeng", "state.json");
    this.clipDir = join(opts.projectDir, "jimeng");
    this.waitTimeoutMs = opts.waitTimeoutMs ?? 10 * 60 * 1000;
    this.waitIntervalSec = opts.waitIntervalSec ?? 5;
  }

  loadState(): JimengState {
    try {
      return JSON.parse(readFileSync(this.statePath, "utf8")) as JimengState;
    } catch {
      return { status: "new" };
    }
  }

  private saveState(state: JimengState): void {
    state.updatedAt = ts();
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }

  /** 统一调用检查：未登录 → AuthRequired；其它错误 → Error（带 code/message/requestId） */
  private async call<T>(args: string[], opts: { timeoutMs?: number } = {}): Promise<CliResult<T>> {
    const r = await this.cli.call<T>(args, opts);
    if (!r.ok) {
      if (isAuthRequired(r.error)) throw new JimengAuthRequiredError();
      const e: JimengError | undefined = r.error;
      throw new Error(
        `即梦 CLI 失败（${args.join(" ")}）：${e?.code ?? `exit ${r.code}`} ${e?.message ?? r.raw.slice(0, 200)}${r.requestId ? ` [requestId=${r.requestId}]` : ""}`,
      );
    }
    return r;
  }

  private clipAbs(item: ItemLike): string | null {
    return item.clipPath ? join(this.opts.projectDir, item.clipPath) : null;
  }

  /** 在 jimeng/ 目录中按 resourceId 查找已下载产物（CLI 命名规则：dreamina-<resourceId>.<ext>） */
  private findDownloaded(resourceId: string): string | null {
    try {
      const prefix = `dreamina-${resourceId}.`;
      const hit = readdirSync(this.clipDir).find((f) => f.startsWith(prefix));
      return hit ? join(this.clipDir, hit) : null;
    } catch {
      return null;
    }
  }

  private async ensureCanvas(state: JimengState, save: () => void): Promise<void> {
    if (state.projectId) return;
    const r = await this.call<CanvasCreateData>(["canvas", "create", "HF-Studio 直出", "--use"]);
    state.projectId = r.data?.project?.projectId;
    state.webUrl = r.data?.project?.webUrl;
    if (!state.projectId) throw new Error("即梦 canvas create 未返回 projectId");
    save();
  }

  /**
   * 单条模式（Phase 1 兼容）：幂等确保一条视频；state 顶层字段承载状态。
   */
  async ensureVideo(req: JimengVideoRequest): Promise<{ state: JimengState; clipAbsPath: string }> {
    const state = this.loadState();
    const existing = this.clipAbs(state);
    if (state.status === "succeeded" && existing && existsSync(existing)) {
      return { state, clipAbsPath: existing };
    }
    await this.ensureCanvas(state, () => this.saveState(state));
    if (!state.nodeId) {
      const args = this.videoNodeArgs(state.projectId!, req);
      const r = await this.call<NodeCreateData>(args);
      state.nodeId = r.data?.node?.nodeId;
      if (!state.nodeId) throw new Error("即梦 node create video 未返回 nodeId");
      this.saveState(state);
    }
    const clipAbsPath = await this.runPipeline(state, state, req.creditCap, () => this.saveState(state));
    state.status = "succeeded";
    state.error = undefined;
    this.saveState(state);
    return { state, clipAbsPath };
  }

  /**
   * 分镜模式（Phase 2）：为某个 beat（key）幂等确保片段；state.items[key] 承载状态。
   * 请求指纹变化（分镜/风格/参考变化）时重置该项重新生成，避免复用旧内容片段。
   */
  async ensureItem(key: string, req: JimengVideoRequest): Promise<{ state: JimengState; item: JimengItemState; clipAbsPath: string }> {
    const state = this.loadState();
    if (!state.items) state.items = {};
    if (!state.items[key]) state.items[key] = { key, status: "new" };
    const item = state.items[key];
    const save = () => this.saveState(state);
    const fp = mediaRequestFingerprint(req);
    const existing = this.clipAbs(item);
    if (item.status === "succeeded" && existing && existsSync(existing) && item.fingerprint === fp) {
      return { state, item, clipAbsPath: existing };
    }
    if (item.status === "failed") {
      // 失败项允许重跑：保留 nodeId（不留孤立节点），换新 submitId 重新运行（会重新计费）
      item.submitId = undefined;
      item.resourceId = undefined;
      item.clipPath = undefined;
      item.error = undefined;
      item.status = "new";
    }
    if (item.fingerprint !== fp) {
      // 请求变化（含旧数据无指纹）：清空复用身份，重新生成（旧节点留在画布，不再复用）
      item.nodeId = undefined;
      item.submitId = undefined;
      item.resourceId = undefined;
      item.clipPath = undefined;
      item.quote = undefined;
      item.error = undefined;
      item.status = "new";
    }
    item.fingerprint = fp;
    await this.ensureCanvas(state, save);
    if (!item.nodeId) {
      const r = await this.call<NodeCreateData>(this.videoNodeArgs(state.projectId!, req));
      item.nodeId = r.data?.node?.nodeId;
      if (!item.nodeId) throw new Error("即梦 node create video 未返回 nodeId");
      save();
    }
    const clipAbsPath = await this.runPipeline(state, item, req.creditCap, save);
    item.status = "succeeded";
    item.error = undefined;
    save();
    return { state, item, clipAbsPath };
  }

  /**
   * 视觉锚点（Phase 2.1）：生成/复用一张定妆图（画布图片节点），供所有 beat m2v 引用。
   */
  async ensureAnchorImage(req: JimengImageRequest): Promise<{ state: JimengState; anchor: JimengItemState; imageAbsPath: string }> {
    const state = this.loadState();
    if (!state.anchor) state.anchor = { key: "anchor", status: "new" };
    const anchor = state.anchor;
    const save = () => this.saveState(state);
    const fp = mediaRequestFingerprint({ prompt: req.prompt, model: req.model, ratio: req.ratio, resolution: req.resolution });
    const existing = this.clipAbs(anchor);
    if (anchor.status === "succeeded" && existing && existsSync(existing) && anchor.fingerprint === fp) {
      return { state, anchor, imageAbsPath: existing };
    }
    if (anchor.status === "failed") {
      anchor.submitId = undefined;
      anchor.resourceId = undefined;
      anchor.clipPath = undefined;
      anchor.error = undefined;
      anchor.status = "new";
    }
    if (anchor.fingerprint !== fp) {
      anchor.nodeId = undefined;
      anchor.submitId = undefined;
      anchor.resourceId = undefined;
      anchor.clipPath = undefined;
      anchor.quote = undefined;
      anchor.error = undefined;
      anchor.status = "new";
    }
    anchor.fingerprint = fp;
    await this.ensureCanvas(state, save);
    if (!anchor.nodeId) {
      const r = await this.call<NodeCreateData>([
        "node", "create", "image",
        "--project-id", state.projectId!,
        "--title", req.title ?? "主角定妆图",
        "--mode", "t2i",
        "--model", req.model,
        "--ratio", req.ratio,
        "--resolution", req.resolution,
        "--count", "1",
        `--prompt=${req.prompt}`,
      ]);
      anchor.nodeId = r.data?.node?.nodeId;
      if (!anchor.nodeId) throw new Error("即梦 node create image 未返回 nodeId");
      save();
    }
    const imageAbsPath = await this.runPipeline(state, anchor, req.creditCap, save);
    anchor.status = "succeeded";
    anchor.error = undefined;
    save();
    return { state, anchor, imageAbsPath };
  }

  /**
   * 素材（m2v）：上传本地图片并创建画布图片节点；按文件名缓存 nodeId（幂等，不重复上传）。
   */
  async ensureImageNode(fileName: string, absPath: string): Promise<{ state: JimengState; nodeId: string }> {
    const state = this.loadState();
    if (!state.materials) state.materials = {};
    const cached = state.materials[fileName];
    if (cached) return { state, nodeId: cached };
    const save = () => this.saveState(state);
    await this.ensureCanvas(state, save);
    const up = await this.call<UploadData>([
      "resource", "upload", "--file", absPath, "--name", fileName, "--project-id", state.projectId!,
    ], { timeoutMs: 5 * 60 * 1000 });
    const rid = up.data?.resource?.resourceId ?? up.data?.resourceId;
    if (!rid) throw new Error("即梦 resource upload 未返回 resourceId");
    const img = await this.call<NodeCreateData>([
      "node", "create", "image",
      "--project-id", state.projectId!,
      "--title", fileName,
      "--resource-id", rid,
      "--import-kind", "local_upload",
    ]);
    const nid = img.data?.node?.nodeId;
    if (!nid) throw new Error("即梦 node create image 未返回 nodeId");
    state.materials[fileName] = nid;
    this.saveState(state);
    return { state, nodeId: nid };
  }

  private videoNodeArgs(projectId: string, req: JimengVideoRequest): string[] {
    const args = [
      "node", "create", "video",
      "--project-id", projectId,
      "--title", req.title ?? "直出视频",
      "--mode", req.mode ?? "t2v",
      "--model", req.model,
      "--ratio", req.ratio,
      "--resolution", req.resolution,
      "--duration", String(req.durationSec),
      "--count", String(req.count ?? 1),
      `--prompt=${req.prompt}`,
    ];
    for (const ref of req.refs ?? []) args.push("--ref", ref);
    return args;
  }

  /** 报价 → （必要时批准）→ 运行 → 等待 → 下载；返回产物绝对路径。重跑复用已保存身份，绝不重复提交。 */
  private async runPipeline(state: JimengState, item: ItemLike, creditCap: number | undefined, save: () => void): Promise<string> {
    if (!item.submitId) {
      const q = await this.call<QuoteData>(["node", "quote", "--project-id", state.projectId!, "--node-id", item.nodeId!]);
      const total = q.data?.totalMaxCredits ?? q.data?.items?.[0]?.maxCredits ?? 0;
      const confirmationRequired = q.data?.confirmationRequired === true;
      item.quote = { totalMaxCredits: total, confirmationRequired };
      item.status = "quoted";

      if (confirmationRequired) {
        const cap = creditCap;
        if (cap == null || total > cap) {
          item.status = "needs_confirmation";
          save();
          throw new JimengConfirmationRequiredError("unconfirmed", total, q.data?.items ?? []);
        }
        const cf = await this.call<ConfirmData>([
          "node", "confirm", "--project-id", state.projectId!, "--node-id", item.nodeId!, "--credit-ceiling", String(cap),
        ]);
        // 实测字段：data.creditConfirmationToken（2026-09-29 job-mum8j1zx 事故修复；其余为兼容兜底）
        const token = cf.data?.creditConfirmationToken ?? cf.data?.items?.[0]?.creditToken ?? cf.data?.creditToken ?? cf.data?.token;
        if (!token) {
          throw new Error(`即梦 node confirm 成功但未返回 credit token（响应：${cf.raw.slice(0, 300)}）`);
        }
        const run = await this.call<RunData>([
          "node", "run", "--project-id", state.projectId!, "--node-id", item.nodeId!, "--credit-token", token,
        ]);
        this.captureRun(item, run.data);
      } else {
        const run = await this.call<RunData>(["node", "run", "--project-id", state.projectId!, "--node-id", item.nodeId!]);
        this.captureRun(item, run.data);
      }
      save();
    }

    // 等待（超时保留 submitId，重跑续查）
    const clipNow = this.clipAbs(item);
    if (item.submitId && !(clipNow && existsSync(clipNow))) {
      const w = await this.cli.call<WaitData>([
        "operation", "wait", item.submitId,
        "--project-id", state.projectId!,
        "--timeout", `${Math.round(this.waitTimeoutMs / 1000)}s`,
        "--interval", `${this.waitIntervalSec}s`,
      ], { timeoutMs: this.waitTimeoutMs + 60_000 });
      if (!w.ok) {
        if (isAuthRequired(w.error)) throw new JimengAuthRequiredError();
        if (isWaitTimeout(w.code)) throw new JimengWaitTimeoutError(item.submitId);
        item.status = "failed";
        item.error = w.error?.message ?? w.raw.slice(0, 300);
        save();
        throw new Error(`即梦任务失败（submitId=${item.submitId}）：${item.error}`);
      }
      const opState = w.data?.state;
      if (opState !== "succeeded") {
        if (opState === "failed" || opState === "canceled") {
          item.status = "failed";
          item.error = `operation ${opState}`;
          save();
          throw new Error(`即梦任务${opState === "failed" ? "失败" : "被取消"}（submitId=${item.submitId}）`);
        }
        // 非终态（异常路径）：按超时处理，保留 submitId
        throw new JimengWaitTimeoutError(item.submitId);
      }
      const rid = w.data?.resources?.find((r) => r.resourceId)?.resourceId;
      if (rid) item.resourceId = rid;
      if (!item.resourceId) throw new Error("即梦 operation wait 成功但未返回 resourceId");
      save();
    }

    // 下载（重试 + 复用已存在文件：CLI 拒绝覆盖同名文件，重复下载会报 invalid_download_output）
    const clipAbs = this.clipAbs(item);
    if (!clipAbs || !existsSync(clipAbs)) {
      if (!item.resourceId) throw new Error("缺少 resourceId，无法下载即梦产物");
      const adopted = this.findDownloaded(item.resourceId);
      if (adopted) {
        item.clipPath = relative(this.opts.projectDir, adopted);
        save();
        return adopted;
      }
      mkdirSync(this.clipDir, { recursive: true });
      let d: CliResult<DownloadData> | null = null;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          d = await this.call<DownloadData>([
            "resource", "download", item.resourceId, "--project-id", state.projectId!, "--output", this.clipDir,
          ], { timeoutMs: 10 * 60 * 1000 });
          break;
        } catch (e) {
          lastErr = e;
          const again = this.findDownloaded(item.resourceId);
          if (again) {
            item.clipPath = relative(this.opts.projectDir, again);
            save();
            return again;
          }
          if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
        }
      }
      if (!d) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      const downloaded = d.data?.path;
      if (!downloaded) throw new Error("即梦 resource download 未返回 path");
      item.clipPath = relative(this.opts.projectDir, downloaded);
      save();
      return downloaded;
    }
    return clipAbs;
  }

  private captureRun(item: ItemLike, data?: RunData): void {
    const runItem = data?.items?.[0];
    item.submitId = runItem?.submitId ?? item.submitId;
    item.resourceId = runItem?.resources?.[0]?.resourceId ?? item.resourceId;
    item.status = "submitted";
    if (!item.submitId) throw new Error("即梦 node run 未返回 submitId");
  }
}
