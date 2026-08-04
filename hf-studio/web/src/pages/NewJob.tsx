import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createJob } from "../api";
import ModelSelect from "../components/ModelSelect";
import VoiceSelect from "../components/VoiceSelect";

export default function NewJob() {
  const nav = useNavigate();
  const [idea, setIdea] = useState("");
  const [durationSec, setDurationSec] = useState(15);
  const [format, setFormat] = useState<"landscape" | "portrait" | "square">("portrait");
  const [voiceover, setVoiceover] = useState(true);
  const [voice, setVoice] = useState("zh-CN-XiaoxiaoNeural");
  const [language, setLanguage] = useState("zh-CN");
  const [model, setModel] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 自定义渠道（BYOK，可选）
  const [channelId, setChannelId] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [channelModels, setChannelModels] = useState("");

  const extraProviders = channelId && baseURL && apiKey && channelModels
    ? [{ id: channelId, models: channelModels.split(",").map((m) => m.trim()).filter(Boolean) }]
    : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    // 自定义渠道填了且未选其模型时，默认用渠道首个模型
    const customModels = channelModels.split(",").map((m) => m.trim()).filter(Boolean);
    const finalModel = model || (extraProviders.length > 0 ? `${channelId}/${customModels[0]}` : "");
    const form = new FormData();
    form.set("idea", idea);
    form.set("durationSec", String(durationSec));
    form.set("format", format);
    form.set("voiceover", String(voiceover));
    form.set("voice", voice);
    form.set("language", language);
    form.set("model", finalModel);
    if (extraProviders.length > 0) {
      form.set("providers", JSON.stringify([{ id: channelId, baseURL, apiKey, models: customModels }]));
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
    <form onSubmit={submit} className="space-y-6">
      <h2 className="text-xl font-semibold">新建视频任务</h2>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">你的想法（必填）</label>
        <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={4} required
          placeholder="例如：用三句话讲清太阳能发电的原理，风格偏科技感"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-neutral-400 mb-1">时长（秒）</label>
          <input type="number" min={5} max={120} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">画幅</label>
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm">
            <option value="portrait">竖屏 9:16（1080×1920）</option>
            <option value="landscape">横屏 16:9（1920×1080）</option>
            <option value="square">方形 1:1（1080×1080）</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">配音</label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={voiceover} onChange={(e) => setVoiceover(e.target.checked)} />
            {voiceover ? "开启（Edge-TTS 配音）" : "关闭（纯视觉）"}
          </label>
        </div>
        {voiceover && (
          <div>
            <label className="block text-sm text-neutral-400 mb-1">音色</label>
            <VoiceSelect lang={language} value={voice} onChange={setVoice} />
          </div>
        )}
        <div>
          <label className="block text-sm text-neutral-400 mb-1">LLM 模型</label>
          <ModelSelect value={model} onChange={setModel} extraProviders={extraProviders} />
        </div>
        <div>
          <label className="block text-sm text-neutral-400 mb-1">旁白语言</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm">
            <option value="zh-CN">中文（zh-CN）</option>
            <option value="en-US">英语（en-US）</option>
            <option value="ja-JP">日语（ja-JP）</option>
          </select>
        </div>
      </div>
      <div className="rounded-md border border-dashed border-neutral-700 p-4">
        <h3 className="text-sm font-semibold mb-2">自定义模型渠道（可选，BYOK）</h3>
        <p className="mb-3 text-xs text-neutral-500">填写后本任务使用你自己的 API 渠道，不填则用服务端内置渠道</p>
        <div className="grid grid-cols-2 gap-3">
          <input value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="渠道名，如 mykey"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
          <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="BaseURL，如 https://api.deepseek.com/v1"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="API Key"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
          <input value={channelModels} onChange={(e) => setChannelModels(e.target.value)} placeholder="模型列表，逗号分隔，如 deepseek-v4-flash"
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">素材（可选：图片 / 背景音乐）</label>
        <input type="file" multiple accept="image/png,image/jpeg,image/webp,image/svg+xml,audio/mpeg,audio/wav" onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm" />
        {files.length > 0 && <ul className="mt-2 text-xs text-neutral-400">{files.map((f) => <li key={f.name}>{f.name}</li>)}</ul>}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-6 py-2 text-sm font-semibold hover:bg-blue-500 disabled:opacity-50">
        {busy ? "提交中…" : "生成视频"}
      </button>
    </form>
  );
}
