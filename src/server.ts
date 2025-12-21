import express from "express";
import { loadActionConfig } from "./config/actions";
import { env } from "./config/env";
import { logger } from "./logger";
import { AdbClient } from "./worker/adb";
import { ActionError, ActionRunner } from "./worker/runner";

if (!env.apiToken) {
  logger.error("API_TOKEN is required to start the server");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const adb = new AdbClient(env.adbPath, env.adbSerial);
const runner = new ActionRunner(adb, {
  artifactsDir: env.artifactsDir,
  defaultTimeoutMs: env.defaultTimeoutMs,
  stepPollMs: env.stepPollMs,
});

app.use("/v1", (req, res, next) => {
  const authHeader = req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  if (token !== env.apiToken) {
    return res.status(401).json({ error: "unauthorized" });
  }

  return next();
});

app.post("/v1/actions/:actionId", async (req, res) => {
  try {
    const config = await loadActionConfig(env.actionsPath);
    const result = await runner.enqueue(req.params.actionId, config);
    res.json(result);
  } catch (error) {
    if (error instanceof ActionError) {
      res.status(500).json(error.result);
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ status: "error", error: message });
  }
});

app.get("/v1/health", async (_req, res) => {
  try {
    await adb.waitForDevice(3000);
    const booted = await adb.getProp("sys.boot_completed");
    res.json({
      status: booted === "1" ? "ok" : "starting",
      adbSerial: env.adbSerial,
      bootCompleted: booted === "1",
    });
  } catch (error) {
    res.status(503).json({
      status: "down",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/v1/debug/screenshot", async (_req, res) => {
  try {
    const image = await adb.screencap();
    res.setHeader("Content-Type", "image/png");
    res.send(image);
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/v1/debug/state", async (_req, res) => {
  try {
    const foreground = await adb.getForegroundActivity();
    res.json({
      foreground,
      runner: runner.getState(),
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(env.port, () => {
  logger.info("server.listening", { port: env.port });
});
