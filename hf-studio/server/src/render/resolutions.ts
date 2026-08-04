// server/src/render/resolutions.ts —— 输出分辨率档位（Task 2）
import type { JobConfig } from "../types";

export const RESOLUTIONS: Record<
  JobConfig["format"],
  { w: number; h: number; cliName: string }
> = {
  landscape: { w: 1920, h: 1080, cliName: "landscape" },
  portrait: { w: 1080, h: 1920, cliName: "portrait" },
  square: { w: 1080, h: 1080, cliName: "square" },
};
