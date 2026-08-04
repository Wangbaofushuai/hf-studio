import type { JobRow } from "../db/store";
import type { StepOutput } from "../types";

export interface JobDetail {
  job: JobRow;
  steps: StepOutput[];
  artifacts: string[];
}

export function toJobDetail(job: JobRow, steps: StepOutput[], artifacts: string[]): JobDetail {
  return { job, steps, artifacts };
}
