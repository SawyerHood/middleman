import { parseArtifactReference, type ArtifactReference } from "./artifacts";
import type { ConversationEntry } from "@middleman/protocol";

const ARTIFACT_SHORTCODE_PATTERN = /\[artifact:([^\]\n]+)\]/gi;
const SWARM_FILE_PATTERN = /swarm-file:\/\/[^\s)>\]"']+/gi;
const VSCODE_FILE_PATTERN = /vscode(?:-insiders)?:\/\/file\/[^\s)>\]"']+/gi;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)]+)\)/g;

/**
 * Collect all unique artifact references from a list of conversation entries.
 * Deduplicates by normalized file path and returns last-seen items first.
 */
export function collectArtifactsFromMessages(messages: ConversationEntry[]): ArtifactReference[] {
  const seen = new Map<string, ArtifactReference>();

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.type !== "conversation_message") continue;
    if (message.role === "user") continue;

    const text = message.text;
    if (!text) continue;

    // Extract from [artifact:path] shortcodes
    for (const match of text.matchAll(ARTIFACT_SHORTCODE_PATTERN)) {
      const rawPath = match[1]?.trim();
      if (!rawPath) continue;
      const ref = parseArtifactReference(`swarm-file://${encodeURI(rawPath)}`);
      if (ref && !seen.has(ref.path)) {
        seen.set(ref.path, ref);
      }
    }

    // Extract swarm-file:// links
    for (const match of text.matchAll(SWARM_FILE_PATTERN)) {
      const ref = parseArtifactReference(match[0]);
      if (ref && !seen.has(ref.path)) {
        seen.set(ref.path, ref);
      }
    }

    // Extract vscode:// / vscode-insiders:// links
    for (const match of text.matchAll(VSCODE_FILE_PATTERN)) {
      const ref = parseArtifactReference(match[0]);
      if (ref && !seen.has(ref.path)) {
        seen.set(ref.path, ref);
      }
    }

    // Extract from markdown links [text](href)
    for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
      const matchIndex = match.index ?? 0;
      if (matchIndex > 0 && text[matchIndex - 1] === "!") {
        continue;
      }

      const linkText = match[1]?.trim();
      const href = parseMarkdownLinkHref(match[2] ?? "");
      if (!href) continue;
      const ref = parseArtifactReference(href, { title: linkText });
      if (ref && !seen.has(ref.path)) {
        seen.set(ref.path, ref);
      }
    }
  }

  return Array.from(seen.values());
}

/** Categorize an artifact by its file extension. */
export type ArtifactCategory = "document" | "code" | "image" | "data" | "other";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);
const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt", "pdf", "doc", "docx", "rtf"]);
const DATA_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "csv", "xml", "env"]);
const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "h",
  "css",
  "scss",
  "less",
  "html",
  "vue",
  "svelte",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "gql",
  "Dockerfile",
  "Makefile",
]);

export function categorizeArtifact(fileName: string): ArtifactCategory {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return "other";
}

function parseMarkdownLinkHref(rawHref: string): string {
  const trimmedHref = rawHref.trim();
  if (!trimmedHref) {
    return "";
  }

  if (trimmedHref.startsWith("<") && trimmedHref.endsWith(">")) {
    return trimmedHref.slice(1, -1).trim();
  }

  const titleSeparatorIndex = trimmedHref.search(/\s+(?:"|')/);
  if (titleSeparatorIndex > 0) {
    return trimmedHref.slice(0, titleSeparatorIndex).trim();
  }

  return trimmedHref;
}
