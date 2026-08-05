import type { ChannelsDto, JobDetailDto, JobDto, ModelsDto, VoiceDto } from "./types";

async function j<T>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error ?? r.statusText);
  return r.json() as Promise<T>;
}

export const createJob = (form: FormData) => j<{ id: string }>(fetch("/api/jobs", { method: "POST", body: form }));
export const listJobs = () => j<{ jobs: JobDto[] }>(fetch("/api/jobs"));
export const getJob = (id: string) => j<JobDetailDto>(fetch(`/api/jobs/${id}`));
export const rerunJob = (id: string, step: number, model?: string) =>
  j<{ ok: boolean }>(fetch(`/api/jobs/${id}/rerun`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, model }) }));
export const fetchModels = () => j<ModelsDto>(fetch("/api/models"));
export const fetchVoices = (lang = "zh-CN") => j<{ voices: VoiceDto[] }>(fetch(`/api/voices?lang=${encodeURIComponent(lang)}`));

// ── 模型渠道管理 ──
export const fetchChannels = () => j<ChannelsDto>(fetch("/api/channels"));
export const saveChannel = (id: string, body: { apiKey: string; baseURL?: string; models?: string[] }) =>
  j<ChannelsDto>(fetch(`/api/channels/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
export const deleteChannel = (id: string) => j<ChannelsDto>(fetch(`/api/channels/${id}`, { method: "DELETE" }));
export const testChannel = async (id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> => {
  const r = await fetch(`/api/channels/${id}/test`);
  return r.json() as Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
};

export function subscribeJob(id: string, onEvent: (e: unknown) => void): () => void {
  const es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ping */ } };
  es.onerror = () => { /* EventSource 自动重连 */ };
  return () => es.close();
}
