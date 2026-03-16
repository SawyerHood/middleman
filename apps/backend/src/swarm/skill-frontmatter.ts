const SKILL_FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const VALID_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedSkillEnvDeclaration {
  name: string;
  description?: string;
  required: boolean;
  helpUrl?: string;
}

export function parseSkillFrontmatter(markdown: string): {
  name?: string;
  description?: string;
  env: ParsedSkillEnvDeclaration[];
} {
  const match = SKILL_FRONTMATTER_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return { env: [] };
  }

  const lines = match[1].split(/\r?\n/);
  let skillName: string | undefined;
  let skillDescription: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || countLeadingSpaces(line) > 0) {
      continue;
    }

    const parsed = parseYamlKeyValue(trimmed);
    if (!parsed) {
      continue;
    }

    if (parsed.key === "name") {
      const candidate = parseYamlStringValue(parsed.value);
      if (candidate) {
        skillName = candidate;
      }
      continue;
    }

    if (parsed.key === "description") {
      const candidate = parseYamlStringValue(parsed.value);
      if (candidate) {
        skillDescription = candidate;
      }
    }
  }

  return {
    name: skillName,
    description: skillDescription,
    env: parseSkillEnvDeclarations(lines)
  };
}

export function normalizeEnvVarName(name: string): string | undefined {
  const normalized = name.trim();
  if (!VALID_ENV_NAME_PATTERN.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function parseSkillEnvDeclarations(lines: string[]): ParsedSkillEnvDeclaration[] {
  const envIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === "env:" || trimmed === "envVars:";
  });
  if (envIndex < 0) {
    return [];
  }

  const envIndent = countLeadingSpaces(lines[envIndex]);
  const declarations: ParsedSkillEnvDeclaration[] = [];
  let current: Partial<ParsedSkillEnvDeclaration> | undefined;

  const flushCurrent = (): void => {
    if (!current) {
      return;
    }

    const normalizedName =
      typeof current.name === "string" ? normalizeEnvVarName(current.name) : undefined;
    if (!normalizedName) {
      current = undefined;
      return;
    }

    declarations.push({
      name: normalizedName,
      description:
        typeof current.description === "string" && current.description.trim().length > 0
          ? current.description.trim()
          : undefined,
      required: current.required === true,
      helpUrl:
        typeof current.helpUrl === "string" && current.helpUrl.trim().length > 0
          ? current.helpUrl.trim()
          : undefined
    });

    current = undefined;
  };

  for (let index = envIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const lineIndent = countLeadingSpaces(line);
    if (lineIndent <= envIndent) {
      break;
    }

    if (trimmed.startsWith("-")) {
      flushCurrent();
      current = {};

      const inline = trimmed.slice(1).trim();
      if (inline.length > 0) {
        const parsedInline = parseYamlKeyValue(inline);
        if (parsedInline) {
          assignSkillEnvField(current, parsedInline.key, parsedInline.value);
        }
      }

      continue;
    }

    if (!current) {
      continue;
    }

    const parsed = parseYamlKeyValue(trimmed);
    if (!parsed) {
      continue;
    }

    assignSkillEnvField(current, parsed.key, parsed.value);
  }

  flushCurrent();

  return declarations;
}

function assignSkillEnvField(target: Partial<ParsedSkillEnvDeclaration>, key: string, value: string): void {
  switch (key) {
    case "name":
      target.name = parseYamlStringValue(value);
      return;

    case "description":
      target.description = parseYamlStringValue(value);
      return;

    case "required": {
      const parsed = parseYamlBooleanValue(value);
      if (parsed !== undefined) {
        target.required = parsed;
      }
      return;
    }

    case "helpUrl":
      target.helpUrl = parseYamlStringValue(value);
      return;

    default:
      return;
  }
}

function parseYamlKeyValue(line: string): { key: string; value: string } | undefined {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = line.slice(0, separatorIndex).trim();
  if (!key) {
    return undefined;
  }

  return {
    key,
    value: line.slice(separatorIndex + 1).trim()
  };
}

function parseYamlStringValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function parseYamlBooleanValue(value: string): boolean | undefined {
  const normalized = parseYamlStringValue(value).toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "no" || normalized === "off" || normalized === "0") {
    return false;
  }

  return undefined;
}

function countLeadingSpaces(value: string): number {
  const match = /^\s*/.exec(value);
  return match ? match[0].length : 0;
}
