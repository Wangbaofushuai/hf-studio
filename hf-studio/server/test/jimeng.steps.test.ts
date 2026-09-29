// server/test/jimeng.steps.test.ts —— jimeng 模式步骤分流（Task 3）+ step4/5/6 分支（Task 4）
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step2Storyboard } from "../src/pipeline/steps/step2-storyboard";
import { step4Build } from "../src/pipeline/steps/step4-build";
import { step5Validate } from "../src/pipeline/steps/step5-validate";
import { step6Render } from "../src/pipeline/steps/step6-render";
import type { JobConfig, StepContext } from "../src/types";

const cfg: JobConfig = {
  idea: "赛博城市夜景，镜头推进",
  durationSec: 5,
  format: "landscape",
  voiceover: false,
  voice: "zh-CN-XiaoxiaoNeural",
  language: "zh-CN",
  models: { default: "" },
  materials: { images: [], audio: null },
  mode: "jimeng",
};

function makeCtx(dir: string, jimeng?: unknown): StepContext {
  const boom = () => {
    throw new Error("不应被调用");
  };
  return {
    jobId: "j1",
    projectDir: dir,
    config: cfg,
    llm: { chat: boom } as never,
    judge: null as never,
    store: null as never,
    render: null as never,
    tts: { synthesize: boom } as never,
    jimeng: jimeng as never,
    feedback: null,
    log: () => {},
  } as StepContext;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hf-jm-steps-"));
}

describe("jimeng 模式：step2 分镜（视觉设定/镜头/时长约束）", () => {
  const visual = {
    subject: "中年相声演员，深灰长衫，手持折扇",
    scene: "红色幕布舞台，中央木桌与醒木",
    palette: "深色暖光，红色幕布为主",
    camera: "多机位中景为主",
  };
  const beatsSingle = (dur = 15) => [
    {
      title: "整段表演",
      narration: "大家好，今天咱们聊聊金融行业那点事儿，保证让你笑出腹肌，也能避开那些坑；先说第一件，别拿运气当本事，第二件，止损比预测重要得多。",
      mood: "诙谐",
      shotType: "establishing",
      visualAction: "人物在戏台正中面对镜头讲述，手势与表情随内容变化",
      transitions: "无",
      assets: [],
      durationSec: dur,
    },
  ];
  const beatsMulti = () => [
    { title: "开场", narration: "大家好，今天咱们聊聊金融行业那点事儿，保证让你笑出腹肌，也能避开那些常见的坑；先说第一件，别把运气当本事，看看你自己中了几枪，别急着笑。", mood: "诙谐", shotType: "establishing", visualAction: "演员登场，抱拳行礼后面对镜头讲述", transitions: "硬切", assets: [], durationSec: 15 },
    { title: "槽点", narration: "第二件，追涨杀跌那是给市场交学费，可不是投资；越亏越加仓，嘴上说摊平成本，实际是把风险越滚越大，账户曲线却一路向下，这就是多数人的剧本。", mood: "调侃", shotType: "closeup", visualAction: "演员皱眉摇头，摊手后指向桌上账本", transitions: "硬切", assets: [], durationSec: 15 },
    { title: "收尾", narration: "所以记住，止损比预测重要得多，规则写在交易之前，活得久才是真本事；今天就聊到这儿，咱们下回接着聊，把你的经历留在评论区，谢谢各位捧场。", mood: "收束", shotType: "gesture", visualAction: "演员竖起大拇指，拱手后鞠躬致意", transitions: "淡出", assets: [], durationSec: 15 },
  ];
  const mkCtx = (dir: string, beats: unknown[], durationSec = 15) => {
    writeFileSync(join(dir, "brief.json"), JSON.stringify({ title: "t", summary: "s", style: "x", message: "m", audience: "a", arc: "arc", narrationLanguage: "zh-CN", beatCountHint: 3 }));
    writeFileSync(join(dir, "DESIGN.md"), "design");
    const llm = {
      chatJson: async () => ({
        data: { storyboardMd: "x".repeat(30), scriptMd: "s", contentType: "performance", visual, beats },
      }),
    };
    return {
      jobId: "j", projectDir: dir, config: { ...cfg, durationSec, voiceover: false },
      llm, judge: { score: async () => ({ score: 9, rubric: {}, feedback: "" }), passes: () => true },
      store: null, render: null, tts: null, feedback: null, log: () => {},
    } as unknown as StepContext;
  };

  test("时长由台词反推：直出 38 字→10s；拼接超长台词封顶 15s", async () => {
    const short = beatsSingle(15)[0];
    short.narration = "字".repeat(38); // 38 字 ÷ 4 字/秒 = 9.5s → ceil 10
    const r1 = await step2Storyboard(mkCtx(tempDir(), [short], 15), []);
    expect(r1.status).toBe("passed");
    const b1 = (r1.data as { storyboard: { beats: { durationSec: number }[] } }).storyboard.beats[0];
    expect(b1.durationSec).toBe(10);
    // 拼接模式（45s > 模型上限 30s）：超长台词（100 字 → 25s）封顶 15s
    const long = beatsMulti();
    long[0].narration = "字".repeat(100);
    const r2 = await step2Storyboard(mkCtx(tempDir(), long, 45), []);
    expect(r2.status).toBe("passed");
    const b2 = (r2.data as { storyboard: { beats: { durationSec: number }[] } }).storyboard.beats[0];
    expect(b2.durationSec).toBe(15);
  });

  test("直出模式（时长 ≤ 模型上限）：单条 beat，写 VISUAL.json 并携带 shotType/visualAction", async () => {
    const dir = tempDir();
    const r = await step2Storyboard(mkCtx(dir, beatsSingle(15), 15), []);
    expect(r.status).toBe("passed");
    const visualFile = JSON.parse(readFileSync(join(dir, "VISUAL.json"), "utf8"));
    expect(visualFile.contentType).toBe("performance");
    expect(visualFile.visual.subject).toContain("相声演员");
    const beats = (r.data as { storyboard: { beats: { shotType?: string; visualAction?: string; techniques: string[] }[] } }).storyboard.beats;
    expect(beats.length).toBe(1);
    expect(beats[0].shotType).toBe("establishing");
    expect(beats[0].visualAction).toContain("镜头");
    expect(beats[0].techniques).toEqual([]);
    expect((r.data as { visual?: unknown }).visual).toBeTruthy();
  });

  test("拼接模式（时长 > 模型上限）：3 个片段通过", async () => {
    const r = await step2Storyboard(mkCtx(tempDir(), beatsMulti(), 45), []);
    expect(r.status).toBe("passed");
    expect((r.data as { storyboard: { beats: unknown[] } }).storyboard.beats.length).toBe(3);
  });
});

