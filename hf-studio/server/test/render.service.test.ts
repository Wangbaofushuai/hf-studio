import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
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
  }, 180000);
});
