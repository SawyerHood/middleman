#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GoogleGenAI } from "@google/genai";
import mime from "mime";

const MODEL = "gemini-3-pro-image-preview";
const DEFAULT_IMAGE_SIZE = "1K";
const REQUIRED_MODALITIES = ["IMAGE", "TEXT"];
const SUPPORTED_FLAGS = new Set(["prompt", "output", "aspect-ratio", "size", "input-image"]);

function printJson(payload) {
  console.log(`${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeFlagValue(rawValue, flagName) {
  if (typeof rawValue !== "string") {
    throw new Error(`Missing value for ${flagName}`);
  }

  const value = rawValue.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return value;
}

function assignSingleFlag(existingValue, rawValue, flagName) {
  if (existingValue !== undefined) {
    throw new Error(`${flagName} can only be provided once`);
  }

  return normalizeFlagValue(rawValue, flagName);
}

export function parseArgs(argv) {
  const parsed = {
    prompt: undefined,
    output: undefined,
    aspectRatio: undefined,
    size: undefined,
    inputImages: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (!SUPPORTED_FLAGS.has(key)) {
      throw new Error(`Unknown flag: --${key}`);
    }

    const value = argv[index + 1];

    switch (key) {
      case "prompt":
        parsed.prompt = assignSingleFlag(parsed.prompt, value, "--prompt");
        break;
      case "output":
        parsed.output = assignSingleFlag(parsed.output, value, "--output");
        break;
      case "aspect-ratio":
        parsed.aspectRatio = assignSingleFlag(parsed.aspectRatio, value, "--aspect-ratio");
        break;
      case "size":
        parsed.size = assignSingleFlag(parsed.size, value, "--size");
        break;
      case "input-image":
        parsed.inputImages.push(normalizeFlagValue(value, "--input-image"));
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }

    index += 1;
  }

  if (!parsed.prompt) {
    throw new Error("Missing required flag --prompt");
  }

  if (!parsed.output) {
    throw new Error("Missing required flag --output");
  }

  return {
    prompt: parsed.prompt,
    output: parsed.output,
    aspectRatio: parsed.aspectRatio,
    size: parsed.size ?? DEFAULT_IMAGE_SIZE,
    inputImages: parsed.inputImages,
  };
}

function resolveOutputPath(rawPath, mimeType) {
  const absoluteOutputPath = resolve(rawPath);
  if (extname(absoluteOutputPath).length > 0) {
    return absoluteOutputPath;
  }

  const extension = mime.getExtension(mimeType);
  if (!extension) {
    return absoluteOutputPath;
  }

  return `${absoluteOutputPath}.${extension}`;
}

export async function resolveInputImagePart(rawPath) {
  const absolutePath = resolve(rawPath);
  const mimeType = mime.getType(absolutePath);
  if (!mimeType || !mimeType.startsWith("image/")) {
    throw new Error(`Input image must have an image/* MIME type: ${absolutePath}`);
  }

  const fileBuffer = await readFile(absolutePath);
  if (fileBuffer.length === 0) {
    throw new Error(`Input image is empty: ${absolutePath}`);
  }

  return {
    inlineData: {
      mimeType,
      data: fileBuffer.toString("base64"),
    },
  };
}

export async function buildUserParts(prompt, inputImages = []) {
  const imageParts = await Promise.all(inputImages.map((path) => resolveInputImagePart(path)));
  return [{ text: prompt }, ...imageParts];
}

export async function buildGenerateContentRequest(options) {
  const imageConfig = {
    imageSize: options.size ?? DEFAULT_IMAGE_SIZE,
  };

  if (options.aspectRatio) {
    imageConfig.aspectRatio = options.aspectRatio;
  }

  return {
    model: MODEL,
    config: {
      imageConfig,
      responseModalities: REQUIRED_MODALITIES,
    },
    contents: [
      {
        role: "user",
        parts: await buildUserParts(options.prompt, options.inputImages ?? []),
      },
    ],
  };
}

function extractInlineData(part) {
  if (!part || typeof part !== "object") {
    return undefined;
  }

  const inlineData = part.inlineData;
  if (!inlineData || typeof inlineData !== "object") {
    return undefined;
  }

  const data = typeof inlineData.data === "string" ? inlineData.data.trim() : "";
  if (!data) {
    return undefined;
  }

  const mimeType =
    typeof inlineData.mimeType === "string" && inlineData.mimeType.trim().length > 0
      ? inlineData.mimeType.trim()
      : "image/png";

  return { data, mimeType };
}

async function findFirstImageInlineData(stream) {
  for await (const chunk of stream) {
    const candidates = Array.isArray(chunk?.candidates) ? chunk.candidates : [];
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      for (const part of parts) {
        const inlineData = extractInlineData(part);
        if (inlineData) {
          return inlineData;
        }
      }
    }
  }

  return undefined;
}

async function main() {
  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required.");
    }

    const options = parseArgs(process.argv.slice(2));
    const ai = new GoogleGenAI({ apiKey });

    const stream = await ai.models.generateContentStream(await buildGenerateContentRequest(options));

    const imageInlineData = await findFirstImageInlineData(stream);
    if (!imageInlineData) {
      throw new Error("No image data found in Gemini response.");
    }

    const outputPath = resolveOutputPath(options.output, imageInlineData.mimeType);
    const imageBuffer = Buffer.from(imageInlineData.data, "base64");

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, imageBuffer);

    printJson({
      ok: true,
      file: outputPath,
      mimeType: imageInlineData.mimeType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson({
      ok: false,
      error: message,
    });
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
