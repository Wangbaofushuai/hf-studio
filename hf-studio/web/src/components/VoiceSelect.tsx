import { useEffect, useState } from "react";
import { fetchVoices } from "../api";
import type { VoiceDto } from "../types";

export default function VoiceSelect({ lang, value, onChange }: { lang: string; value: string; onChange: (v: string) => void }) {
  const [voices, setVoices] = useState<VoiceDto[]>([]);
  useEffect(() => { fetchVoices(lang).then((r) => setVoices(r.voices)).catch(() => setVoices([])); }, [lang]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm">
      {voices.map((v) => <option key={v.shortName} value={v.shortName}>{v.shortName}（{v.gender === "Female" ? "女声" : "男声"}）</option>)}
    </select>
  );
}
