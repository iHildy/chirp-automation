import { execFile } from "child_process";
import { promisify } from "util";
import { sleep } from "../utils/time";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

type RunOptions = {
  timeoutMs?: number;
  maxBufferBytes?: number;
};

export class AdbClient {
  constructor(
    private adbPath: string,
    private serial: string
  ) {}

  private serialArgs(): string[] {
    return this.serial ? ["-s", this.serial] : [];
  }

  private async run(
    args: string[],
    options: RunOptions = {}
  ): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(this.adbPath, args, {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
    });
    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    };
  }

  private async runBuffer(
    args: string[],
    options: RunOptions = {}
  ): Promise<Buffer> {
    const { stdout } = await execFileAsync(this.adbPath, args, {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
      encoding: null,
    });
    return stdout as Buffer;
  }

  async waitForDevice(timeoutMs = 30000): Promise<void> {
    await this.run([...this.serialArgs(), "wait-for-device"], { timeoutMs });
  }

  async getProp(key: string): Promise<string> {
    const { stdout } = await this.run([
      ...this.serialArgs(),
      "shell",
      "getprop",
      key,
    ]);
    return stdout.trim();
  }

  async waitForBootComplete(timeoutMs = 120000, pollMs = 1000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = await this.getProp("sys.boot_completed");
      if (value === "1") {
        return;
      }
      await sleep(pollMs);
    }
    throw new Error("Emulator did not finish booting in time");
  }

  async shell(command: string[], timeoutMs?: number): Promise<string> {
    const { stdout } = await this.run(
      [...this.serialArgs(), "shell", ...command],
      {
        timeoutMs,
      }
    );
    return stdout.trim();
  }

  async execOut(command: string[], timeoutMs?: number): Promise<Buffer> {
    return this.runBuffer([...this.serialArgs(), "exec-out", ...command], {
      timeoutMs,
    });
  }

  async screencap(): Promise<Buffer> {
    return this.execOut(["screencap", "-p"], 10000);
  }

  async inputTap(x: number, y: number): Promise<void> {
    await this.shell(["input", "tap", `${x}`, `${y}`]);
  }

  async inputKeyevent(keyCode: number): Promise<void> {
    await this.shell(["input", "keyevent", `${keyCode}`]);
  }

  async isScreenOn(): Promise<boolean> {
    const output = await this.shell(["dumpsys", "power"]);
    // Look for "mWakefulness=Awake" or "Display Power: state=ON"
    return output.includes("mWakefulness=Awake") || output.includes("state=ON");
  }

  async inputText(text: string): Promise<void> {
    const escaped = escapeAdbText(text);
    await this.shell(["input", "text", escaped]);
  }

  async startApp(packageName: string, activity?: string): Promise<void> {
    if (activity) {
      await this.shell(["am", "start", "-n", `${packageName}/${activity}`]);
      return;
    }

    await this.shell([
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
  }

  async getForegroundActivity(): Promise<string | null> {
    const output = await this.shell(["dumpsys", "window", "windows"]);
    const lines = output.split("\n");
    const currentFocus = findLastLine(lines, "mCurrentFocus");
    if (currentFocus) {
      return currentFocus.trim();
    }
    const focusedApp = findLastLine(lines, "mFocusedApp");
    return focusedApp ? focusedApp.trim() : null;
  }

  async getForegroundPackage(): Promise<string | null> {
    const windowOutput = await this.shell(["dumpsys", "window", "windows"]);
    const windowLines = windowOutput.split("\n");
    const fromCurrentFocus = findLastPackage(windowLines, "mCurrentFocus");
    if (fromCurrentFocus) {
      return fromCurrentFocus;
    }
    const fromFocusedApp = findLastPackage(windowLines, "mFocusedApp");
    if (fromFocusedApp) {
      return fromFocusedApp;
    }

    const activityOutput = await this.shell([
      "dumpsys",
      "activity",
      "activities",
    ]);
    const activityLines = activityOutput.split("\n");
    const fromTopResumed = findLastPackage(activityLines, "topResumedActivity");
    if (fromTopResumed) {
      return fromTopResumed;
    }
    const fromResumed = findLastPackage(activityLines, "mResumedActivity");
    if (fromResumed) {
      return fromResumed;
    }
    return findLastPackage(activityLines, "mFocusedActivity");
  }
}

function escapeAdbText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "%s")
    .replace(/&/g, "\\&")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\?/g, "\\?")
    .replace(/!/g, "\\!");
}
function extractPackageName(line: string): string | null {
  const componentMatch = line.match(
    /\b([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/[A-Za-z0-9_.$]+/
  );
  if (componentMatch) {
    return componentMatch[1];
  }
  const packageMatch = line.match(/\b([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\b/);
  return packageMatch ? packageMatch[1] : null;
}

function findLastLine(lines: string[], key: string): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.includes(key)) {
      return line;
    }
  }
  return null;
}

function findLastPackage(lines: string[], key: string): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(key)) {
      continue;
    }
    const pkg = extractPackageName(line);
    if (pkg) {
      return pkg;
    }
  }
  return null;
}
