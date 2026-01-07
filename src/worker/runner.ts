import fs from "fs/promises";
import path from "path";
import {
  ActionConfig,
  ActionDefinition,
  Selector,
  Step,
  createTextSelector,
} from "../config/actions";
import { logger } from "../logger";
import { sleep, withTimeout } from "../utils/time";
import { AdbClient } from "./adb";
import {
  boundsCenter,
  dumpUiHierarchy,
  findAnySelectorBounds,
  findSelectorBounds,
} from "./uiautomator";

export type ActionResult = {
  actionId: string;
  status: "ok" | "error";
  durationMs: number;
  error?: string;
  startedAt: string;
};

export class ActionError extends Error {
  constructor(public result: ActionResult) {
    super(result.error ?? "Action failed");
  }
}

type RunnerOptions = {
  artifactsDir: string;
  defaultTimeoutMs: number;
  stepPollMs: number;
};

type InFlightState = {
  actionId: string;
  startedAt: string;
};

export class ActionRunner {
  private queue: Promise<void> = Promise.resolve();
  private inFlight: InFlightState | null = null;
  private lastResult: ActionResult | null = null;
  private uiHierarchyCache: { xml: string; timestamp: number } | null = null;
  private readonly UI_CACHE_TTL_MS = 500;

  constructor(
    private adb: AdbClient,
    private options: RunnerOptions
  ) {}

  enqueue(actionId: string, config: ActionConfig): Promise<ActionResult> {
    const job = async () => {
      const action = this.resolveAction(actionId, config);
      return this.runAction(actionId, action);
    };

    const runPromise = this.queue.then(job);
    this.queue = runPromise.then(() => undefined).catch(() => undefined);
    return runPromise;
  }

  getState(): {
    inFlight: InFlightState | null;
    lastResult: ActionResult | null;
  } {
    return {
      inFlight: this.inFlight,
      lastResult: this.lastResult,
    };
  }

  private resolveAction(
    actionId: string,
    config: ActionConfig
  ): ActionDefinition {
    const action = config.actions[actionId];
    if (!action) {
      throw new ActionError({
        actionId,
        status: "error",
        durationMs: 0,
        error: `Unknown action: ${actionId}`,
        startedAt: new Date().toISOString(),
      });
    }
    return action;
  }

