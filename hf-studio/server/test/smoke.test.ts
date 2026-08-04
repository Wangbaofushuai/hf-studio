import { describe, expect, test } from "bun:test";
import type { JobStatus, StepId } from "../src/types";
import { steps } from "../src/pipeline/steps";

describe("types", () => {
  test("shared types exist and are sane", () => {
    const statuses: JobStatus[] = ["queued", "running", "failed", "needs_review", "completed"];
    expect(statuses).toHaveLength(5);
    const steps: StepId[] = [0, 1, 2, 3, 4, 5, 6];
    expect(steps).toHaveLength(7);
  });
});

test("pipeline steps registered 0..6", () => {
  expect(steps).toHaveLength(7);
});
