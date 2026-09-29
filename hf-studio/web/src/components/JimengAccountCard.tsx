import { useEffect, useState } from "react";
import { jimengLogin, jimengLogout, jimengStatus, type JimengStatusDto } from "../api";

/** 即梦账号卡片：状态 / 设备码登录（服务端后台等待授权，这里轮询状态）/ 退出 */
export default function JimengAccountCard() {
  const [st, setSt] = useState<JimengStatusDto | null>(null);
  const [challenge, setChallenge] = useState<{ userCode: string; verificationUriComplete: string; expiresAt?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => jimengStatus().then((s) => { if (alive) setSt(s); }).catch(() => { if (alive) setSt({ installed: false, error: "状态获取失败" }); });
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (st?.loggedIn) setChallenge(null);
  }, [st?.loggedIn]);

  return (
    <section className="glass space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">即梦账号（AI 直出）</h3>
        <span className={`text-xs ${st?.loggedIn ? "text-green-600" : "text-neutral-400"}`}>
          {st == null ? "检测中…" : !st.installed ? "未安装" : st.loggedIn ? `已登录${st.account?.vipLevel ? ` · ${st.account.vipLevel}` : ""}` : "未登录"}
        </span>
      </div>

      {st && !st.installed && (
        <p className="text-xs text-neutral-400">
          未检测到即梦画布 CLI（期望路径 .tools/dreamina-canvas）。{st.error ? `错误：${st.error}` : ""}
        </p>
      )}

      {st?.installed && (
        <div className="flex flex-wrap items-center gap-3">
          {!st.loggedIn ? (
            <button
              type="button"
              className="btn-primary px-4 py-2"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await jimengLogin();
                  if (r.alreadyLoggedIn) {
                    setSt(await jimengStatus());
                  } else if (r.challenge) {
                    setChallenge(r.challenge);
                  }
                } catch (e) {
                  window.alert(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "发起中…" : "开始登录"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary px-4 py-2"
              onClick={async () => {
                await jimengLogout().catch(() => {});
                setSt(await jimengStatus());
              }}
            >
              退出登录
            </button>
          )}
          <span className="text-xs text-neutral-400">CLI {st.version ?? "-"}</span>
        </div>
      )}

      {challenge && (
        <div className="space-y-2 rounded-xl border border-black/10 p-3 text-sm dark:border-white/10">
          <p className="text-neutral-600 dark:text-neutral-300">1. 在浏览器打开授权链接并完成登录：</p>
          <a className="block break-all text-xs text-[#0071e3] hover:underline" href={challenge.verificationUriComplete} target="_blank" rel="noreferrer">
            {challenge.verificationUriComplete}
          </a>
          <p className="text-neutral-600 dark:text-neutral-300">
            2. 页面要求时输入用户码：<span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10">{challenge.userCode}</span>
          </p>
          <p className="text-xs text-neutral-400">完成后卡片会自动变为「已登录」（最长等待 10 分钟）</p>
        </div>
      )}
    </section>
  );
}
