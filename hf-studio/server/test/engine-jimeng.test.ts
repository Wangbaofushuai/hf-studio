// server/test/engine-jimeng.test.ts —— jimeng 模式引擎整链路（假 LLM/JimengService，零积分消耗）
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/db/store";
import { PipelineEngine, type Services } from "../src/pipeline/engine";
import { steps } from "../src/pipeline/steps";
import type { JimengService } from "../src/jimeng/service";
import type { JobConfig } from "../src/types";

const brief = {
  title: "赛博城市夜景",
  summary: "霓虹与雨夜的城市氛围",
  style: "电影感深色",
  message: "城市的另一面",
  audience: "普通观众",
  arc: "hook;story;proof",
  narrationLanguage: "zh-CN",
  beatCountHint: 3,
};
const storyboard = {
  storyboardMd: "# 分镜\n" + "赛博城市夜景，镜头推进，霓虹反射。".repeat(10),
  scriptMd: "# 脚本\n雨夜城市。",
  contentType: "performance",
  visual: { subject: "中年男演员，深色长衫", scene: "红色幕布舞台，木桌", palette: "暖光深色", camera: "中景为主" },
  beats: [
    {
      title: "整段",
      narration: "大家好，今天聊聊太阳能发电的原理与好处。",
      mood: "轻松",
      shotType: "establishing",
      visualAction: "人物面对镜头讲述，手势自然",
      transitions: "无",
      assets: [],
      durationSec: 5,
    },
  ],
};

test("jimeng 模式整链路：step0-2 LLM 链路、step3 跳过 TTS（无旁白）、step4 生成、step5 校验、step6 成片", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-engine-jm-"));
  const store = new JobStore(join(dir, "jobs.db"));
  store.init();
  const cfg: JobConfig = {
    idea: "赛博城市夜景，镜头推进",
    durationSec: 5,
    format: "landscape",
    voiceover: false,
    voice: "zh-CN-XiaoxiaoNeural",
    language: "zh-CN",
    models: { default: "fake/model-a" },
    materials: { images: [], audio: null },
    mode: "jimeng",
  };

  let chatJsonCalls = 0;
  const llm = {
    chat: async () => ({ content: "# DESIGN.md\n电影感深色，主色 #0071e3，强调 #ff6b6b。\n" + "细节描述。".repeat(30) }),
    chatJson: async () => {
      chatJsonCalls += 1;
      return { data: chatJsonCalls === 1 ? brief : storyboard };
    },
  };
  const judge = {
    threshold: 7,
    score: async () => ({ score: 9, rubric: {}, feedback: "" }),
    passes: () => true,
  };

  const fakeJimeng = (projectDir: string): JimengService =>
    ({
      loadState: () => ({ status: "new" }),
      ensureItem: async (key: string) => {
        mkdirSync(join(projectDir, "jimeng"), { recursive: true });
        const clip = join(projectDir, "jimeng", `${key}.mp4`);
        execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=5", "-pix_fmt", "yuv420p", clip], { stdio: "pipe" });
        const stateFile = join(projectDir, "jimeng", "state.json");
        const state = existsSync(stateFile)
          ? JSON.parse(await Bun.file(stateFile).text())
          : { status: "submitted", projectId: "pid", items: {} };
        state.items[key] = { key, status: "succeeded", clipPath: `jimeng/${key}.mp4`, quote: { totalMaxCredits: 45, confirmationRequired: false } };
        writeFileSync(stateFile, JSON.stringify(state));
        return { state, item: state.items[key], clipAbsPath: clip };
      },
    }) as unknown as JimengService;

  const services = {
    llm: llm as never,
    judge: judge as never,
    judgeModel: "fake/model-a",
    render: () => ({ initProject: async () => {} }) as never,
    tts: {} as never,
    jimeng: fakeJimeng,
  } as unknown as Services;

  const engine = new PipelineEngine({ store, steps, services, projectRoot: join(dir, "projects") });
  const jobId = store.createJob(cfg);
  await engine.processNext();

  expect(store.getJob(jobId)?.status).toBe("completed");
  const outputs = store.getStepOutputs(jobId);
  // step0-2 真实执行（有 artifacts），step3 无旁白走 estimate 分支
  expect(outputs.find((o) => o.step === 0)?.artifacts).toContain("brief.json");
  expect(outputs.find((o) => o.step === 2)?.artifacts).toContain("STORYBOARD.md");
  const s4 = outputs.find((o) => o.step === 4);
  expect(s4?.artifacts).toContain("jimeng/beat-1.mp4");
  expect(existsSync(join(dir, "projects", jobId, "renders", "output.mp4"))).toBe(true);
}, 60000);
