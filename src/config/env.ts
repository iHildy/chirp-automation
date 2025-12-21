import path from "path";

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  port: parseNumber(process.env.PORT, 8080),
  apiToken: process.env.API_TOKEN ?? "",
  actionsPath: process.env.ACTIONS_PATH
    ? path.resolve(process.env.ACTIONS_PATH)
    : path.resolve("config/actions.yaml"),
  artifactsDir: process.env.ARTIFACTS_DIR
    ? path.resolve(process.env.ARTIFACTS_DIR)
    : path.resolve("data/artifacts"),
  adbSerial: process.env.ADB_SERIAL ?? "emulator-5554",
  adbPath: process.env.ADB_PATH ?? "adb",
  defaultTimeoutMs: parseNumber(process.env.DEFAULT_TIMEOUT_MS, 30000),
  stepPollMs: parseNumber(process.env.STEP_POLL_MS, 500),
};
