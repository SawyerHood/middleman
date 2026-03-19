import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BACKEND_ENTRY_PATH = resolve(REPO_ROOT, "apps/backend/dist/index.js");
const UI_BUILD_DIR = resolve(REPO_ROOT, "apps/ui/.output/public");

export interface StartedMiddlemanStack {
  readonly baseUrl: string;
  readonly homeDir: string;
  stop: () => Promise<void>;
}

export async function startMiddlemanStack(
  fixture: Record<string, unknown>,
): Promise<StartedMiddlemanStack> {
  await Promise.all([
    assertPathExists(BACKEND_ENTRY_PATH, "backend build output"),
    assertPathExists(UI_BUILD_DIR, "UI build output"),
  ]);

  const [port, homeDir] = await Promise.all([
    allocatePort(),
    mkdtemp(resolve(tmpdir(), "middleman-e2e-")),
  ]);
  const fixturePath = resolve(homeDir, "mock-runtime.json");
  await writeFile(fixturePath, JSON.stringify(fixture, null, 2), "utf8");

  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = "";

  const child = spawn(process.execPath, [BACKEND_ENTRY_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MIDDLEMAN_HOST: "127.0.0.1",
      MIDDLEMAN_PORT: String(port),
      MIDDLEMAN_HOME: homeDir,
      MIDDLEMAN_INSTALL_DIR: REPO_ROOT,
      MIDDLEMAN_PROJECT_ROOT: REPO_ROOT,
      MIDDLEMAN_UI_DIR: UI_BUILD_DIR,
      MIDDLEMAN_E2E_RUNTIME_FIXTURE: fixturePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, child, () => logs);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        onceExit(child),
        new Promise<void>((resolveTimeout) => {
          setTimeout(resolveTimeout, 2_000);
        }),
      ]);
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await onceExit(child);
    }

    await rm(homeDir, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    homeDir,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          onceExit(child),
          new Promise<void>((resolveTimeout) => {
            setTimeout(resolveTimeout, 5_000);
          }),
        ]);
      }

      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await onceExit(child);
      }

      await rm(homeDir, { recursive: true, force: true });
    },
  };
}

async function assertPathExists(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(
      `Missing ${label} at ${path}. Run "pnpm build" before executing Playwright tests.`,
    );
  }
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();

    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Failed to allocate a TCP port for Playwright E2E tests."));
        return;
      }

      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }

        resolvePort(address.port);
      });
    });
  });
}

async function waitForServer(
  baseUrl: string,
  child: ReturnType<typeof spawn>,
  readLogs: () => string,
): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Middleman backend exited before becoming healthy.\n\n${readLogs().trim()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the deadline.
    }

    await new Promise((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }

  throw new Error(`Timed out waiting for ${baseUrl}.\n\n${readLogs().trim()}`);
}

async function onceExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}