describe("jimeng 模式：step4 分镜生成", () => {
  const beats = [
    { index: 1, id: "beat-1", title: "开场", narration: "雨夜的赛博城市", mood: "神秘", techniques: ["推镜"], transitions: "叠化", assets: [], durationSec: 5 },
    { index: 2, id: "beat-2", title: "转折", narration: "霓虹倒映在湿漉街道", mood: "紧绷", techniques: ["横移"], transitions: "切", assets: ["ref.png"], durationSec: 6 },
  ];
  const prevWithBeats = [
    {},
    { data: { design: "# DESIGN.md\n深色电影感，霓虹蓝与橙对比" } },
    { data: { storyboard: { beats } } },
    { data: { boundaries: [{ index: 1, startSec: 0, endSec: 5 }, { index: 2, startSec: 5, endSec: 11 }] } },
  ] as never as Parameters<typeof step4Build>[1];

  test("逐 beat 生成：ensureItem 拿到旁白提示词与窗口时长；有素材的 beat 走 m2v", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "ref.png"), "x");
    const calls: Array<{ key: string; req: Record<string, unknown> }> = [];
    const jimeng = {
      loadState: () => ({ status: "new" }),
      ensureImageNode: async (name: string) => ({ state: {}, nodeId: "img-node-1" }),
      ensureItem: async (key: string, req: Record<string, unknown>) => {
        calls.push({ key, req });
        mkdirSync(join(dir, "jimeng"), { recursive: true });
        const clip = join(dir, "jimeng", `${key}.mp4`);
        writeFileSync(clip, "x");
        writeFileSync(join(dir, "jimeng", "state.json"), JSON.stringify({ status: "submitted", projectId: "pid", items: { [key]: { key, status: "succeeded", clipPath: `jimeng/${key}.mp4`, quote: { totalMaxCredits: 45, confirmationRequired: false } } } }));
        return { state: {}, item: { key, status: "succeeded", clipPath: `jimeng/${key}.mp4`, quote: { totalMaxCredits: 45, confirmationRequired: false } }, clipAbsPath: clip };
      },
    };
    const r = await step4Build(makeCtx(dir, jimeng), prevWithBeats);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toContain("jimeng/beat-1.mp4");
    expect(r.artifacts).toContain("jimeng/beat-2.mp4");
    expect(calls.length).toBe(2);
    expect(calls[0].req.mode).toBe("t2v");
    expect(calls[0].req.durationSec).toBe(5);
    expect(String(calls[0].req.prompt)).toContain("雨夜的赛博城市");
    expect(calls[1].req.mode).toBe("m2v");
    expect(calls[1].req.refs).toEqual(["node:img-node-1"]);
    expect(calls[1].req.durationSec).toBe(6);
    const data = r.data as { beats: { id: string; startSec: number; endSec: number }[] };
    expect(data.beats.map((b) => [b.id, b.startSec, b.endSec])).toEqual([["beat-1", 0, 5], ["beat-2", 5, 11]]);
  });

  test("有视觉设定：先生成定妆图，无素材 beat 全部 m2v 引用锚点；提示词为 主体/镜头/动作 结构", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "ref.png"), "x");
    const calls: Array<{ kind: string; key?: string; req?: Record<string, unknown> }> = [];
    const jimeng = {
      loadState: () => ({ status: "new" }),
      ensureAnchorImage: async (req: Record<string, unknown>) => {
        calls.push({ kind: "anchor", req });
        return { state: {}, anchor: { key: "anchor", status: "succeeded", nodeId: "anchor-node" }, imageAbsPath: join(dir, "jimeng", "anchor.png") };
      },
      ensureImageNode: async () => ({ state: {}, nodeId: "img-node-1" }),
      ensureItem: async (key: string, req: Record<string, unknown>) => {
        calls.push({ kind: "beat", key, req });
        mkdirSync(join(dir, "jimeng"), { recursive: true });
        const clip = join(dir, "jimeng", `${key}.mp4`);
        writeFileSync(clip, "x");
        writeFileSync(join(dir, "jimeng", "state.json"), JSON.stringify({ status: "submitted", projectId: "pid", items: { [key]: { key, status: "succeeded", clipPath: `jimeng/${key}.mp4` } } }));
        return { state: {}, item: { key, status: "succeeded", clipPath: `jimeng/${key}.mp4` }, clipAbsPath: clip };
      },
    };
    const prev = [
      {},
      { data: { design: "# D" } },
      {
        data: {
          storyboard: { beats },
          contentType: "performance",
          visual: { subject: "中年相声演员，深灰长衫", scene: "红色幕布舞台，中央木桌", palette: "深色暖光", camera: "多机位中景为主" },
        },
      },
      { data: { boundaries: [{ index: 1, startSec: 0, endSec: 5 }, { index: 2, startSec: 5, endSec: 11 }] } },
    ] as never as Parameters<typeof step4Build>[1];

    const r = await step4Build(makeCtx(dir, jimeng), prev);
    expect(r.status).toBe("passed");
    expect(calls[0].kind).toBe("anchor");
    expect(String(calls[0].req?.prompt)).toContain("中年相声演员");
    const beatCalls = calls.filter((c) => c.kind === "beat");
    expect(beatCalls.length).toBe(2);
    // beat-1 无素材 → m2v + 锚点 ref；提示词含固定主体与镜头描述
    expect(beatCalls[0].req?.mode).toBe("m2v");
    expect(beatCalls[0].req?.refs).toEqual(["node:anchor-node"]);
    expect(String(beatCalls[0].req?.prompt)).toContain("主体：中年相声演员");
    expect(String(beatCalls[0].req?.prompt)).toContain("镜头：中景主机位");
    expect(String(beatCalls[0].req?.prompt)).toContain("动作：");
    // beat-2 有素材 → 用素材 ref（不使用锚点）
    expect(beatCalls[1].req?.refs).toEqual(["node:img-node-1"]);
  });

  test("片段需要积分确认 → failed 且 data.jimengConfirmation 带报价", async () => {
    const dir = tempDir();
    const jimeng = {
      loadState: () => ({ status: "new", projectId: "pid", items: { "beat-1": { key: "beat-1", status: "needs_confirmation", quote: { totalMaxCredits: 120, confirmationRequired: true } } } }),
      ensureImageNode: async () => ({ state: {}, nodeId: "n" }),
      ensureItem: async () => {
        const { JimengConfirmationRequiredError } = await import("../src/jimeng/errors");
        throw new JimengConfirmationRequiredError("unconfirmed", 120, []);
      },
    };
    const r = await step4Build(makeCtx(dir, jimeng), prevWithBeats);
    expect(r.status).toBe("failed");
    const data = r.data as { jimengConfirmation?: { key: string; minimumCreditCeiling?: number } };
    expect(data.jimengConfirmation?.key).toBe("beat-1");
    expect(data.jimengConfirmation?.minimumCreditCeiling).toBe(120);
    expect(r.log).toContain("120");
  });

  test("Phase 1 兼容：state 顶层单条 → 走 ensureVideo", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "jimeng"), { recursive: true });
    const clip = join(dir, "jimeng", "main.mp4");
    writeFileSync(clip, "fake");
    const jimeng = {
      loadState: () => ({ status: "submitted", clipPath: "jimeng/main.mp4", submitId: "sub-1" }),
      ensureVideo: async () => ({ state: { status: "succeeded" }, clipAbsPath: clip }),
    };
    const r = await step4Build(makeCtx(dir, jimeng), []);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(["jimeng/state.json", "jimeng/main.mp4"]);
  });

  test("缺少分镜数据 → failed 且提示", async () => {
    const dir = tempDir();
    const jimeng = { loadState: () => ({ status: "new" }) };
    const r = await step4Build(makeCtx(dir, jimeng), []);
    expect(r.status).toBe("failed");
    expect(r.log).toContain("分镜");
  });

  test("step4 未注入 jimeng 服务时报错而非静默通过", async () => {
    const r = await step4Build(makeCtx(tempDir()), []);
    expect(r.status).toBe("failed");
    expect(r.log).toContain("即梦");
  });
});

