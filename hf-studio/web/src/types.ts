export type JobStatus = "queued" | "running" | "failed" | "needs_review" | "completed";
export interface JobConfigDto {
  idea: string; durationSec: number; format: "landscape" | "portrait" | "square";
  voiceover: boolean; voice: string; language: string;
  models: { default: string; steps?: Record<number, string> };
  materials: { images: string[]; audio: string | null };
}
export interface JobDto { id: string; status: JobStatus; currentStep: number | null; error: string | null; config: JobConfigDto; createdAt: string; updatedAt: string }
export interface StepOutputDto { step: number; status: string; artifacts: string[]; data: Record<string, unknown>; log: string; error?: string; attempts: number; judge?: { score: number; rubric: Record<string, number>; feedback: string } }
export interface JobDetailDto { job: JobDto; steps: StepOutputDto[]; artifacts: string[] }
export interface ModelsDto { providers: { id: string; models: string[] }[]; default: string }
export interface VoiceDto { shortName: string; gender: string; locale: string }
