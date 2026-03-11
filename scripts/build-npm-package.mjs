#!/usr/bin/env node

import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const ROOT_PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const BACKEND_PACKAGE_JSON_PATH = resolve(REPO_ROOT, "apps", "backend", "package.json");
const CLI_BIN_PATH = resolve(REPO_ROOT, "apps", "cli", "bin", "middleman");
const CLI_DIST_DIR = resolve(REPO_ROOT, "apps", "cli", "dist");
const BACKEND_DIST_DIR = resolve(REPO_ROOT, "apps", "backend", "dist");
const BACKEND_PUBLIC_DIR = resolve(BACKEND_DIST_DIR, "public");
const BACKEND_ASSETS_DIR = resolve(BACKEND_DIST_DIR, "assets");
const UI_PUBLIC_CANDIDATES = [
  resolve(REPO_ROOT, "apps", "ui", ".output", "public"),
  resolve(REPO_ROOT, "apps", "ui", "dist")
];
const SOURCE_ARCHETYPES_DIR = resolve(
  REPO_ROOT,
  "apps",
  "backend",
  "src",
  "swarm",
  "archetypes",
  "builtins"
);
const SOURCE_SKILLS_DIR = resolve(REPO_ROOT, "apps", "backend", "src", "swarm", "skills", "builtins");
const NPM_DIST_DIR = resolve(REPO_ROOT, "dist", "npm");
const PACKAGE_README_PATH = resolve(REPO_ROOT, "README.package.md");

await main();

async function main() {
  const uiPublicDir = resolveExistingPath(UI_PUBLIC_CANDIDATES);
  if (!uiPublicDir) {
    throw new Error("Unable to locate the built UI output. Run `pnpm --filter @middleman/ui build` first.");
  }

  assertPathExists(CLI_BIN_PATH, "CLI bin entrypoint");
  assertPathExists(CLI_DIST_DIR, "CLI dist output");
  assertPathExists(BACKEND_DIST_DIR, "Backend dist output");
  assertPathExists(SOURCE_ARCHETYPES_DIR, "Built-in archetype assets");
  assertPathExists(SOURCE_SKILLS_DIR, "Built-in skill assets");

  const rootManifest = await readJson(ROOT_PACKAGE_JSON_PATH);
  const backendManifest = await readJson(BACKEND_PACKAGE_JSON_PATH);

  await rm(BACKEND_PUBLIC_DIR, { recursive: true, force: true });
  await rm(BACKEND_ASSETS_DIR, { recursive: true, force: true });
  await cp(uiPublicDir, BACKEND_PUBLIC_DIR, { recursive: true });
  await cp(SOURCE_ARCHETYPES_DIR, resolve(BACKEND_ASSETS_DIR, "archetypes"), { recursive: true });
  await cp(SOURCE_SKILLS_DIR, resolve(BACKEND_ASSETS_DIR, "skills"), { recursive: true });

  await rm(NPM_DIST_DIR, { recursive: true, force: true });
  await mkdir(NPM_DIST_DIR, { recursive: true });

  await cp(CLI_DIST_DIR, resolve(NPM_DIST_DIR, "dist", "cli"), { recursive: true });
  await cp(BACKEND_PUBLIC_DIR, resolve(NPM_DIST_DIR, "ui"), { recursive: true });
  await cp(BACKEND_ASSETS_DIR, resolve(NPM_DIST_DIR, "assets"), { recursive: true });
  await cp(BACKEND_DIST_DIR, resolve(NPM_DIST_DIR, "dist", "backend"), {
    recursive: true,
    filter: (source) => {
      const relativePath = relative(BACKEND_DIST_DIR, source);
      if (!relativePath || relativePath === ".") {
        return true;
      }

      const topLevelSegment = relativePath.split(sep)[0];
      return topLevelSegment !== "public" && topLevelSegment !== "assets";
    }
  });

  await mkdir(resolve(NPM_DIST_DIR, "bin"), { recursive: true });
  await cp(CLI_BIN_PATH, resolve(NPM_DIST_DIR, "bin", "middleman.js"));
  await chmod(resolve(NPM_DIST_DIR, "bin", "middleman.js"), 0o755);

  await cp(resolve(REPO_ROOT, "LICENSE"), resolve(NPM_DIST_DIR, "LICENSE"));
  await cp(
    existsSync(PACKAGE_README_PATH) ? PACKAGE_README_PATH : resolve(REPO_ROOT, "README.md"),
    resolve(NPM_DIST_DIR, "README.md")
  );

  const runtimeDependencies = { ...(backendManifest.dependencies ?? {}) };
  delete runtimeDependencies["@middleman/protocol"];

  const publishManifest = {
    name: "middleman-app",
    version: rootManifest.version,
    description: rootManifest.description ?? "Local-first multi-agent orchestration platform.",
    license: rootManifest.license ?? "Apache-2.0",
    type: "module",
    main: "./dist/cli/index.js",
    bin: {
      middleman: "./bin/middleman.js"
    },
    files: ["bin", "dist", "ui", "assets", "README.md", "LICENSE"],
    engines: {
      node: ">=22"
    },
    dependencies: runtimeDependencies
  };

  await writeFile(resolve(NPM_DIST_DIR, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`, "utf8");

  process.stdout.write(`Staged npm package at ${NPM_DIST_DIR}\n`);
}

function resolveExistingPath(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function assertPathExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found at ${path}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
