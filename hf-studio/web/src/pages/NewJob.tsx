import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createJob, fetchChannels } from "../api";
import type { ChannelsDto } from "../types";
import VoiceSelect from "../components/VoiceSelect";

const FORMATS = [
  { id: "portrait", label: "竖屏 9:16" },
  { id: "landscape", label: "横屏 16:9" },
  { id: "square", label: "方形 1:1" },
] as const;

export default function NewJob() {
  const nav = useNavigate();
  const [idea, setIdea] = useState("");
  const [durationSec, setDurationSec] = useState(15);
  const [format, setFormat] = useState<"portrait" | "landscape" | "square">("portrait");
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

  useEffect(() => {
    fetchChannels().then(setCat).catch(() => setCat({ presets: [], custom: [] }));
  }, []);

  const available = cat
    ? [...cat.presets.filter((p) => p.hasKey), ...cat.custom.filter((c) => c.hasKey)]
    : [];
  const selected = available.find((c) => c.id === channelId) ?? null;

  // 选中渠道后默认其首个模型
  useEffect(() => {
    if (selected && !model.startsWith(`${selected.id}/`)) setModel(`${selected.id}/${selected.models[0]}`);
  }, [channelId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const customModels = tmpModels.split(",").map((m) => m.trim()).filter(Boolean);
    const finalModel = model || (tmpOpen && tmpId && tmpBase && tmpKey && customModels.length > 0 ? `${tmpId}/${customModels[0]}` : "");
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

  return (
    <form onSubmit={submit} className="space-y-8">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">新建视频任务</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">输入想法与素材，交给流水线生成你的视频。</p>
      </header>

      <section className="glass space-y-3 p-6">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-200">你的想法</label>
        <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={4} required
          placeholder="例如：用三句话讲清楚太阳能发电的原理，风格偏科技感"
          className="input resize-none" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">时长（秒）</label>
            <div className="segmented">
              {[10, 15, 30].map((s) => (
                <button key={s} type="button" data-active={durationSec === s} onClick={() => setDurationSec(s)}>{s}s</button>
              ))}
            </div>
            <input type="number" min={5} max={120} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))} className="input mt-2" />
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
      </section>

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

      {error && <p className="text-sm text-red-500">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full py-3 text-base">
        {busy ? "提交中…" : "生成视频"}
      </button>
    </form>
  );
}
