import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renameSync, rmSync } from "node:fs";

const execFileP = promisify(execFile);

/** 用 libass 把 ASS 字幕烧录进视频（二次编码 libx264 crf18，音频 copy）。
 *  先写临时文件再原子替换 output；失败清理临时文件并抛错（调用方决定是否保留原视频）。 */
export async function burnSubtitles(input: string, assPath: string, output: string): Promise<void> {
  const tmp = `${output}.subtmp.mp4`;
  try {
    await execFileP(
      "ffmpeg",
      ["-y", "-i", input, "-vf", `ass=filename='${assPath}'`, "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "copy", tmp],
      { timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
    );
    renameSync(tmp, output);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
