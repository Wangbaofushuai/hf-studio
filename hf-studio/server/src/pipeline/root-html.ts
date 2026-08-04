import type { JobConfig } from "../types";
import { RESOLUTIONS } from "../render/resolutions";

export interface RootBeat { id: string; startSec: number; endSec: number }

export function generateRootHtml(opts: {
  beats: RootBeat[];
  format: JobConfig["format"];
  totalSec: number;
  voiceover: boolean;
  bgm: string | null;
  language: string;
}): string {
  const { w, h } = RESOLUTIONS[opts.format];
  const fmt = (n: number) => String(Number(n.toFixed(2))); // 去掉尾随 0：4.20 → 4.2
  const slots = opts.beats
    .map((b) => {
      const dur = fmt(b.endSec - b.startSec);
      // id 供 Studio 做稳定编辑目标（官方示例 slot 均带 id，缺了会触发 CLI warning）
      return `      <div id="${b.id}-slot" data-composition-id="${b.id}" data-composition-src="compositions/${b.id}.html" data-start="${fmt(b.startSec)}" data-duration="${dur}" data-track-index="0" data-width="${w}" data-height="${h}"></div>`;
    })
    .join("\n");
  const narration = opts.voiceover
    ? `      <audio id="narration" src="assets/narration.wav" data-start="0" data-duration="${fmt(opts.totalSec)}" data-track-index="10" data-volume="1"></audio>\n`
    : "";
  const bgm = opts.bgm
    ? `      <audio id="bgm" src="${opts.bgm}" data-start="0" data-duration="${fmt(opts.totalSec)}" data-track-index="9" data-volume="0.2"></audio>\n`
    : "";
  return `<!doctype html>
<html lang="${opts.language}" data-resolution="${opts.format}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${w}, height=${h}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #000; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="root" data-start="0" data-duration="${fmt(opts.totalSec)}" data-width="${w}" data-height="${h}">
${narration}${bgm}${slots}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["root"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}
