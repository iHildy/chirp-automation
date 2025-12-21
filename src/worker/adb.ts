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
  constructor(private adbPath: string, private serial: string) {}

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
    const { stdout } = await this.run([
      ...this.serialArgs(),
      "shell",
      ...command,
    ], {
      timeoutMs,
    });
    return stdout.trim();
  }

  async execOut(command: string[], timeoutMs?: number): Promise<Buffer> {
    return this.runBuffer([
      ...this.serialArgs(),
      "exec-out",
      ...command,
    ], {
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

  async inputText(text: string): Promise<void> {
    const escaped = escapeAdbText(text);
    await this.shell(["input", "text", escaped]);
  }

  async startApp(packageName: string, activity?: string): Promise<void> {
    if (activity) {
      await this.shell([
        "am",
        "start",
        "-n",
        `${packageName}/${activity}`,
      ]);
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
    const line = output
      .split("\n")
      .find((entry) =>
        entry.includes("mCurrentFocus") || entry.includes("mFocusedApp")
      );

    return line ? line.trim() : null;
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
