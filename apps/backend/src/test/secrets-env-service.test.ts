import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretsEnvService } from "../swarm/secrets-env-service.js";
import type { MiddlemanSettingsRepo } from "../swarm/swarm-sql.js";
import type { SwarmConfig } from "../swarm/types.js";

describe("SecretsEnvService", () => {
  it("reads and writes auth credentials directly from auth.json", async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "middleman-secrets-env-"));
    const authFile = resolve(dataDir, "auth", "auth.json");

    await mkdir(resolve(dataDir, "auth"), { recursive: true });
    await writeFile(
      authFile,
      `${JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "token-access",
          refresh: "token-refresh",
          expires: Date.parse("2099-01-01T00:00:00.000Z"),
          accountId: "acct_123",
        },
      })}\n`,
      "utf8",
    );

    const settingsRepo = {
      listEnv: () => ({}),
    } as Pick<MiddlemanSettingsRepo, "listEnv"> as MiddlemanSettingsRepo;

    const service = new SecretsEnvService({
      config: {
        paths: {
          authFile,
        },
      } as SwarmConfig,
      settingsRepo,
      ensureSkillMetadataLoaded: async () => {},
      getSkillMetadata: () => [],
    });

    try {
      await service.loadSecretsStore();

      expect(await service.listSettingsAuth()).toEqual([
        expect.objectContaining({
          provider: "anthropic",
          configured: false,
        }),
        expect.objectContaining({
          provider: "openai-codex",
          configured: true,
          authType: "oauth",
        }),
      ]);
      expect(service.hasSettingsAuth("anthropic")).toBe(false);
      expect(service.hasSettingsAuth("openai-codex")).toBe(true);

      await service.updateSettingsAuth({
        anthropic: "anthropic-api-key",
      });

      const updatedAuth = JSON.parse(await readFile(authFile, "utf8")) as Record<string, unknown>;
      expect(updatedAuth).toMatchObject({
        anthropic: {
          type: "api_key",
          key: "anthropic-api-key",
        },
        "openai-codex": {
          type: "oauth",
          access: "token-access",
          refresh: "token-refresh",
        },
      });
      expect(service.hasSettingsAuth("anthropic")).toBe(true);

      await service.deleteSettingsAuth("openai-codex");

      const finalAuth = JSON.parse(await readFile(authFile, "utf8")) as Record<string, unknown>;
      expect(finalAuth).toMatchObject({
        anthropic: {
          type: "api_key",
          key: "anthropic-api-key",
        },
      });
      expect(finalAuth["openai-codex"]).toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
