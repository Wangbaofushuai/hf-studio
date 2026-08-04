import { useEffect, useState } from "react";
import { fetchModels } from "../api";

export default function ModelSelect({ value, onChange, extraProviders }: { value: string; onChange: (v: string) => void; extraProviders?: { id: string; models: string[] }[] }) {
  const [models, setModels] = useState<{ providers: { id: string; models: string[] }[]; default: string } | null>(null);
  useEffect(() => { fetchModels().then(setModels).catch(() => setModels({ providers: [], default: "" })); }, []);
  // 模型列表加载后，若尚未选择则填入默认模型
  useEffect(() => {
    if (models && models.default && !value) onChange(models.default);
  }, [models]);
  const all = [...(models?.providers ?? []), ...(extraProviders ?? [])];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm">
      {!all.length && <option value="">（未配置模型，请在下方自定义渠道或 server/config.json 配置）</option>}
      {all.map((p) => p.models.map((m) => (
        <option key={`${p.id}/${m}`} value={`${p.id}/${m}`}>{p.id}/{m}</option>
      )))}
    </select>
  );
}
