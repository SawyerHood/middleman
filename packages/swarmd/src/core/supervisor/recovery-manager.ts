import type { SessionService } from "../services/session-service.js";
import type { SessionStatus } from "../types/index.js";
import type { SessionRepo } from "../store/index.js";

export interface RecoveryManagerDeps {
  sessionRepo: SessionRepo;
  sessionService: SessionService;
}

export interface RecoveryResult {
  attempted: number;
  recovered: number;
  failed: number;
  results: RecoverySessionResult[];
}

export interface RecoverySessionResult {
  sessionId: string;
  status: "recovered" | "failed";
  error?: string;
}

const RECOVERABLE_STATUSES: SessionStatus[] = ["starting", "idle", "busy", "interrupting"];

export class RecoveryManager {
  constructor(private deps: RecoveryManagerDeps) {}

  async recover(): Promise<RecoveryResult> {
    const results: RecoverySessionResult[] = [];
    const toRecover = this.deps.sessionRepo.list({ status: RECOVERABLE_STATUSES });

    for (const session of toRecover) {
      try {
        this.deps.sessionRepo.updateStatus(session.id, "stopped", null, session.contextUsage);
        await this.deps.sessionService.start(session.id);
        results.push({ sessionId: session.id, status: "recovered" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.sessionRepo.updateStatus(
          session.id,
          "errored",
          {
            code: "RECOVERY_FAILED",
            message,
            retryable: true,
          },
          session.contextUsage,
        );
        results.push({ sessionId: session.id, status: "failed", error: message });
      }
    }

    return {
      attempted: toRecover.length,
      recovered: results.filter((result) => result.status === "recovered").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
    };
  }
}