function writeClip(dir: string, seconds: number): string {
  const clip = join(dir, "jimeng", "main.mp4");
  mkdirSync(join(dir, "jimeng"), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=black:s=320x240:d=${seconds}`, "-pix_fmt", "yuv420p", clip,
  ], { stdio: "pipe" });
  writeFileSync(join(dir, "jimeng", "state.json"), JSON.stringify({ status: "succeeded", clipPath: "jimeng/main.mp4" }));
  return clip;
}

describe("jimeng 模式：step5 校验与 step6 成片", () => {
  test("step5：时长在容差内 → passed", async () => {
    const dir = tempDir();
    writeClip(dir, 5);
    const r = await step5Validate(makeCtx(dir), []);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toContain("jimeng/main.mp4");
    expect(r.data.durationSec as number).toBeGreaterThan(4.5);
  }, 60000);

  test("step5：时长偏差超 30% → gate_failed", async () => {
    const dir = tempDir();
    writeClip(dir, 2);
    const r = await step5Validate(makeCtx(dir), []);
    expect(r.status).toBe("gate_failed");
    expect(r.gateErrors?.[0]).toContain("偏差");
  }, 60000);

  test("step5：片段缺失 → gate_failed", async () => {
    const r = await step5Validate(makeCtx(tempDir()), []);
    expect(r.status).toBe("gate_failed");
    expect(r.log).toContain("缺失");
  });

  test("step6：复制片段为 renders/output.mp4 并 probe 通过", async () => {
    const dir = tempDir();
    writeClip(dir, 5);
    const r = await step6Render(makeCtx(dir), []);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(["renders/output.mp4"]);
    expect(existsSync(join(dir, "renders", "output.mp4"))).toBe(true);
  }, 60000);

  test("step6：片段缺失 → gate_failed", async () => {
    const r = await step6Render(makeCtx(tempDir()), []);
    expect(r.status).toBe("gate_failed");
    expect(r.log).toContain("缺失");
  });
});
