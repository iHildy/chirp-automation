import fs from "fs/promises";
import yaml from "js-yaml";
import { z } from "zod";

const SelectorSchema = z
  .object({
    text: z.string().min(1).optional(),
    textContains: z.string().min(1).optional(),
    resourceId: z.string().min(1).optional(),
    resourceIdContains: z.string().min(1).optional(),
    contentDesc: z.string().min(1).optional(),
    contentDescContains: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      Object.values(value).some((entry) =>
        typeof entry === "string" ? entry.length > 0 : false
      ),
    { message: "selector must define at least one match field" }
  );

type SelectorDefinition = z.infer<typeof SelectorSchema>;

type WaitForTextStep =
  | {
      type: "wait_for_text";
      text: string;
      textContains?: string;
      timeoutMs?: number;
    }
  | {
      type: "wait_for_text";
      text?: string;
      textContains: string;
      timeoutMs?: number;
    };

type StepDefinition =
  | { type: "ensure_emulator_ready"; timeoutMs?: number }
  | { type: "wake_and_unlock" }
  | { type: "launch_app"; package: string; activity?: string }
  | {
      type: "ensure_app_open";
      package: string;
      activity?: string;
      alreadyOpenSelector?: SelectorDefinition;
      delayMsIfOpen?: number;
      delayMsIfLaunch?: number;
    }
  | { type: "tap_selector"; selector: SelectorDefinition; timeoutMs?: number }
  | { type: "tap_coordinates"; x: number; y: number }
  | WaitForTextStep
  | { type: "wait_for_selector"; selector: SelectorDefinition; timeoutMs?: number }
  | {
      type: "wait_for_any_selector";
      selectors: SelectorDefinition[];
      timeoutMs?: number;
    }
  | { type: "sleep"; durationMs: number }
  | { type: "input_text"; text: string }
  | { type: "keyevent"; keyCode: number }
  | { type: "retry"; attempts: number; delayMs?: number; steps: StepDefinition[] }
  | { type: "repeat"; count: number; delayMs?: number; steps: StepDefinition[] };

const WaitForTextSchema = z.union([
  z.object({
    type: z.literal("wait_for_text"),
    text: z.string().min(1),
    textContains: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("wait_for_text"),
    text: z.string().min(1).optional(),
    textContains: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

const StepSchema: z.ZodType<StepDefinition> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal("ensure_emulator_ready"),
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("wake_and_unlock"),
    }),
    z.object({
      type: z.literal("launch_app"),
      package: z.string().min(1),
      activity: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal("ensure_app_open"),
      package: z.string().min(1),
      activity: z.string().min(1).optional(),
      alreadyOpenSelector: SelectorSchema.optional(),
      delayMsIfOpen: z.number().int().nonnegative().optional(),
      delayMsIfLaunch: z.number().int().nonnegative().optional(),
    }),
    z.object({
      type: z.literal("tap_selector"),
      selector: SelectorSchema,
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("tap_coordinates"),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
    }),
    WaitForTextSchema,
    z.object({
      type: z.literal("wait_for_selector"),
      selector: SelectorSchema,
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("wait_for_any_selector"),
      selectors: z.array(SelectorSchema).min(1),
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("sleep"),
      durationMs: z.number().int().positive(),
    }),
    z.object({
      type: z.literal("input_text"),
      text: z.string(),
    }),
    z.object({
      type: z.literal("keyevent"),
      keyCode: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal("retry"),
      attempts: z.number().int().min(1),
      delayMs: z.number().int().nonnegative().optional(),
      steps: z.array(StepSchema).min(1),
    }),
    z.object({
      type: z.literal("repeat"),
      count: z.number().int().min(1),
      delayMs: z.number().int().nonnegative().optional(),
      steps: z.array(StepSchema).min(1),
    }),
  ])
);

const ActionSchema = z.object({
  description: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  steps: z.array(StepSchema).min(1),
});

const ConfigSchema = z.object({
  version: z.number().int().optional(),
  actions: z.record(ActionSchema),
});

export type Selector = SelectorDefinition;
export type Step = StepDefinition;
export type ActionDefinition = z.infer<typeof ActionSchema>;
export type ActionConfig = z.infer<typeof ConfigSchema>;

export async function loadActionConfig(path: string): Promise<ActionConfig> {
  const raw = await fs.readFile(path, "utf8");
  const parsed = yaml.load(raw);
  return ConfigSchema.parse(parsed);
}

export function createTextSelector(step: {
  text?: string;
  textContains?: string;
}): Selector {
  const selector: Selector = {};
  if (step.text) {
    selector.text = step.text;
  }
  if (step.textContains) {
    selector.textContains = step.textContains;
  }
  return selector;
}
