import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createJob, fetchChannels } from "../api";
import type { ChannelsDto } from "../types";
import VoiceSelect from "../components/VoiceSelect";
import WizardSteps from "../components/WizardSteps";

const FORMATS = [
  { id: "portrait", label: "竖屏 9:16 · 1080×1920" },
  { id: "landscape", label: "横屏 16:9 · 1920×1080" },
  { id: "square", label: "方形 1:1 · 1080×1080" },
] as const;

const THEMES = [
  { id: "tech", label: "科技感", emoji: "🔵" },
  { id: "nature", label: "清新自然", emoji: "🌿" },
  { id: "business", label: "商务极简", emoji: "💼" },
  { id: "warm", label: "暖系知识", emoji: "☕" },
  { id: "retro", label: "复古胶片", emoji: "🎞" },
  { id: "dark", label: "暗黑潮流", emoji: "🌃" },
] as const;

const DURATIONS = [15, 30, 60, 90];

const STEPS = ["内容设置", "模型", "素材与确认"];

export default function NewJob() {
  const nav = useNavigate();
  const [idea, setIdea] = useState("");
  const [durationSec, setDurationSec] = useState(30);
  const [format, setFormat] = useState<"portrait" | "landscape" | "square">("landscape");
  const [themeId, setThemeId] = useState("");
  const [themePrimary, setThemePrimary] = useState("#0071e3");
  const [themeAccent, setThemeAccent] = useState("#ff6b6b");
  const [quality, setQuality] = useState<"standard" | "hd">("standard");
  const [buildQuality, setBuildQuality] = useState<"fast" | "balanced" | "high">("fast");
  const [voiceover, setVoiceover] = useState(true);
  const [voice, setVoice] = useState("zh-CN-XiaoxiaoNeural");
  const [language, setLanguage] = useState("zh-CN");
  const [channelId, setChannelId] = useState("");
  const [model, setModel] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cat, setCat] = useState<ChannelsDto | null>(null);
  // 临时自定义渠道（BYOK，折叠区）
  const [tmpOpen, setTmpOpen] = useState(false);
  const [tmpId, setTmpId] = useState("");
  const [tmpBase, setTmpBase] = useState("");
  const [tmpKey, setTmpKey] = useState("");
  const [tmpModels, setTmpModels] = useState("");
  // 3 步向导
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);

  useEffect(() => {
    fetchChannels().then(setCat).catch(() => setCat({ presets: [], custom: [] }));
  }, []);

  const available = cat
    ? [...cat.presets.filter((p) => p.hasKey && p.id !== "custom"), ...cat.custom.filter((c) => c.hasKey)] // custom 模板不进预设，避免与自定义渠道重复
    : [];
  const selected = available.find((c) => c.id === channelId) ?? null;

  // 选中渠道后默认其首个模型
  useEffect(() => {
    if (selected && !model.startsWith(`${selected.id}/`)) setModel(`${selected.id}/${selected.models[0]}`);
  }, [channelId]);

  const customModels = tmpModels.split(",").map((m) => m.trim()).filter(Boolean);
  // 临时自定义渠道填写完整 → 优先用临时渠道模型（前缀 = tmpId = providers.id，保证 model 与渠道一致）。
  // 旧逻辑 `model || tmp...` 在用户先选中下拉渠道再填临时渠道时，会沿用旧的下拉 model——
  // 前缀与提交的 providers.id 不匹配 → LLM 请求打到错误渠道（本次事故根因）。
  const tmpActive = !!(tmpOpen && tmpId && tmpBase && tmpKey && customModels.length > 0);
  const finalModel = tmpActive ? `${tmpId}/${customModels[0]}` : model;

  const canNext = step === 0 ? idea.trim().length > 0 : step === 1 ? Boolean(finalModel) : true;

  function onJump(i: number) {
    if (i <= maxReached) {
      setStep(i);
      window.scrollTo({ top: 0 });
    }
  }

  function goNext() {
    if (!canNext) {
      setError(step === 0 ? "请先填写想法" : "请选择一个模型渠道");
      return;
    }
    setMaxReached((m) => Math.max(m, step + 1));
    setStep(step + 1);
    setError("");
    window.scrollTo({ top: 0 });
  }

  function goBack() {
    setStep((s) => s - 1);
    setError("");
    window.scrollTo({ top: 0 });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    if (!finalModel) {
      setError("请选择一个模型渠道并填写 Key（或展开「临时自定义渠道」）");
      setBusy(false);
      return;
    }
    const form = new FormData();
    form.set("idea", idea);
    form.set("durationSec", String(durationSec));
    form.set("format", format);
    form.set("voiceover", String(voiceover));
    form.set("voice", voice);
    form.set("language", language);
    form.set("model", finalModel);
    form.set("renderQuality", quality);
    form.set("quality", buildQuality);
    if (themeId) {
      form.set("theme", JSON.stringify({
        id: themeId,
        hue: { primary: themePrimary || undefined, accent: themeAccent || undefined },
      }));
    }
    if (tmpOpen && tmpId && tmpBase && tmpKey && customModels.length > 0) {
      form.set("providers", JSON.stringify([{ id: tmpId, baseURL: tmpBase, apiKey: tmpKey, models: customModels }]));
    }
    for (const f of files) form.append("files", f);
    try {
      const { id } = await createJob(form);
      nav(`/jobs/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const formatLabel = FORMATS.find((f) => f.id === format)?.label ?? format;

  return (
    <form onSubmit={submit} className="space-y-8">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">新建视频任务</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">输入想法与素材，交给流水线生成你的视频。</p>
      </header>

      <WizardSteps steps={STEPS} current={step} maxReached={maxReached} onJump={onJump} />

      {step === 0 && (
        <section className="glass space-y-3 p-6">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-200">你的想法</label>
          <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={4} required
            placeholder="例如：用三句话讲清楚太阳能发电的原理，风格偏科技感"
            className="input resize-none" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">时长（秒）</label>
              <div className="segmented">
                {DURATIONS.map((s) => (
                  <button key={s} type="button" data-active={durationSec === s} onClick={() => setDurationSec(s)}>{s}s</button>
                ))}
              </div>
              <input type="number" min={5} max={240} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))} className="input mt-2" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">画幅</label>
              <div className="segmented">
                {FORMATS.map((f) => (
                  <button key={f.id} type="button" data-active={format === f.id} onClick={() => setFormat(f.id)}>{f.label}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">配音</label>
              <div className="segmented">
                <button type="button" data-active={voiceover} onClick={() => setVoiceover(true)}>开启</button>
                <button type="button" data-active={!voiceover} onClick={() => setVoiceover(false)}>关闭</button>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">旁白语言</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="input">
                <option value="zh-CN">中文（zh-CN）</option>
                <option value="en-US">英语（en-US）</option>
                <option value="ja-JP">日语（ja-JP）</option>
              </select>
            </div>
            {voiceover && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">音色</label>
                <VoiceSelect lang={language} value={voice} onChange={setVoice} />
              </div>
            )}
          </div>

          <div className="border-t border-black/10 pt-4 dark:border-white/10">
            <label className="mb-2 block text-sm font-medium text-neutral-700 dark:text-neutral-200">主题 / 预设模板</label>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {THEMES.map((t) => (
                <button key={t.id} type="button" onClick={() => setThemeId(themeId === t.id ? "" : t.id)}
                  className={`rounded-xl border p-3 text-left transition-all ${
                    themeId === t.id
                      ? "border-[#0071e3] bg-[#0071e3]/5 shadow-md shadow-blue-500/10"
                      : "border-black/10 bg-white/50 hover:border-black/20 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/25"
                  }`}>
                  <span className="text-xl">{t.emoji}</span>
                  <span className="mt-1 block text-sm font-medium text-neutral-700 dark:text-neutral-200">{t.label}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-neutral-400">{themeId ? "已选主题，可手动微调主色 / 强调色" : "自由发挥：不套用任何预设主题"}</p>
            {themeId && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">主色 primary</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={themePrimary} onChange={(e) => setThemePrimary(e.target.value)} className="h-10 w-16 cursor-pointer rounded-lg border border-black/10 bg-transparent" />
                    <span className="font-mono text-xs text-neutral-400">{themePrimary}</span>
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">强调色 accent</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={themeAccent} onChange={(e) => setThemeAccent(e.target.value)} className="h-10 w-16 cursor-pointer rounded-lg border border-black/10 bg-transparent" />
                    <span className="font-mono text-xs text-neutral-400">{themeAccent}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-black/10 pt-4 dark:border-white/10">
            <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">清晰度</label>
            <div className="segmented">
              <button type="button" data-active={quality === "standard"} onClick={() => setQuality("standard")}>标准</button>
              <button type="button" data-active={quality === "hd"} onClick={() => setQuality("hd")}>高清</button>
            </div>
          </div>
          <div className="border-t border-black/10 pt-4 dark:border-white/10">
            <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">生成速度</label>
            <div className="segmented">
              <button type="button" data-active={buildQuality === "fast"} onClick={() => setBuildQuality("fast")}>快速</button>
              <button type="button" data-active={buildQuality === "balanced"} onClick={() => setBuildQuality("balanced")}>均衡</button>
              <button type="button" data-active={buildQuality === "high"} onClick={() => setBuildQuality("high")}>高质量</button>
            </div>
            <p className="mt-1 text-[11px] text-neutral-400">快速约 1 分钟/片段（默认）；高质量更精致但慢 5-10 倍</p>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="glass space-y-3 p-6">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-neutral-700 dark:text-neutral-200">模型渠道</label>
            <Link to="/channels" className="text-xs text-[#0071e3] hover:underline">管理渠道 →</Link>
          </div>
          {available.length === 0 ? (
            <div className="rounded-xl border border-dashed border-black/10 p-6 text-center dark:border-white/10">
              <p className="text-sm text-neutral-500">还没有可用的模型渠道</p>
              <Link to="/channels" className="btn-primary mt-3 inline-block">去配置 Key</Link>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {available.map((c) => (
                <button key={c.id} type="button" onClick={() => setChannelId(c.id)}
                  className={`rounded-xl border p-4 text-left transition-all ${
                    channelId === c.id
                      ? "border-[#0071e3] bg-[#0071e3]/5 shadow-md shadow-blue-500/10"
                      : "border-black/10 bg-white/50 hover:border-black/20 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/25"
                  }`}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{c.name}</span>
                    <span className={`h-2.5 w-2.5 rounded-full ${channelId === c.id ? "bg-[#0071e3]" : "bg-green-500"}`} />
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-neutral-400">{c.baseURL}</p>
                  <p className="mt-1 text-[11px] text-neutral-400">{c.models.length} 个模型</p>
                </button>
              ))}
            </div>
          )}
          {selected && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">模型</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} className="input">
                {selected.models.map((m) => <option key={m} value={`${selected.id}/${m}`}>{selected.id}/{m}</option>)}
              </select>
            </div>
          )}

          <details open={tmpOpen} onToggle={(e) => setTmpOpen(e.currentTarget.open)} className="rounded-xl border border-dashed border-black/10 p-4 dark:border-white/10">
            <summary className="cursor-pointer text-sm text-neutral-500">临时自定义渠道（不保存，仅本次任务使用）</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input className="input" placeholder="渠道名，如 mykey" value={tmpId} onChange={(e) => setTmpId(e.target.value)} />
              <input className="input" placeholder="BaseURL，如 https://api.example.com/v1" value={tmpBase} onChange={(e) => setTmpBase(e.target.value)} />
              <input className="input" type="password" placeholder="API Key" value={tmpKey} onChange={(e) => setTmpKey(e.target.value)} autoComplete="off" />
              <input className="input" placeholder="模型列表，逗号分隔" value={tmpModels} onChange={(e) => setTmpModels(e.target.value)} />
            </div>
          </details>
        </section>
      )}

      {step === 2 && (
        <>
          <section className="glass space-y-3 p-6">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">配置汇总</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-neutral-500">想法</dt>
                <dd className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">{idea.length > 60 ? `${idea.slice(0, 60)}…` : idea}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-neutral-500">时长 / 画幅</dt>
                <dd className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">{durationSec} 秒 · {formatLabel}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-neutral-500">配音</dt>
                <dd className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">{voiceover ? `开启 · ${language} · ${voice}` : "关闭"}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-neutral-500">主题</dt>
                <dd className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">
                  {themeId ? (
                    <span className="flex flex-wrap items-center gap-2">
                      {THEMES.find((t) => t.id === themeId)?.emoji} {THEMES.find((t) => t.id === themeId)?.label}
                      {themePrimary && <span className="h-4 w-4 rounded-full border border-black/20" style={{ background: themePrimary }} />}
                      {themeAccent && <span className="h-4 w-4 rounded-full border border-black/20" style={{ background: themeAccent }} />}
                    </span>
                  ) : "自由发挥"}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-neutral-500">清晰度</dt>
                <dd className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">{quality === "hd" ? "高清" : "标准"}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-neutral-500">渠道 / 模型</dt>
                <dd className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">
                  {finalModel ? `${tmpActive ? tmpId : selected ? selected.name : tmpId} · ${finalModel}` : "未选择"}
                </dd>
              </div>
            </dl>
          </section>

          <section className="glass space-y-3 p-6">
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-200">素材（可选：图片 / 背景音乐）</label>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-black/15 py-8 text-neutral-400 transition-colors hover:border-[#0071e3]/50 dark:border-white/15">
              <span className="text-2xl">＋</span>
              <span className="text-sm">点击选择或拖拽图片 / 音频到此处</span>
              <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/svg+xml,audio/mpeg,audio/wav"
                className="hidden" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
            </label>
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {files.map((f) => <li key={f.name} className="rounded-lg bg-black/[0.05] px-2.5 py-1 text-xs text-neutral-600 dark:bg-white/10 dark:text-neutral-300">{f.name}</li>)}
              </ul>
            )}
          </section>
        </>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex gap-3">
        {step > 0 && (
          <button type="button" onClick={goBack} className="btn-secondary w-36 py-3">上一步</button>
        )}
        {step < 2 ? (
          <button type="button" onClick={goNext} className="btn-primary flex-1 py-3 text-base">下一步</button>
        ) : (
          <button type="submit" disabled={busy} className="btn-primary flex-1 py-3 text-base">
            {busy ? "提交中…" : "生成视频"}
          </button>
        )}
      </div>
    </form>
  );
}