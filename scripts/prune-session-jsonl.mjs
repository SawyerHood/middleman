#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const homeDir = os.homedir();
const defaultSessionsDir = path.join(homeDir, ".middleman", "sessions");
const timestamp = new Date().toISOString().replaceAll(":", "-");
const defaultBackupDir = path.join(homeDir, ".middleman", "session-prune-backups", timestamp);

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const targetFiles = await resolveTargetFiles(options);
if (targetFiles.length === 0) {
  console.log("No session files found.");
  process.exit(0);
}

const summaries = [];
for (const file of targetFiles) {
  summaries.push(await analyzeFile(file));
}

printSummary(summaries, options.apply ? "Planned+Applied" : "Dry run");

if (!options.apply) {
  process.exit(0);
}

if (!options.unsafeTreeRewrite) {
  throw new Error(
    "Refusing to rewrite session files without --unsafe-tree-rewrite. Pi session JSONL files are tree-structured via parentId, and deleting intermediate entries can orphan later messages.",
  );
}

await fsp.mkdir(options.backupDir, { recursive: true });

const appliedSummaries = [];
for (const summary of summaries) {
  if (summary.prunedLines === 0) {
    appliedSummaries.push(summary);
    continue;
  }

  const backupPath = path.join(options.backupDir, path.basename(summary.file));
  await fsp.copyFile(summary.file, backupPath);
  await rewriteFile(summary.file);
  const nextStats = await fsp.stat(summary.file);

  appliedSummaries.push({
    ...summary,
    backupPath,
    resultingBytes: nextStats.size,
  });
}

const manifestPath = path.join(options.backupDir, "manifest.json");
await fsp.writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      backupDir: options.backupDir,
      files: appliedSummaries.filter((summary) => summary.prunedLines > 0),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

printAppliedSummary(appliedSummaries, options.backupDir, manifestPath);

