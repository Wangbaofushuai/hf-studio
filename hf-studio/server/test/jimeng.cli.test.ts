// server/test/jimeng.cli.test.ts —— 即梦 CLI 适配层单测（Phase 1 Task 1）
import { describe, expect, test } from "bun:test";
import { JimengCli, type CliRunner } from "../src/jimeng/cli";
import { isAuthRequired, isConfirmationRequired, isRetryableCode, isWaitTimeout } from "../src/jimeng/errors";

/** 记录调用并按序返回预设结果的假 runner */
function fakeRunner(results: Array<{ code: number; stdout: string; stderr?: string }>) {
  const calls: Array<{ bin: string; args: string[]; env: Record<string, string>; timeoutMs: number }> = [];
  const runner: CliRunner = async (bin, args, env, timeoutMs) => {
    calls.push({ bin, args, env, timeoutMs });
    const r = results.shift();
    if (!r) throw new Error(`fakeRunner: no more results (call #${calls.length}: ${args.join(" ")}`);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

const OK = (data: unknown) =>
  JSON.stringify({ schemaVersion: "1", ok: true, data, meta: { requestId: "req-1" } });

describe("JimengCli", () => {
  test("解析成功 envelope（data/requestId）并注入 --format json / --non-interactive 与隔离 env", async () => {
    const { runner, calls } = fakeRunner([{ code: 0, stdout: OK({ loggedIn: true }) }]);
    const cli = new JimengCli({
      runner,
      bin: "/fake/dreamina-canvas",
      homeDir: "/proj/data/jimeng/home",
      stateDir: "/proj/data/jimeng/state",
    });
    const r = await cli.call<{ loggedIn: boolean }>(["auth", "status"]);
    expect(r.ok).toBe(true);
    expect(r.data?.loggedIn).toBe(true);
    expect(r.requestId).toBe("req-1");
    expect(calls[0].bin).toBe("/fake/dreamina-canvas");
    expect(calls[0].args).toEqual(["--format", "json", "--non-interactive", "auth", "status"]);
    expect(calls[0].env.HOME).toBe("/proj/data/jimeng/home");
    expect(calls[0].env.DREAMINA_CANVAS_STATE_DIR).toBe("/proj/data/jimeng/state");
  });

  test("退出码 10：报价待确认 envelope 完整解析并可分类", async () => {
    const errEnvelope = JSON.stringify({
      schemaVersion: "1",
      ok: false,
      error: {
        code: "cli.generation_confirmation_required",
        class: "confirmation",
        message: "credit confirmation required",
        retryable: false,
        requiredAction: "confirm",
      },
      creditConfirmation: { reason: "unconfirmed", minimumCreditCeiling: 120 },
      partialData: { items: [{ nodeId: "node_x", submitId: "sub-1" }] },
    });
    const { runner } = fakeRunner([{ code: 10, stdout: errEnvelope }]);
    const cli = new JimengCli({ runner, bin: "/fake/x" });
    const r = await cli.call(["node", "create", "video"]);
    expect(r.code).toBe(10);
    expect(r.ok).toBe(false);
    expect(isConfirmationRequired(r.error!)).toBe(true);
    expect(r.error?.creditConfirmation?.minimumCreditCeiling).toBe(120);
    expect(r.error?.partialData?.items?.[0]?.submitId).toBe("sub-1");
  });

  test("退出码 11 / requiredAction=login → isAuthRequired", async () => {
    const envelope = JSON.stringify({
      schemaVersion: "1",
      ok: false,
      error: { code: "cli.auth_required", class: "auth", message: "login required", retryable: false, requiredAction: "login" },
    });
    const { runner } = fakeRunner([{ code: 11, stdout: envelope }]);
    const cli = new JimengCli({ runner, bin: "/fake/x" });
    const r = await cli.call(["model", "list", "--type", "video"]);
    expect(isAuthRequired(r.error!)).toBe(true);
    expect(isRetryableCode(r.error, r.code)).toBe(false);
  });

  test("非 JSON 输出兜底为结构化错误（保留 raw），code 0 视为 ok", async () => {
    const { runner } = fakeRunner([
      { code: 1, stdout: "boom: not json", stderr: "extra" },
      { code: 0, stdout: "plain text ok" },
    ]);
    const cli = new JimengCli({ runner, bin: "/fake/x" });
    const bad = await cli.call(["version"]);
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("cli.unparsed_output");
    expect(bad.raw).toContain("boom");
    const good = await cli.call(["version"]);
    expect(good.ok).toBe(true);
    expect(good.error).toBeUndefined();
  });

  test("等待超时码 20 可重试；21 也可重试", () => {
    expect(isWaitTimeout(20)).toBe(true);
    expect(isRetryableCode(undefined, 20)).toBe(true);
    expect(isRetryableCode(undefined, 21)).toBe(true);
    expect(isRetryableCode({ code: "x", class: "x", message: "", retryable: true, requiredAction: "none" }, 2)).toBe(true);
    expect(isRetryableCode(undefined, 2)).toBe(false);
  });
});
