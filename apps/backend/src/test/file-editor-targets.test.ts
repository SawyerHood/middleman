import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFileEditorTargets } from "../ws/routes/file-editor-targets.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(resolve(tmpdir(), "middleman-file-editor-targets-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

describe("resolveFileEditorTargets", () => {
  it("derives a middleman notes path for markdown files inside the notes directory", async () => {
    const dataDir = await createTempDir();
    const notePath = resolve(dataDir, "notes", "projects", "roadmap.md");

    await mkdir(resolve(dataDir, "notes", "projects"), { recursive: true });
    await writeFile(notePath, "# Roadmap\n");

    await expect(
      resolveFileEditorTargets({
        dataDir,
        filePath: notePath,
      }),
    ).resolves.toEqual({
      notesPath: "projects/roadmap.md",
    });
  });

  it("detects the nearest obsidian vault root for a file", async () => {
    const dataDir = await createTempDir();
    const vaultDir = resolve(dataDir, "vaults", "Personal");
    const filePath = resolve(vaultDir, "Projects", "Plan.md");

    await mkdir(resolve(vaultDir, ".obsidian"), { recursive: true });
    await mkdir(resolve(vaultDir, "Projects"), { recursive: true });
    await writeFile(filePath, "# Plan\n");

    await expect(
      resolveFileEditorTargets({
        dataDir,
        filePath,
      }),
    ).resolves.toEqual({
      obsidian: {
        vault: "Personal",
        file: "Projects/Plan.md",
      },
    });
  });

  it("omits unavailable editor targets", async () => {
    const dataDir = await createTempDir();
    const filePath = resolve(dataDir, "artifacts", "diagram.png");

    await mkdir(resolve(dataDir, "artifacts"), { recursive: true });
    await writeFile(filePath, "not-a-real-png");

    await expect(
      resolveFileEditorTargets({
        dataDir,
        filePath,
      }),
    ).resolves.toEqual({});
  });
});
