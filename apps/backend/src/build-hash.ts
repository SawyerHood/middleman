import { execSync } from "node:child_process";

function resolveBuildHash(): string {
  const envBuildHash =
    process.env.MIDDLEMAN_BUILD_HASH?.trim() ||
    process.env.VITE_BUILD_HASH?.trim();
  if (envBuildHash) {
    return envBuildHash;
  }

  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

export const BUILD_HASH = resolveBuildHash();
