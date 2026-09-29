// server/test/jimeng.service.test.ts —— 即梦服务状态机单测（Phase 1 Task 2）
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JimengCli, type CliRunner } from "../src/jimeng/cli";
import { JimengService, mediaRequestFingerprint } from "../src/jimeng/service";
import { JimengAuthRequiredError, JimengConfirmationRequiredError, JimengWaitTimeoutError } from "../src/jimeng/errors";

const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ schemaVersion: "1", ok: true, data, meta: { requestId: "r" } }) });
const fail = (code: number, error: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  code,
  stdout: JSON.stringify({ schemaVersion: "1", ok: false, error, ...extra }),
});

interface ScriptEntry {
  when: string; // 参数 join(" ") 的子串匹配（一次性消费）
  respond: (args: string[]) => { code: number; stdout: string; stderr?: string };
}

function scriptedRunner(entries: ScriptEntry[]) {
  const calls: string[][] = [];
  const runner: CliRunner = async (_bin, args) => {
    calls.push(args);
    const joined = args.join(" ");
    const entry = entries.find((e) => joined.includes(e.when));
    if (!entry) throw new Error(`scriptedRunner: 无匹配脚本条目 -> ${joined}`);
    const r = entry.respond(args);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jm-svc-"));
  mkdirSync(join(dir, "jimeng"), { recursive: true });
  return dir;
}

const REQ = { prompt: "测试提示词", model: "seedance_2.5_draft", ratio: "16:9", resolution: "480p", durationSec: 5 };

describe("JimengService.ensureVideo", () => {
  test("全新任务：建画布→存节点→报价→运行→等待→下载，落 state 与片段文件", async () => {
    const dir = projectDir();
    const clipPath = join(dir, "jimeng", "dreamina-rid-1.mp4");
    const { runner, calls } = scriptedRunner([
      { when: "canvas create", respond: () => ok({ project: { projectId: "pid-1", webUrl: "https://x/canvas" }, current: true }) },
      { when: "node create video", respond: () => ok({ node: { nodeId: "node-1", status: "empty" } }) },
      { when: "node quote", respond: () => ok({ items: [{ nodeId: "node-1", maxCredits: 45 }], totalMaxCredits: 45, confirmationRequired: false }) },
      { when: "node run", respond: () => ok({ items: [{ nodeId: "node-1", submitId: "sub-1", state: "accepted", resources: [{ resourceId: "rid-1" }] }] }) },
      { when: "operation wait", respond: () => ok({ operationRef: "sub-1", state: "succeeded", resources: [{ resourceId: "rid-1", state: "succeeded" }] }) },
      { when: "resource download", respond: () => { writeFileSync(clipPath, "fake-mp4"); return ok({ resourceId: "rid-1", path: clipPath, size: 8 }); } },
    ]);
    const cli = new JimengCli({ runner, bin: "/fake/x" });
    const svc = new JimengService(cli, { projectDir: dir });
    const { state, clipAbsPath } = await svc.ensureVideo(REQ);

    expect(state.status).toBe("succeeded");
    expect(state.projectId).toBe("pid-1");
    expect(state.nodeId).toBe("node-1");
    expect(state.submitId).toBe("sub-1");
    expect(state.resourceId).toBe("rid-1");
    expect(clipAbsPath).toBe(clipPath);
    expect(existsSync(clipPath)).toBe(true);
    // 调用顺序与关键参数
    const joined = calls.map((c) => c.join(" "));
    expect(joined[0]).toContain("canvas create");
    expect(joined[1]).toContain("node create video");
    expect(joined[1]).toContain("--model seedance_2.5_draft");
    expect(joined[2]).toContain("node quote");
    expect(joined[3]).toContain("node run");
    expect(joined[3]).not.toContain("--credit-token");
    expect(joined[4]).toContain("operation wait sub-1");
    expect(joined[5]).toContain("resource download rid-1");
    // 二次 ensureVideo：直接复用已成功状态，不再调用任何 CLI
    const again = await svc.ensureVideo(REQ);
    expect(again.state.status).toBe("succeeded");
    expect(calls.length).toBe(6);
  });

  test("续跑：state 已有 submitId/resourceId → 不重复提交，只等待并下载", async () => {
    const dir = projectDir();
    const clipPath = join(dir, "jimeng", "dreamina-rid-2.mp4");
    writeFileSync(
      join(dir, "jimeng", "state.json"),
      JSON.stringify({ status: "submitted", projectId: "pid", nodeId: "node", submitId: "sub-2", resourceId: "rid-2" }),
    );
    const { runner, calls } = scriptedRunner([
      { when: "operation wait", respond: () => ok({ state: "succeeded", resources: [{ resourceId: "rid-2", state: "succeeded" }] }) },
      { when: "resource download", respond: () => { writeFileSync(clipPath, "fake"); return ok({ path: clipPath, resourceId: "rid-2" }); } },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    const { state } = await svc.ensureVideo(REQ);
    expect(state.status).toBe("succeeded");
    const joined = calls.map((c) => c.join(" ")).join(" | ");
    expect(joined).not.toContain("node run");
    expect(joined).not.toContain("canvas create");
    expect(joined).toContain("operation wait sub-2");
  });

  test("服务端要求确认且无 creditCap → 抛确认异常、状态置 needs_confirmation、不调 node run", async () => {
    const dir = projectDir();
    const { runner, calls } = scriptedRunner([
      { when: "canvas create", respond: () => ok({ project: { projectId: "pid", webUrl: "u" } }) },
      { when: "node create video", respond: () => ok({ node: { nodeId: "node" } }) },
      { when: "node quote", respond: () => ok({ items: [{ nodeId: "node", maxCredits: 120 }], totalMaxCredits: 120, confirmationRequired: true }) },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    let err: unknown;
    try { await svc.ensureVideo(REQ); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(JimengConfirmationRequiredError);
    if (err instanceof JimengConfirmationRequiredError) {
      expect(err.minimumCreditCeiling).toBe(120);
    }
    expect(calls.map((c) => c.join(" ")).join(" | ")).not.toContain("node run");
    const state = JSON.parse(await Bun.file(join(dir, "jimeng", "state.json")).text());
    expect(state.status).toBe("needs_confirmation");
    expect(state.quote.totalMaxCredits).toBe(120);
  });

  test("有 creditCap 且覆盖报价 → node confirm --credit-ceiling 后带 token 运行", async () => {
    const dir = projectDir();
    const clipPath = join(dir, "jimeng", "r.mp4");
    const { runner, calls } = scriptedRunner([
      { when: "canvas create", respond: () => ok({ project: { projectId: "pid" } }) },
      { when: "node create video", respond: () => ok({ node: { nodeId: "node" } }) },
      { when: "node quote", respond: () => ok({ items: [{ nodeId: "node", maxCredits: 80 }], totalMaxCredits: 80, confirmationRequired: true }) },
      { when: "node confirm", respond: () => ok({ creditConfirmationToken: "tok-1", creditCeiling: 100, expiresAt: "2026-09-29T05:39:20Z" }) },
      { when: "node run", respond: () => ok({ items: [{ nodeId: "node", submitId: "sub-9", state: "accepted", resources: [{ resourceId: "rid-9" }] }] }) },
      { when: "operation wait", respond: () => ok({ state: "succeeded", resources: [{ resourceId: "rid-9" }] }) },
      { when: "resource download", respond: () => { writeFileSync(clipPath, "x"); return ok({ path: clipPath }); } },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    const { state } = await svc.ensureVideo({ ...REQ, creditCap: 100 });
    expect(state.status).toBe("succeeded");
    const joined = calls.map((c) => c.join(" "));
    const confirmCall = joined.find((j) => j.includes("node confirm"));
    expect(confirmCall).toContain("--credit-ceiling 100");
    const runCall = joined.find((j) => j.includes("node run"));
    expect(runCall).toContain("--credit-token tok-1");
  });

  test("等待超时（退出码 20）→ 抛 WaitTimeout、保留 submitId、不下载", async () => {
    const dir = projectDir();
    writeFileSync(
      join(dir, "jimeng", "state.json"),
      JSON.stringify({ status: "submitted", projectId: "pid", nodeId: "node", submitId: "sub-3", resourceId: "rid-3" }),
    );
    const { runner, calls } = scriptedRunner([
      { when: "operation wait", respond: () => fail(20, { code: "cli.wait_timeout", class: "timeout", message: "wait timeout", retryable: true, requiredAction: "retry" }) },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    let err: unknown;
    try { await svc.ensureVideo(REQ); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(JimengWaitTimeoutError);
    expect(calls.length).toBe(1);
    const state = JSON.parse(await Bun.file(join(dir, "jimeng", "state.json")).text());
    expect(state.submitId).toBe("sub-3");
    expect(state.status).toBe("submitted");
  });

  test("未登录（退出码 11）→ 抛 JimengAuthRequiredError", async () => {
    const dir = projectDir();
    const { runner } = scriptedRunner([
      { when: "canvas create", respond: () => fail(11, { code: "cli.auth_required", class: "auth", message: "login required", retryable: false, requiredAction: "login" }) },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    let err: unknown;
    try { await svc.ensureVideo(REQ); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(JimengAuthRequiredError);
  });

  test("多 item：两个 beat 各自生成并落 items[beat-N]；重跑跳过已完成项", async () => {
    const dir = projectDir();
    let n = 0;
    const clipFor = (key: string) => join(dir, "jimeng", `${key}.mp4`);
    const { runner, calls } = scriptedRunner([
      { when: "canvas create", respond: () => ok({ project: { projectId: "pid", webUrl: "u" } }) },
      { when: "node create video", respond: () => { n += 1; return ok({ node: { nodeId: `node-${n}` } }); } },
      { when: "node quote", respond: () => ok({ items: [{ maxCredits: 45 }], totalMaxCredits: 45, confirmationRequired: false }) },
      { when: "node run", respond: () => { const id = `sub-${n}`; return ok({ items: [{ nodeId: `node-${n}`, submitId: id, state: "accepted", resources: [{ resourceId: `rid-${n}` }] }] }); } },
      { when: "operation wait sub-1", respond: () => ok({ state: "succeeded", resources: [{ resourceId: "rid-1" }] }) },
      { when: "operation wait sub-2", respond: () => ok({ state: "succeeded", resources: [{ resourceId: "rid-2" }] }) },
      { when: "resource download rid-1", respond: () => { writeFileSync(clipFor("beat-1"), "a"); return ok({ path: clipFor("beat-1") }); } },
      { when: "resource download rid-2", respond: () => { writeFileSync(clipFor("beat-2"), "b"); return ok({ path: clipFor("beat-2") }); } },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    const a = await svc.ensureItem("beat-1", REQ);
    const b = await svc.ensureItem("beat-2", REQ);
    expect(a.item.status).toBe("succeeded");
    expect(b.item.status).toBe("succeeded");
    const state = JSON.parse(await Bun.file(join(dir, "jimeng", "state.json")).text());
    expect(state.items["beat-1"].clipPath).toBe("jimeng/beat-1.mp4");
    expect(state.items["beat-2"].clipPath).toBe("jimeng/beat-2.mp4");
    const callsBefore = calls.length;
    const again = await svc.ensureItem("beat-1", REQ);
    expect(again.item.status).toBe("succeeded");
    expect(calls.length).toBe(callsBefore); // 幂等：不再调用任何 CLI
  });

  test("多 item：单项需确认 → 该项 needs_confirmation 且保留 nodeId/quote，另一项不受影响", async () => {
    const dir = projectDir();
    const { runner } = scriptedRunner([
      { when: "canvas create", respond: () => ok({ project: { projectId: "pid" } }) },
      { when: "node create video", respond: () => ok({ node: { nodeId: "node-c" } }) },
      { when: "node quote", respond: () => ok({ items: [{ maxCredits: 300 }], totalMaxCredits: 300, confirmationRequired: true }) },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    let err: unknown;
    try { await svc.ensureItem("beat-1", REQ); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(JimengConfirmationRequiredError);
    const state = JSON.parse(await Bun.file(join(dir, "jimeng", "state.json")).text());
    expect(state.items["beat-1"].status).toBe("needs_confirmation");
    expect(state.items["beat-1"].nodeId).toBe("node-c");
    expect(state.items["beat-1"].quote.totalMaxCredits).toBe(300);
  });

  test("锚点图（Phase 2.1）：node create image → 报价 → 运行 → 下载；重跑复用不重复生成", async () => {
    const dir = projectDir();
    const img = join(dir, "jimeng", "anchor.png");
    const { runner, calls } = scriptedRunner([
      { when: "canvas create", respond: () => ok({ project: { projectId: "pid" } }) },
      { when: "node create image", respond: () => ok({ node: { nodeId: "img-node" } }) },
      { when: "node quote", respond: () => ok({ totalMaxCredits: 8, confirmationRequired: false }) },
      { when: "node run", respond: () => ok({ items: [{ nodeId: "img-node", submitId: "sub-img", state: "accepted", resources: [{ resourceId: "rid-img" }] }] }) },
      { when: "operation wait sub-img", respond: () => ok({ state: "succeeded", resources: [{ resourceId: "rid-img" }] }) },
      { when: "resource download rid-img", respond: () => { writeFileSync(img, "png"); return ok({ path: img }); } },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    const req = { prompt: "主角：中年相声演员，深灰长衫", model: "high_aes_general_v50_flash", ratio: "16:9", resolution: "2K" };
    const a = await svc.ensureAnchorImage(req);
    expect(a.anchor.status).toBe("succeeded");
    expect(a.anchor.nodeId).toBe("img-node");
    expect(existsSync(img)).toBe(true);
    const callsBefore = calls.length;
    const again = await svc.ensureAnchorImage(req);
    expect(again.anchor.status).toBe("succeeded");
    expect(calls.length).toBe(callsBefore); // 幂等复用
    const state = JSON.parse(await Bun.file(join(dir, "jimeng", "state.json")).text());
    expect(state.anchor.fingerprint).toBeTruthy();
  });

  test("下载：同 resource 文件已存在 → 直接复用（CLI 拒绝覆盖已存在文件）", async () => {
    const dir = projectDir();
    const clip = join(dir, "jimeng", "dreamina-rid-pre.mp4");
    writeFileSync(clip, "x");
    const fp = mediaRequestFingerprint(REQ);
    writeFileSync(join(dir, "jimeng", "state.json"), JSON.stringify({
      status: "submitted", projectId: "pid",
      items: { "beat-1": { key: "beat-1", status: "submitted", nodeId: "node", submitId: "sub-pre", resourceId: "rid-pre", fingerprint: fp } },
    }));
    const { runner, calls } = scriptedRunner([
      { when: "operation wait sub-pre", respond: () => ok({ state: "succeeded", resources: [{ resourceId: "rid-pre" }] }) },
    ]);
    const svc = new JimengService(new JimengCli({ runner, bin: "/fake/x" }), { projectDir: dir });
    const { item } = await svc.ensureItem("beat-1", REQ);
    expect(item.status).toBe("succeeded");
    expect(item.clipPath).toBe("jimeng/dreamina-rid-pre.mp4");
    expect(calls.map((c) => c.join(" ")).join(" | ")).not.toContain("resource download");
  });
});
