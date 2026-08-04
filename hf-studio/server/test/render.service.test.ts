import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderService, RESOLUTIONS } from "../src/render/service";

describe("RenderService", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-render-"));
  let svc: RenderService;

  beforeAll(() => {
    svc = new RenderService(dir);
  });

  test("RESOLUTIONS maps formats to pixel sizes", () => {
    expect(RESOLUTIONS.landscape).toEqual({ w: 1920, h: 1080, cliName: "landscape" });
    expect(RESOLUTIONS.portrait).toEqual({ w: 1080, h: 1920, cliName: "portrait" });
    expect(RESOLUTIONS.square).toEqual({ w: 1080, h: 1080, cliName: "square" });
  });

  test("initProject scaffolds a lint-clean blank project", async () => {
    await svc.initProject("proj", "landscape");
    expect(existsSync(join(dir, "index.html"))).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "hyperframes.json"))).toBe(true);
    const lint = await svc.lint();
    expect(lint.errorCount).toBe(0);
  }, 120000);

  test("doctor reports environment", async () => {
    const d = await svc.doctor();
    expect(typeof d.ok).toBe("boolean");
    expect(d.items.length).toBeGreaterThan(0);
  }, 120000);

  test("snapshot captures beat midpoints", async () => {
    const pngs = await svc.snapshot([1.5, 4.2]);
    expect(pngs.length).toBe(2);
    for (const p of pngs) expect(existsSync(p)).toBe(true);

    // 第二次调用（不同时间点）只返回本次捕获，不混入上次遗留的旧 PNG
    const pngs2 = await svc.snapshot([2.0, 6.5]);
    expect(pngs2.length).toBe(2);
    for (const p of pngs2) expect(existsSync(p)).toBe(true);
    expect(pngs2.filter((p) => pngs.includes(p))).toEqual([]);
  }, 180000);

  test("snapshot throws on CLI failure even if snapshots dir exists", async () => {
    // 预置 snapshots/ 与旧 PNG（模拟上次运行残留），CLI 失败时必须抛错而不是返回旧文件
    mkdirSync(join(dir, "snapshots"), { recursive: true });
    writeFileSync(join(dir, "snapshots", "stale.png"), "fake");
    const fakeBin = join(dir, "fake-hyperframes");
    writeFileSync(fakeBin, "#!/bin/sh\necho \"boom\" >&2\nexit 3\n", { mode: 0o755 });
    const failing = new RenderService(dir, fakeBin);
    await expect(failing.snapshot([1.0])).rejects.toThrow(/snapshot failed/);
  }, 30000);
});