async function resolveTargetFiles(options) {
  if (options.files.length > 0) {
    const resolvedFiles = [];
    for (const file of options.files) {
      const resolved = path.resolve(file);
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${resolved}`);
      }
      if (isConversationCacheFile(resolved)) {
        continue;
      }
      resolvedFiles.push(resolved);
    }
    return resolvedFiles.sort();
  }

  const entries = await fsp.readdir(options.dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const resolved = path.join(options.dir, entry.name);
    if (!entry.name.endsWith(".jsonl") || isConversationCacheFile(resolved)) {
      continue;
    }

    files.push(resolved);
  }

  const stats = await Promise.all(
    files.map(async (file) => ({
      file,
      size: (await fsp.stat(file)).size,
    })),
  );

  return stats.sort((left, right) => right.size - left.size).map((entry) => entry.file);
}

async function analyzeFile(file) {
  const stats = await fsp.stat(file);
  const summary = {
    file,
    totalBytes: stats.size,
    totalLines: 0,
    keptLines: 0,
    prunedLines: 0,
    keptBytes: 0,
    prunedBytes: 0,
    pruneBreakdown: new Map(),
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const lineWithNewline = `${line}\n`;
    const lineBytes = Buffer.byteLength(lineWithNewline, "utf8");
    summary.totalLines += 1;

    const action = classifyLine(line);
    if (action.keep) {
      summary.keptLines += 1;
      summary.keptBytes += lineBytes;
      continue;
    }

    summary.prunedLines += 1;
    summary.prunedBytes += lineBytes;
    summary.pruneBreakdown.set(action.reason, (summary.pruneBreakdown.get(action.reason) ?? 0) + 1);
  }

  return {
    ...summary,
    pruneBreakdown: Object.fromEntries(
      [...summary.pruneBreakdown.entries()].sort((left, right) => right[1] - left[1]),
    ),
  };
}

function classifyLine(line) {
  if (line.trim().length === 0) {
    return { keep: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { keep: true };
  }

  if (parsed?.type !== "custom" || parsed?.customType !== "swarm_conversation_entry") {
    return { keep: true };
  }

  const data = parsed.data;
  if (!data || typeof data !== "object") {
    return { keep: true };
  }

  if (data.type === "conversation_message") {
    if (data.source === "user_input" || data.source === "speak_to_user") {
      return { keep: true };
    }

    return { keep: false, reason: `conversation_message:${String(data.source ?? "unknown")}` };
  }

  if (data.type === "agent_tool_call") {
    return { keep: false, reason: `agent_tool_call:${String(data.kind ?? "unknown")}` };
  }

  if (data.type === "agent_message") {
    return { keep: false, reason: `agent_message:${String(data.source ?? "unknown")}` };
  }

  if (data.type === "conversation_log") {
    return { keep: false, reason: `conversation_log:${String(data.kind ?? "unknown")}` };
  }

  return { keep: true };
}

async function rewriteFile(file) {
  const tempFile = `${file}.prune-${process.pid}-${Date.now()}.tmp`;
  const output = fs.createWriteStream(tempFile, { encoding: "utf8" });
  const input = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of input) {
      const action = classifyLine(line);
      if (!action.keep) {
        continue;
      }

      if (!output.write(`${line}\n`)) {
        await once(output, "drain");
      }
    }
  } finally {
    input.close();
    await closeWriteStream(output);
  }

  await fsp.rename(tempFile, file);
}

function printSummary(summaries, label) {
  const changed = summaries.filter((summary) => summary.prunedLines > 0);
  const totalBytes = summaries.reduce((sum, summary) => sum + summary.totalBytes, 0);
  const totalPrunedBytes = changed.reduce((sum, summary) => sum + summary.prunedBytes, 0);
  const totalPrunedLines = changed.reduce((sum, summary) => sum + summary.prunedLines, 0);

  console.log(`${label} session prune summary`);
  console.log(`Scanned files: ${summaries.length}`);
  console.log(`Files with removable entries: ${changed.length}`);
  console.log(`Bytes scanned: ${formatBytes(totalBytes)}`);
  console.log(`Bytes removable: ${formatBytes(totalPrunedBytes)} (${percent(totalPrunedBytes, totalBytes)})`);
  console.log(`Lines removable: ${formatNumber(totalPrunedLines)}`);

  for (const summary of changed.slice(0, 20)) {
    console.log("");
    console.log(summary.file);
    console.log(`  removable: ${formatBytes(summary.prunedBytes)} across ${formatNumber(summary.prunedLines)} lines`);
    console.log(`  would keep: ${formatBytes(summary.keptBytes)} across ${formatNumber(summary.keptLines)} lines`);
    for (const [reason, count] of Object.entries(summary.pruneBreakdown).slice(0, 6)) {
      console.log(`  ${reason}: ${formatNumber(count)}`);
    }
  }
}

function printAppliedSummary(summaries, backupDir, manifestPath) {
  const changed = summaries.filter((summary) => summary.prunedLines > 0);
  const totalOriginalBytes = changed.reduce((sum, summary) => sum + summary.totalBytes, 0);
  const totalResultingBytes = changed.reduce((sum, summary) => sum + (summary.resultingBytes ?? summary.totalBytes), 0);

  console.log("");
  console.log("Applied session prune");
  console.log(`Backups: ${backupDir}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Files rewritten: ${changed.length}`);
  console.log(`Space reclaimed: ${formatBytes(totalOriginalBytes - totalResultingBytes)}`);
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
}

function isConversationCacheFile(file) {
  return file.endsWith(".conversation.jsonl");
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function percent(part, whole) {
  if (whole <= 0) {
    return "0.0%";
  }

  return `${((part / whole) * 100).toFixed(1)}%`;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    help: false,
    unsafeTreeRewrite: false,
    dir: defaultSessionsDir,
    backupDir: defaultBackupDir,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--unsafe-tree-rewrite") {
      options.unsafeTreeRewrite = true;
      continue;
    }

    if (arg === "--dir") {
      index += 1;
      options.dir = path.resolve(expectValue(argv[index], "--dir"));
      continue;
    }

    if (arg === "--backup-dir") {
      index += 1;
      options.backupDir = path.resolve(expectValue(argv[index], "--backup-dir"));
      continue;
    }

    if (arg === "--file") {
      index += 1;
      options.files.push(path.resolve(expectValue(argv[index], "--file")));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function expectValue(value, flagName) {
  if (!value) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/prune-session-jsonl.mjs [options]

Options:
  --apply                 Rewrite files in place after creating backups.
  --unsafe-tree-rewrite   Required with --apply. Acknowledges that tree-based Pi session files
                          can be corrupted by deleting intermediate entries.
  --dir <path>            Session directory to scan. Defaults to ${defaultSessionsDir}
  --file <path>           Specific session file to scan. Can be passed multiple times.
  --backup-dir <path>     Backup directory used with --apply.
  --help, -h              Show this help text.

Behavior:
  Removes only stale swarm_conversation_entry mirror records that are no longer needed in
  session files: agent tool activity, internal agent messages, conversation logs, and
  non-user-visible conversation messages. It preserves session headers, real message entries,
  runtime state custom entries, user_input transcript entries, speak_to_user transcript entries,
  and other user-visible transcript entries.

Warning:
  Pi session files are append-only trees. Deleting intermediate nodes can break parentId chains
  and orphan later entries. Use dry-run output for analysis unless you are intentionally doing an
  unsafe tree rewrite and have a tested restore path.
`);
}
