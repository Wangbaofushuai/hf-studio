import { useEffect, useState } from "react";
import { deleteChannel, fetchChannels, saveChannel, testChannel } from "../api";
import type { ChannelDto, ChannelsDto } from "../types";

const BRAND: Record<string, { initial: string; hue: string }> = {
  deepseek: { initial: "D", hue: "from-sky-400 to-blue-600" },
  glm: { initial: "智", hue: "from-indigo-400 to-violet-600" },
  qwen: { initial: "通", hue: "from-orange-400 to-amber-600" },
  openai: { initial: "O", hue: "from-emerald-400 to-teal-600" },
  kimi: { initial: "K", hue: "from-rose-400 to-pink-600" },
  custom: { initial: "＋", hue: "from-neutral-400 to-neutral-600" },
};

function TestResult({ state }: { state: { ok: boolean; latencyMs?: number; error?: string } | null }) {
  if (!state) return <span className="inline-block h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-600" title="未测试" />;
  return state.ok
    ? <span className="inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400"><span className="h-2 w-2 rounded-full bg-green-500" />连通 {state.latencyMs}ms</span>
    : <span className="inline-flex items-center gap-1.5 text-xs text-red-500"><span className="h-2 w-2 rounded-full bg-red-500" />{state.error?.slice(0, 40) ?? "失败"}</span>;
}

function ChannelCard({ ch, onSaved }: { ch: ChannelDto; onSaved: (c: ChannelsDto) => void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  const brand = BRAND[ch.id] ?? { initial: "?", hue: "from-neutral-400 to-neutral-600" };

  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    try {
      const cat = await saveChannel(ch.id, { apiKey: key.trim() });
      onSaved(cat);
      setKey("");
      setTest(null);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const clear = async () => {
    if (!confirm(`清除 ${ch.name} 的 Key？`)) return;
    const cat = await deleteChannel(ch.id);
    onSaved(cat);
    setTest(null);
  };

  const runTest = async () => {
    setTest(null);
    const r = await testChannel(ch.id);
    setTest(r);
  };

  return (
    <div className="glass flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-bold text-white ${brand.hue}`}>
          {brand.initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{ch.name}</h3>
            {ch.hasKey
              ? <span className="badge bg-green-500/10 text-green-600 dark:text-green-400">已配置</span>
              : <span className="badge bg-neutral-500/10 text-neutral-500">未配置</span>}
          </div>
          <p className="truncate font-mono text-[11px] text-neutral-400">{ch.baseURL}</p>
        </div>
        <TestResult state={test} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ch.models.map((m) => (
          <span key={m} className="rounded-md bg-black/[0.05] px-2 py-0.5 font-mono text-[11px] text-neutral-500 dark:bg-white/10 dark:text-neutral-300">{m}</span>
        ))}
        {ch.models.length === 0 && <span className="text-xs text-neutral-400">（自定义渠道：模型在下方填写）</span>}
      </div>
      <div className="flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={ch.hasKey ? "输入新 Key 覆盖" : "粘贴 API Key"}
          className="input flex-1" autoComplete="off" />
        <button className="btn-secondary" onClick={save} disabled={saving || !key.trim()}>{saving ? "保存中…" : "保存"}</button>
        {ch.hasKey && (
          <>
            <button className="btn-secondary" onClick={runTest} disabled={!!test && test.ok === undefined}>测试</button>
            <button className="btn-secondary" onClick={clear}>清除</button>
          </>
        )}
      </div>
      {test?.ok === false && <p className="text-xs text-red-500">{test.error}</p>}
    </div>
  );
}

export default function Channels() {
  const [cat, setCat] = useState<ChannelsDto | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);
  const [cName, setCName] = useState("");
  const [cBase, setCBase] = useState("");
  const [cModels, setCModels] = useState("");
  const [cKey, setCKey] = useState("");

  useEffect(() => { fetchChannels().then(setCat).catch(() => setCat({ presets: [], custom: [] })); }, []);

  const presets = cat?.presets.filter((p) => p.id !== "custom") ?? [];
  const custom = cat?.custom[0] ?? null;

  const addCustom = async () => {
    const models = cModels.split(",").map((m) => m.trim()).filter(Boolean);
    if (!cName || !cBase || models.length === 0 || !cKey) { alert("名称/BaseURL/模型/Key 都要填"); return; }
    try {
      const next = await saveChannel("custom", { apiKey: cKey.trim(), baseURL: cBase.trim(), models });
      setCat(next);
      setAddingCustom(false); setCName(""); setCBase(""); setCModels(""); setCKey("");
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  };

  const removeCustom = async () => {
    if (!confirm("删除自定义渠道？")) return;
    setCat(await deleteChannel("custom"));
  };

  if (!cat) return <p className="text-sm text-neutral-500">加载中…</p>;

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">模型渠道</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">预设渠道已内置官方地址与模型，填入 Key 即可使用；Key 只保存在服务器，不会回显。</p>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        {presets.map((ch) => <ChannelCard key={ch.id} ch={ch} onSaved={setCat} />)}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-neutral-600 dark:text-neutral-300">自定义渠道</h3>
        {custom ? (
          <div className="glass flex flex-col gap-3 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-neutral-400 to-neutral-600 text-sm font-bold text-white">＋</div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold">{custom.name}</h4>
                  <span className="badge bg-green-500/10 text-green-600 dark:text-green-400">已配置</span>
                </div>
                <p className="truncate font-mono text-[11px] text-neutral-400">{custom.baseURL}</p>
              </div>
              <button className="btn-secondary" onClick={removeCustom}>删除</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {custom.models.map((m) => (
                <span key={m} className="rounded-md bg-black/[0.05] px-2 py-0.5 font-mono text-[11px] text-neutral-500 dark:bg-white/10 dark:text-neutral-300">{m}</span>
              ))}
            </div>
            <ChannelCard ch={custom} onSaved={setCat} />
          </div>
        ) : (
          <div className="glass p-5">
            {!addingCustom ? (
              <button className="btn-secondary" onClick={() => setAddingCustom(true)}>＋ 添加自定义渠道</button>
            ) : (
              <div className="space-y-3">
                <input className="input" placeholder="渠道名称（如 mykey）" value={cName} onChange={(e) => setCName(e.target.value)} />
                <input className="input" placeholder="BaseURL（OpenAI 兼容，如 https://api.example.com/v1）" value={cBase} onChange={(e) => setCBase(e.target.value)} />
                <input className="input" placeholder="模型列表，逗号分隔（如 model-a, model-b）" value={cModels} onChange={(e) => setCModels(e.target.value)} />
                <input className="input" type="password" placeholder="API Key" value={cKey} onChange={(e) => setCKey(e.target.value)} autoComplete="off" />
                <div className="flex gap-2">
                  <button className="btn-primary" onClick={addCustom}>保存渠道</button>
                  <button className="btn-secondary" onClick={() => setAddingCustom(false)}>取消</button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
