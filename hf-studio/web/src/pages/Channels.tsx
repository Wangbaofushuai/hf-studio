import { useEffect, useMemo, useState } from "react";
import { deleteChannel, fetchChannels, fetchChannelModels, saveChannel, testChannel } from "../api";
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

/** 模型多选面板：关键词筛选 + 可滚动 chip 列表 */
function ModelPicker({
  fetched, selected, toggle, filter, setFilter, selectAll, clearAll,
}: {
  fetched: string[];
  selected: Set<string>;
  toggle: (m: string) => void;
  filter: string;
  setFilter: (v: string) => void;
  selectAll: () => void;
  clearAll: () => void;
}) {
  const shown = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    return kw ? fetched.filter((m) => m.toLowerCase().includes(kw)) : fetched;
  }, [fetched, filter]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input className="input flex-1 !py-1.5 text-xs" placeholder="筛选模型…（输入关键词）" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={selectAll}>全选</button>
        <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={clearAll}>清空</button>
        <span className="shrink-0 text-xs text-neutral-400">{selected.size}/{fetched.length}</span>
      </div>
      <div className="max-h-40 space-y-1 overflow-auto pr-1">
        {shown.map((m) => {
          const on = selected.has(m);
          return (
            <label key={m} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${on ? "bg-[#0071e3]/10 text-[#0071e3] dark:text-[#409cff]" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(m)} className="h-3.5 w-3.5 accent-[#0071e3]" />
              <span className="font-mono text-xs">{m}</span>
            </label>
          );
        })}
        {shown.length === 0 && <p className="px-2 text-xs text-neutral-400">无匹配模型</p>}
      </div>
    </div>
  );
}

function ChannelCard({ ch, onSaved }: { ch: ChannelDto; onSaved: (c: ChannelsDto) => void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  // 获取模型状态：fetched=接口返回的完整列表；selected=当前勾选
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchErr, setFetchErr] = useState("");
  const brand = BRAND[ch.id] ?? { initial: "?", hue: "from-neutral-400 to-neutral-600" };

  const toggle = (m: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(fetched ?? []));
  const clearAll = () => setSelected(new Set());

  const fetchModels = async () => {
    setFetching(true); setFetchErr(""); setTest(null);
    try {
      const { models } = await fetchChannelModels(ch.id, key.trim() || undefined);
      setFetched(models);
      // 默认勾选：当前生效模型 ∩ 接口列表（无交集则全不选，避免误选）
      const cur = new Set(ch.models);
      setSelected(new Set(models.filter((m) => cur.has(m))));
      setFilter("");
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (!key.trim() && !ch.hasKey) return;
    setSaving(true); setTest(null);
    try {
      const body: { apiKey?: string; models?: string[] } = {};
      if (key.trim()) body.apiKey = key.trim();
      if (fetched) body.models = [...selected]; // 获取过 → 保存所选（可为空=回退预设）
      const cat = await saveChannel(ch.id, body);
      onSaved(cat);
      setKey("");
      setFetchErr("");
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const clear = async () => {
    if (!confirm(`清除 ${ch.name} 的 Key？`)) return;
    const cat = await deleteChannel(ch.id);
    onSaved(cat);
    setTest(null);
    setFetched(null);
    setSelected(new Set());
  };

  const runTest = async () => {
    setTest(null);
    setTest(await testChannel(ch.id));
  };

  const shownModels = fetched ?? ch.models;

  return (
    <div className="glass flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-bold text-white ${brand.hue}`}>
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

      {fetched ? (
        <ModelPicker fetched={fetched} selected={selected} toggle={toggle} filter={filter} setFilter={setFilter} selectAll={selectAll} clearAll={clearAll} />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shownModels.map((m) => (
            <span key={m} className="rounded-md bg-black/[0.05] px-2 py-0.5 font-mono text-[11px] text-neutral-500 dark:bg-white/10 dark:text-neutral-300">{m}</span>
          ))}
          {shownModels.length === 0 && <span className="text-xs text-neutral-400">（自定义渠道：点击「获取模型」自动拉取）</span>}
        </div>
      )}

      <div className="flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={ch.hasKey ? "输入新 Key 覆盖" : "粘贴 API Key"}
          className="input flex-1" autoComplete="off" />
        <button className="btn-secondary" onClick={fetchModels} disabled={fetching || (!key.trim() && !ch.hasKey)}>
          {fetching ? "获取中…" : "获取模型"}
        </button>
        <button className="btn-primary" onClick={save} disabled={saving || (!key.trim() && !ch.hasKey)}>{saving ? "保存中…" : "保存"}</button>
        {ch.hasKey && (
          <>
            <button className="btn-secondary" onClick={runTest}>测试</button>
            <button className="btn-secondary" onClick={clear}>清除</button>
          </>
        )}
      </div>
      {fetchErr && <p className="text-xs text-red-500">{fetchErr}</p>}
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
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">填入 Key 后点「获取模型」拉取该渠道全部模型，勾选需要的保存；Key 只存服务器、不回显。</p>
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
