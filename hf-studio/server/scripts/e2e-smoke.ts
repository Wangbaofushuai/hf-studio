// server/scripts/e2e-smoke.ts —— 端到端冒烟：真实 LLM + 真实 Edge-TTS + 真实 hyperframes 渲染，
// 跑通 15s 竖屏 demo（spec 第 8 节验收标准）。
//
// 用法：先确保 server/config.json 配置了真实 LLM provider（真实 apiKey），然后
//   cd hf-studio/server && bun run e2e
// 期望日志逐步推进：brief → design（评审分）→ storyboard（评审分）→ 配音时长 → 构建（lint）→
// check 通过 → 渲染完成；最终输出 data/projects/<jobId>/renders/output.mp4（约 15s，±10%）。
//
// 与任务 brief 的唯一偏差（Task 19 报告有记录）：provider 占位密钥检测。
// 仓库内 config.json 是 gitignored 的本地文件，模板值 apiKey 为占位符 sk-REPLACE_ME；
// brief 原文守卫只查 `providers.length === 0 || !defaults.model`，对"占位密钥"会放行
// 到真实 LLM 调用（随后 401 失败，报错不直观）。此处守卫额外检测 sk-REPLACE_ME / 空
// apiKey：未配置真实 provider 时立即 exit 2 并给出明确提示。
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config";
import { buildProviders, loadChannelKeys } from "../src/channels";
import { JobStore } from "../src/db/store";
import { LlmGateway } from "../src/llm/gateway";
import { Judge } from "../src/judge/judge";
import { RenderService } from "../src/render/service";
import { TtsService } from "../src/tts/service";
import { PipelineEngine } from "../src/pipeline/engine";
import { steps } from "../src/pipeline/steps";
import type { JobConfig } from "../src/types";

const DATA_ROOT = resolve(import.meta.dir, "../../data");
const PROJECTS_ROOT = resolve(DATA_ROOT, "projects");

async function main() {
  const config = loadConfig();
  // 守卫：无预设渠道 / 未填真实 key / 无默认模型，均视为"未配置真实渠道"
  const providers = buildProviders(config.presetChannels, loadChannelKeys());
  if (providers.length === 0 || !config.defaults.model) {
    console.error("E2E 需要先配置模型渠道：在网页「模型渠道」页填写 Key，或在 data/channels.json 配置；默认模型在 config.json 的 defaults.model 指定");
    process.exit(2);
  }
  mkdirSync(PROJECTS_ROOT, { recursive: true });
  const store = new JobStore(resolve(DATA_ROOT, "jobs.db"));
  store.init();
  store.recover();
  const llm = new LlmGateway(providers);
  const judge = new Judge(new LlmGateway(providers), config.defaults.judgeModel || config.defaults.model, config.defaults.judgeThreshold);
  const services = {
    llm,
    judge,
    baseProviders: providers,
    render: (projectDir: string) => new RenderService(projectDir),
    tts: new TtsService(),
  } as never;

  const jobCfg: JobConfig = {
    idea: "用三句话讲清楚太阳能发电的原理，风格简洁现代",
    durationSec: 15,
    format: "portrait",
    voiceover: true,
    voice: config.tts.defaultVoice,
    language: config.tts.defaultLanguage,
    models: { default: config.defaults.model },
    materials: { images: [], audio: null },
  };

  const jobId = store.createJob(jobCfg);
  console.log(`[e2e] job ${jobId} 已创建，开始流水线…`);

  const engine = new PipelineEngine({ store, steps, services, projectRoot: PROJECTS_ROOT });
  engine.onEvent((e) => {
    if (e.type === "step_status") console.log(`[e2e] step ${e.step} → ${e.status}`);
  });
  await engine.processNext();

  const job = store.getJob(jobId)!;
  const mp4 = resolve(PROJECTS_ROOT, jobId, "renders/output.mp4");
  console.log(`[e2e] 最终状态: ${job.status}`);
  if (job.status !== "completed" || !existsSync(mp4)) {
    console.error(`[e2e] 失败: ${job.error}`);
    process.exit(1);
  }
  console.log(`[e2e] 通过: ${mp4}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
