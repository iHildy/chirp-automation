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

const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("type", [
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
      type: z.literal("tap_selector"),
      selector: SelectorSchema,
      timeoutMs: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("tap_coordinates"),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal("wait_for_text"),
      text: z.string().min(1).optional(),
      textContains: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
    }).refine(
      (value) => Boolean(value.text || value.textContains),
      { message: "wait_for_text requires text or textContains" }
    ),
    z.object({
      type: z.literal("wait_for_selector"),
      selector: SelectorSchema,
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

export type Selector = z.infer<typeof SelectorSchema>;
export type Step = z.infer<typeof StepSchema>;
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
