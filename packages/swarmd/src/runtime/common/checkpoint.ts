import type { BackendCheckpoint, BackendKind } from "../../core/types/index.js";

export function validateCheckpoint(
  checkpoint: BackendCheckpoint,
  expectedBackend: BackendKind,
): void {
  if (checkpoint.backend !== expectedBackend) {
    throw new Error(
      `Checkpoint backend mismatch: expected ${expectedBackend}, got ${checkpoint.backend}`,
    );
  }
}

export function isCodexCheckpoint(
  cp: BackendCheckpoint,
): cp is Extract<BackendCheckpoint, { backend: "codex" }> {
  return cp.backend === "codex";
}

export function isClaudeCheckpoint(
  cp: BackendCheckpoint,
): cp is Extract<BackendCheckpoint, { backend: "claude" }> {
  return cp.backend === "claude";
}

export function isPiCheckpoint(cp: BackendCheckpoint): cp is Extract<BackendCheckpoint, { backend: "pi" }> {
  return cp.backend === "pi";
}

export function createInitialCodexCheckpoint(threadId: string): BackendCheckpoint {
  return { backend: "codex", threadId };
}

export function createInitialClaudeCheckpoint(sessionId: string): BackendCheckpoint {
  return { backend: "claude", sessionId };
}

export function createInitialPiCheckpoint(sessionFile: string): BackendCheckpoint {
  return { backend: "pi", sessionFile };
}
