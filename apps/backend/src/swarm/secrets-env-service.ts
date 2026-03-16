import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import type { MiddlemanSettingsRepo } from "./swarm-sql.js";
import { normalizeEnvVarName, type ParsedSkillEnvDeclaration } from "./skill-frontmatter.js";
import type {
  SettingsAuthProvider,
  SettingsAuthProviderName,
  SkillEnvRequirement,
  SwarmConfig
} from "./types.js";

const SETTINGS_ENV_MASK = "********";
const SETTINGS_AUTH_MASK = "********";

const SETTINGS_AUTH_PROVIDER_DEFINITIONS: Array<{
  provider: SettingsAuthProviderName;
  storageProvider: string;
}> = [
  {
    provider: "anthropic",
    storageProvider: "anthropic"
  },
  {
    provider: "openai-codex",
    storageProvider: "openai-codex"
  }
];

interface SkillMetadataForSettings {
  skillName: string;
  env: ParsedSkillEnvDeclaration[];
}

interface SecretsEnvServiceDependencies {
  config: SwarmConfig;
  settingsRepo: MiddlemanSettingsRepo;
  ensureSkillMetadataLoaded: () => Promise<void>;
  getSkillMetadata: () => SkillMetadataForSettings[];
}

export class SecretsEnvService {
  private readonly originalProcessEnvByName = new Map<string, string | undefined>();
  private secrets: Record<string, string> = {};

  constructor(private readonly deps: SecretsEnvServiceDependencies) {}

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    await this.deps.ensureSkillMetadataLoaded();
    const skillMetadata = this.deps.getSkillMetadata();

    const requirements: SkillEnvRequirement[] = [];

    for (const skill of skillMetadata) {
      for (const declaration of skill.env) {
        const resolvedValue = this.resolveEnvValue(declaration.name);
        requirements.push({
          name: declaration.name,
          description: declaration.description,
          required: declaration.required,
          helpUrl: declaration.helpUrl,
          skillName: skill.skillName,
          isSet: typeof resolvedValue === "string" && resolvedValue.trim().length > 0,
          maskedValue: resolvedValue ? SETTINGS_ENV_MASK : undefined
        });
      }
    }

    if (!requirements.some((requirement) => requirement.name === "CODEX_API_KEY")) {
      const codexApiKey = this.resolveEnvValue("CODEX_API_KEY");
      requirements.push({
        name: "CODEX_API_KEY",
        description: "API key used by the codex-app runtime when no existing Codex login session is available.",
        required: false,
        helpUrl: "https://platform.openai.com/api-keys",
        skillName: "codex-app-runtime",
        isSet: typeof codexApiKey === "string" && codexApiKey.trim().length > 0,
        maskedValue: codexApiKey ? SETTINGS_ENV_MASK : undefined
      });
    }