  private async runAction(
    actionId: string,
    action: ActionDefinition
  ): Promise<ActionResult> {
    const startedAt = new Date();
    const startTime = Date.now();
    this.inFlight = { actionId, startedAt: startedAt.toISOString() };

    logger.info("action.start", { actionId });

    try {
      await this.dismissSystemUiDialog();
      await fs.mkdir(this.options.artifactsDir, { recursive: true });

      let remainingSteps = action.steps;
      const preSteps: Step[] = [];
      while (
        remainingSteps.length > 0 &&
        remainingSteps[0]?.type === "ensure_emulator_ready"
      ) {
        preSteps.push(remainingSteps[0]);
        remainingSteps = remainingSteps.slice(1);
      }

      if (preSteps.length > 0) {
        await this.runSteps(actionId, preSteps);
      }

      const timeoutMs = action.timeoutMs ?? this.options.defaultTimeoutMs;
      await withTimeout(this.runSteps(actionId, remainingSteps), timeoutMs, `Action ${actionId}`);

      const result: ActionResult = {
        actionId,
        status: "ok",
        durationMs: Date.now() - startTime,
        startedAt: startedAt.toISOString(),
      };

      this.lastResult = result;
      logger.info("action.success", {
        actionId,
        durationMs: result.durationMs,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await this.captureFailureArtifacts(actionId, message);

      const result: ActionResult = {
        actionId,
        status: "error",
        durationMs: Date.now() - startTime,
        error: message,
        startedAt: startedAt.toISOString(),
      };
      this.lastResult = result;

      logger.error("action.failure", {
        actionId,
        durationMs: result.durationMs,
        error: message,
      });

      throw new ActionError(result);
    } finally {
      this.inFlight = null;
    }
  }

  private async runSteps(actionId: string, steps: Step[]): Promise<void> {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      logger.info("step.start", {
        actionId,
        stepIndex: index,
        stepType: step.type,
      });
      const stepStart = Date.now();

      await this.executeStep(actionId, step, index);

      logger.info("step.success", {
        actionId,
        stepIndex: index,
        stepType: step.type,
        durationMs: Date.now() - stepStart,
      });
    }
  }

  private async executeStep(
    actionId: string,
    step: Step,
    stepIndex: number
  ): Promise<void> {
    switch (step.type) {
      case "ensure_emulator_ready": {
        const readyTimeoutMs = step.timeoutMs ?? 600000;
        await this.adb.waitForDevice(readyTimeoutMs);
        await this.adb.waitForBootComplete(readyTimeoutMs, this.options.stepPollMs);
        return;
      }
      case "wake_and_unlock": {
        const wasScreenOn = await this.adb.isScreenOn();
        logger.info("step.wake_and_unlock", {
          actionId,
          stepIndex,
          wasScreenOn,
        });
        if (!wasScreenOn) {
          await this.adb.inputKeyevent(224);
          await this.adb.inputKeyevent(82);
          await this.adb.inputKeyevent(3);
          this.adb.invalidateScreenCache();
        }
        return;
      }
      case "launch_app":
        await this.adb.startApp(step.package, step.activity);
        return;
      case "ensure_app_open": {
        const stepStart = Date.now();

        if (step.alreadyOpenSelector) {
          const selectorMatched = await this.isSelectorVisible(
            step.alreadyOpenSelector
          );
          logger.info("step.ensure_app_open.selector_check", {
            actionId,
            stepIndex,
            selector: step.alreadyOpenSelector,
            selectorMatched,
          });

          if (selectorMatched) {
            logger.info("step.ensure_app_open.already_open", {
              actionId,
              stepIndex,
              reason: "selector_matched",
            });
            return;
          }

          logger.info("step.ensure_app_open.launching", {
            actionId,
            stepIndex,
            package: step.package,
            reason: "selector_not_found",
          });
          await this.adb.startApp(step.package, step.activity);
          this.invalidateUiCache();

          if (step.delayMsIfLaunch && step.delayMsIfLaunch > 0) {
            const elapsedMs = Date.now() - stepStart;
            const remainingMs = step.delayMsIfLaunch - elapsedMs;
            if (remainingMs > 0) {
              await sleep(remainingMs);
            }
          }
          return;
        }

        const foregroundPackage = await this.adb.getForegroundPackage();
        const packageInForeground = foregroundPackage === step.package;

        logger.info("step.ensure_app_open.check", {
          actionId,
          stepIndex,
          targetPackage: step.package,
          foregroundPackage,
          packageInForeground,
        });

        if (!packageInForeground) {
          logger.info("step.ensure_app_open.launching", {
            actionId,
            stepIndex,
            package: step.package,
            reason: "package_not_foreground",
          });
          await this.adb.startApp(step.package, step.activity);
          this.invalidateUiCache();
        } else {
          logger.info("step.ensure_app_open.already_open", {
            actionId,
            stepIndex,
            reason: "package_in_foreground",
          });
        }

        const delayMs = packageInForeground
          ? step.delayMsIfOpen
          : step.delayMsIfLaunch;
        if (delayMs && delayMs > 0) {
          const elapsedMs = Date.now() - stepStart;
          const remainingMs = delayMs - elapsedMs;
          if (remainingMs > 0) {
            await sleep(remainingMs);
          }
        }
        return;
      }
      case "tap_selector":
        await this.tapSelector(step.selector, step.timeoutMs);
        return;
      case "tap_coordinates":
        await this.adb.inputTap(step.x, step.y);
        return;
      case "wait_for_text":
        await this.waitForSelector(createTextSelector(step), step.timeoutMs);
        return;
      case "wait_for_selector":
        await this.waitForSelector(step.selector, step.timeoutMs);
        return;
      case "wait_for_any_selector":
        await this.waitForAnySelector(step.selectors, step.timeoutMs);
        return;
      case "sleep":
        await sleep(step.durationMs);
        return;
      case "input_text":
        await this.adb.inputText(step.text);
        return;
      case "keyevent":
        await this.adb.inputKeyevent(step.keyCode);
        return;
      case "retry":
        await this.runWithRetry(actionId, step, stepIndex);
        return;
      case "repeat":
        await this.runRepeat(actionId, step, stepIndex);
        return;
      default:
        throw new Error(`Unsupported step type: ${(step as Step).type}`);
    }
  }

  private async runWithRetry(
    actionId: string,
    step: Extract<Step, { type: "retry" }>,
    stepIndex: number
  ): Promise<void> {
    for (let attempt = 1; attempt <= step.attempts; attempt += 1) {
      try {
        if (attempt > 1) {
          logger.warn("step.retry_attempt", {
            actionId,
            stepIndex,
            attempt,
          });
        } else {
          logger.info("step.retry_attempt", {
            actionId,
            stepIndex,
            attempt,
          });
        }
        await this.runSteps(actionId, step.steps);
        return;
      } catch (error) {
        if (attempt === step.attempts) {
          throw error;
        }
        await sleep(step.delayMs ?? 500);
      }
    }
  }

  private async runRepeat(
    actionId: string,
    step: Extract<Step, { type: "repeat" }>,
    stepIndex: number
  ): Promise<void> {
    for (let iteration = 1; iteration <= step.count; iteration += 1) {
      logger.info("step.repeat_iteration", {
        actionId,
        stepIndex,
        iteration,
        total: step.count,
      });

      await this.runSteps(actionId, step.steps);

      if (iteration < step.count && (step.delayMs ?? 0) > 0) {
        await sleep(step.delayMs ?? 0);
      }
    }
  }

  private async tapSelector(
    selector: Selector,
    timeoutMs?: number
  ): Promise<void> {
    const bounds = await this.waitForSelector(selector, timeoutMs);
    const { x, y } = boundsCenter(bounds);
    await this.adb.inputTap(x, y);
  }

  private async getUiHierarchy(): Promise<string> {
    const now = Date.now();
    if (
      this.uiHierarchyCache &&
      now - this.uiHierarchyCache.timestamp < this.UI_CACHE_TTL_MS
    ) {
      return this.uiHierarchyCache.xml;
    }

    const xml = await dumpUiHierarchy(this.adb);
    this.uiHierarchyCache = { xml, timestamp: now };
    return xml;
  }

  private invalidateUiCache(): void {
    this.uiHierarchyCache = null;
  }

  private async isSelectorVisible(selector: Selector): Promise<boolean> {
    const xml = await this.getUiHierarchy();
    return Boolean(findSelectorBounds(xml, selector));
  }

  private async waitForSelector(
    selector: Selector,
    timeoutMs?: number
  ): Promise<{ left: number; top: number; right: number; bottom: number }> {
    const deadline = Date.now() + (timeoutMs ?? this.options.defaultTimeoutMs);
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      try {
        this.invalidateUiCache();
        const xml = await this.getUiHierarchy();
        const bounds = findSelectorBounds(xml, selector);
        if (bounds) {
          return bounds;
        }

        // If not found, check for System UI "not responding" dialog
        if (await this.checkAndDismissSystemUiDialog(xml)) {
          // If we dismissed a dialog, wait a bit for it to disappear and try again immediately
          await sleep(this.options.stepPollMs);
          continue;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : null;
      }

      await sleep(this.options.stepPollMs);
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(
      `Selector not found before timeout: ${JSON.stringify(selector)}`
    );
  }

  private async waitForAnySelector(
    selectors: Selector[],
    timeoutMs?: number
  ): Promise<void> {
    const deadline = Date.now() + (timeoutMs ?? this.options.defaultTimeoutMs);
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      try {
        this.invalidateUiCache();
        const xml = await this.getUiHierarchy();
        const result = findAnySelectorBounds(xml, selectors);
        if (result) {
          return;
        }

        // If not found, check for System UI "not responding" dialog
        if (await this.checkAndDismissSystemUiDialog(xml)) {
          // If we dismissed a dialog, wait a bit for it to disappear and try again immediately
          await sleep(this.options.stepPollMs);
          continue;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : null;
      }

      await sleep(this.options.stepPollMs);
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(
      `No selectors matched before timeout: ${JSON.stringify(selectors)}`
    );
  }

  private async captureFailureArtifacts(
    actionId: string,
    reason: string
  ): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = `${actionId}-${timestamp}`;
    const dir = this.options.artifactsDir;

    try {
      this.invalidateUiCache();
      const screenshot = await this.adb.screencap();
      const xml = await this.getUiHierarchy();

      await Promise.all([
        fs.writeFile(path.join(dir, `${baseName}.png`), screenshot),
        fs.writeFile(
          path.join(dir, `${baseName}.xml`),
          `<!-- ${reason} -->\n${xml}`
        ),
      ]);
    } catch (error) {
      logger.warn("artifact.capture_failed", {
        actionId,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  private async dismissSystemUiDialog(): Promise<void> {
    try {
      this.invalidateUiCache();
      const xml = await this.getUiHierarchy();
      await this.checkAndDismissSystemUiDialog(xml);
    } catch (error) {
      logger.warn("system_ui.dismiss_check_failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  private async checkAndDismissSystemUiDialog(xml: string): Promise<boolean> {
    const dialogSelectors: Selector[] = [
      { textContains: "System UI isn't responding" },
      { textContains: "Process system isn't responding" },
      { textContains: "System UI is not responding" },
    ];

    const waitButtonSelectors: Selector[] = [
      { text: "Wait" },
      { text: "WAIT" },
    ];

    const hasDialog = dialogSelectors.some((s) => findSelectorBounds(xml, s));
    if (!hasDialog) {
      return false;
    }

    const waitResult = findAnySelectorBounds(xml, waitButtonSelectors);
    if (waitResult) {
      logger.info("system_ui.dismissing", {
        reason: "detected_not_responding_dialog",
      });
      const { x, y } = boundsCenter(waitResult.bounds);
      await this.adb.inputTap(x, y);
      this.invalidateUiCache();
      return true;
    }

    return false;
  }
}
