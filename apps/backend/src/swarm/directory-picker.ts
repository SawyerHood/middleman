import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PICKER_PROMPT = "Select a manager working directory";

type ExecFileResult = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type ExecFileFn = (command: string, args: string[]) => Promise<ExecFileResult>;

interface PickerCommand {
  command: string;
  args: string[];
}

export interface PickDirectoryOptions {
  defaultPath?: string;
  prompt?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  execFileFn?: ExecFileFn;
}

export async function pickDirectory(options: PickDirectoryOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const prompt = options.prompt?.trim() || DEFAULT_PICKER_PROMPT;
  const defaultPath = options.defaultPath?.trim() || undefined;
  const cwd = options.cwd ?? process.cwd();
  const execFileFn = options.execFileFn ?? execFileCommand;

  switch (platform) {
    case "darwin":
      return pickDirectoryFromCommands(
        [
          {
            command: "osascript",
            args: [
              "-e",
              `set pickedFolder to choose folder with prompt \"${escapeAppleScriptString(prompt)}\"`,
              "-e",
              "POSIX path of pickedFolder",
            ],
          },
        ],
        execFileFn,
      );

    case "linux":
      return pickDirectoryFromCommands(
        [
          {
            command: "zenity",
            args: [
              "--file-selection",
              "--directory",
              `--title=${prompt}`,
              ...(defaultPath ? [`--filename=${ensureTrailingSlash(defaultPath)}`] : []),
            ],
          },
          {
            command: "kdialog",
            args: ["--title", prompt, "--getexistingdirectory", defaultPath ?? cwd],
          },
        ],
        execFileFn,
      );

    case "win32": {
      const pickScript = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$dialog.Description = '${escapePowerShellString(prompt)}'`,
        "$dialog.UseDescriptionForTitle = $true",
        ...(defaultPath ? [`$dialog.SelectedPath = '${escapePowerShellString(defaultPath)}'`] : []),
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
        "  [Console]::Out.Write($dialog.SelectedPath)",
        "}",
      ].join(";");

      return pickDirectoryFromCommands(
        [
          {
            command: "powershell",
            args: ["-NoLogo", "-NoProfile", "-STA", "-Command", pickScript],
          },
          {
            command: "pwsh",
            args: ["-NoLogo", "-NoProfile", "-STA", "-Command", pickScript],
          },
        ],
        execFileFn,
      );
    }

    default:
      throw new Error(`Directory picker is not supported on platform \"${platform}\".`);
  }
}

async function pickDirectoryFromCommands(
  commands: PickerCommand[],
  execFileFn: ExecFileFn,
): Promise<string | null> {
  let sawMissingCommand = false;

  for (const commandSpec of commands) {
    try {
      const result = await execFileFn(commandSpec.command, commandSpec.args);
      const pickedPath = String(result.stdout ?? "").trim();
      if (!pickedPath) {
        return null;
      }

      return resolve(pickedPath);
    } catch (error) {
      if (isDirectoryPickerCanceled(error)) {
        return null;
      }

      if (isCommandMissing(error)) {
        sawMissingCommand = true;
        continue;
      }

      throw error;
    }
  }

  if (sawMissingCommand) {
    throw new Error("Directory picker is not supported in this environment.");
  }

  throw new Error("Directory picker is not supported on this platform.");
}

async function execFileCommand(command: string, args: string[]): Promise<ExecFileResult> {
  return execFileAsync(command, args);
}

function isCommandMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isDirectoryPickerCanceled(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as {
    code?: number | string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };

  if (record.code === 1 || record.code === "1") {
    return true;
  }

  const stderr = String(record.stderr ?? "").toLowerCase();
  const stdout = String(record.stdout ?? "").toLowerCase();

  return (
    stderr.includes("cancel") ||
    stderr.includes("canceled") ||
    stderr.includes("cancelled") ||
    stderr.includes("-128") ||
    stdout.includes("cancel") ||
    stdout.includes("canceled") ||
    stdout.includes("cancelled")
  );
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

function ensureTrailingSlash(pathValue: string): string {
  if (!pathValue) {
    return pathValue;
  }

  const hasTrailingSeparator = /[\\/]$/.test(pathValue);
  if (hasTrailingSeparator) {
    return pathValue;
  }

  return `${pathValue}/`;
}