    requirements.sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) return byName;
      return left.skillName.localeCompare(right.skillName);
    });

    return requirements;
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    for (const [rawName, rawValue] of entries) {
      const normalizedName = normalizeEnvVarName(rawName);
      if (!normalizedName) {
        throw new Error(`Invalid environment variable name: ${rawName}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Environment variable ${normalizedName} must be a non-empty string`);
      }

      this.secrets[normalizedName] = normalizedValue;
      this.deps.settingsRepo.set("env", normalizedName, normalizedValue);
      this.applySecretToProcessEnv(normalizedName, normalizedValue);
    }
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    const normalizedName = normalizeEnvVarName(name);
    if (!normalizedName) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }

    if (!(normalizedName in this.secrets)) {
      return;
    }

    delete this.secrets[normalizedName];
    this.deps.settingsRepo.delete("env", normalizedName);
    this.restoreProcessEnvForSecret(normalizedName);
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);

    return SETTINGS_AUTH_PROVIDER_DEFINITIONS.map((definition) => {
      const credential = authStorage.get(definition.storageProvider);
      const resolvedToken = extractAuthCredentialToken(credential);

      return {
        provider: definition.provider,
        configured: typeof resolvedToken === "string" && resolvedToken.length > 0,
        authType: resolveAuthCredentialType(credential),
        maskedValue: resolvedToken ? maskSettingsAuthValue(resolvedToken) : undefined
      } satisfies SettingsAuthProvider;
    });
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);

    for (const [rawProvider, rawValue] of entries) {
      const resolvedProvider = resolveSettingsAuthProvider(rawProvider);
      if (!resolvedProvider) {
        throw new Error(`Invalid auth provider: ${rawProvider}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Auth value for ${resolvedProvider.provider} must be a non-empty string`);
      }

      const credential = {
        type: "api_key",
        key: normalizedValue,
        access: normalizedValue,
        refresh: "",
        expires: ""
      };

      authStorage.set(resolvedProvider.storageProvider, credential as unknown as AuthCredential);
    }
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    const resolvedProvider = resolveSettingsAuthProvider(provider);
    if (!resolvedProvider) {
      throw new Error(`Invalid auth provider: ${provider}`);
    }

    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);
    authStorage.remove(resolvedProvider.storageProvider);
  }

  async loadSecretsStore(): Promise<void> {
    this.secrets = this.deps.settingsRepo.listEnv();

    for (const [name, value] of Object.entries(this.secrets)) {
      this.applySecretToProcessEnv(name, value);
    }
  }

  hasSettingsAuth(provider: SettingsAuthProviderName): boolean {
    const resolvedProvider = SETTINGS_AUTH_PROVIDER_DEFINITIONS.find(
      (definition) => definition.provider === provider,
    );
    if (!resolvedProvider) {
      return false;
    }

    const authStorage = AuthStorage.create(this.deps.config.paths.authFile);
    return Boolean(extractAuthCredentialToken(authStorage.get(resolvedProvider.storageProvider)));
  }

  private resolveEnvValue(name: string): string | undefined {
    const secretValue = this.secrets[name];
    if (typeof secretValue === "string" && secretValue.trim().length > 0) {
      return secretValue;
    }

    const processValue = process.env[name];
    if (typeof processValue !== "string" || processValue.trim().length === 0) {
      return undefined;
    }

    return processValue;
  }

  private applySecretToProcessEnv(name: string, value: string): void {
    if (!this.originalProcessEnvByName.has(name)) {
      this.originalProcessEnvByName.set(name, process.env[name]);
    }

    process.env[name] = value;
  }

  private restoreProcessEnvForSecret(name: string): void {
    const original = this.originalProcessEnvByName.get(name);

    if (original === undefined) {
      delete process.env[name];
      return;
    }

    process.env[name] = original;
  }
}

function resolveSettingsAuthProvider(
  provider: string
): { provider: SettingsAuthProviderName; storageProvider: string } | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }

  const definition = SETTINGS_AUTH_PROVIDER_DEFINITIONS.find(
    (entry) => entry.provider === normalizedProvider
  );
  if (!definition) {
    return undefined;
  }

  return {
    provider: definition.provider,
    storageProvider: definition.storageProvider
  };
}

function resolveAuthCredentialType(
  credential: AuthCredential | undefined
): SettingsAuthProvider["authType"] | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.type === "api_key" || credential.type === "oauth") {
    return credential.type;
  }

  return "unknown";
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") {
    return undefined;
  }

  if (credential.type === "api_key") {
    const apiKey = normalizeAuthToken((credential as { key?: unknown }).key);
    if (apiKey) {
      return apiKey;
    }
  }

  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access);
  if (accessToken) {
    return accessToken;
  }

  return undefined;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function maskSettingsAuthValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return SETTINGS_AUTH_MASK;
  }

  const suffix = trimmed.slice(-4);
  if (!suffix) {
    return SETTINGS_AUTH_MASK;
  }

  return `${SETTINGS_AUTH_MASK}${suffix}`;
}
