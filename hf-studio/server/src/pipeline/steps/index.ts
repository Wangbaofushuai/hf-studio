import type { StepFn } from "../../types";
import { step0Parse } from "./step0-parse";
import { step1Design } from "./step1-design";
import { step2Storyboard } from "./step2-storyboard";
import { step3Tts } from "./step3-tts";
import { step4Build } from "./step4-build";
import { step5Validate } from "./step5-validate";
import { step6Render } from "./step6-render";

export const steps: StepFn[] = [step0Parse, step1Design, step2Storyboard, step3Tts, step4Build, step5Validate, step6Render];
