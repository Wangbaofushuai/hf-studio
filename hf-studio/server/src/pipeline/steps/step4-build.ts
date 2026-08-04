import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult, Beat } from "../../types";
import { generateRootHtml } from "../root-html";
import { RESOLUTIONS } from "../../render/resolutions";

const SYSTEM = readFileSync(new URL("../../prompts/build-beat.txt", import.meta.url), "utf8");

export const step4Build: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  // 引擎注入 `_model`（每步可覆盖）；直接调用（测试）时回退到 config 默认模型
  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  const beats = (prev[2]?.data.storyboard as { beats: Beat[] } | undefined)?.beats ?? [];
  const boundaries = (prev[3]?.data.boundaries as { index: number; startSec: number; endSec: number }[] | undefined) ?? [];
  const design = (prev[1]?.data.design as string | undefined) ?? (existsSync(join(ctx.projectDir, "DESIGN.md")) ? readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8") : "");
  const { w, h } = RESOLUTIONS[ctx.config.format];

  const timedBeats = beats.map((b, i) => {
    // 生产链路 storyboard beat 自带 index（1-based）；缺失时按位置兜底
    const bound = boundaries.find((x) => x.index === (b.index ?? i + 1));
    return { ...b, startSec: bound?.startSec ?? b.durationSec * i, endSec: bound?.endSec ?? b.durationSec * (i + 1) };
  });

  // 素材清单
  const assetList = [
    ...ctx.config.materials.images.map((f) => `assets/${f} (image)`),
    ...(ctx.config.materials.audio ? [`assets/${ctx.config.materials.audio} (audio)`] : []),
  ].join("\n");

  // 1) root index.html
  const totalSec = timedBeats.at(-1)?.endSec ?? ctx.config.durationSec;
  const indexHtml = generateRootHtml({
    beats: timedBeats.map((b) => ({ id: b.id, startSec: b.startSec, endSec: b.endSec })),
    format: ctx.config.format,
    totalSec,
    voiceover: ctx.config.voiceover,
    bgm: ctx.config.materials.audio,
    language: ctx.config.language,
  });
  writeFileSync(join(ctx.projectDir, "index.html"), indexHtml);

  // 2) 每 beat 生成 + lint 门
  mkdirSync(join(ctx.projectDir, "compositions"), { recursive: true });
  const built: { id: string; file: string; startSec: number; endSec: number; attempts: number }[] = [];
  const gateErrors: string[] = [];

  for (const beat of timedBeats) {
    let attempts = 0;
    let ok = false;
    while (!ok && attempts < 3) {
      attempts++;
      const beatSpec = JSON.stringify({
        id: beat.id,
        startSec: beat.startSec,
        endSec: beat.endSec,
        narration: beat.narration,
        mood: beat.mood,
        techniques: beat.techniques,
        transitions: beat.transitions,
        assets: beat.assets,
      }, null, 2);
      const userContent = `片段规格：\n${beatSpec}\n\nDESIGN.md：\n${design.slice(0, 8000)}\n\n素材清单：\n${assetList || "（无）"}\n\n画幅：${w}x${h}；输出文件：compositions/${beat.id}.html`;
      const { content } = await ctx.llm.chat({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `${userContent}${ctx.feedback ? `\n\n上次 lint 失败反馈（必须修复这些错误）：\n${ctx.feedback}` : ""}` },
        ],
        temperature: 0.5,
        seed: 44,
      });
      const file = join(ctx.projectDir, "compositions", `${beat.id}.html`);
      writeFileSync(file, content.trim());

      const lint = await ctx.render.lint();
      // 真实 CLI 在"无合成"场景下会报 ok:false 且 errorCount:0，两者任一失败都算不过
      if (lint.ok === false || lint.errorCount > 0) {
        const errText = lint.findings.map((f) => `[${f.rule}] ${f.message}`).join("; ");
        gateErrors.push(`${beat.id} lint 失败(第${attempts}次): ${errText}`);
        ctx.feedback = `${beat.id} 的 lint 错误：${errText}`;
        if (attempts >= 3) {
          return {
            status: "gate_failed",
            artifacts: ["index.html", ...built.map((b) => b.file)],
            data: { beats: built },
            log: `beat 构建 lint 未通过（${beat.id}）`,
            gateErrors,
          };
        }
      } else {
        ok = true;
        built.push({ id: beat.id, file: `compositions/${beat.id}.html`, startSec: beat.startSec, endSec: beat.endSec, attempts });
      }
    }
  }

  return {
    status: "passed",
    artifacts: ["index.html", ...built.map((b) => b.file)],
    data: { beats: built },
    log: `构建完成：${built.length} 个片段`,
  };
};
