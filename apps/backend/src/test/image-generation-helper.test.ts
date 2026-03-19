import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type ImageGenerationHelperModule = {
  parseArgs: (argv: string[]) => {
    prompt: string;
    output: string;
    aspectRatio?: string;
    size: string;
    inputImages: string[];
  };
  buildGenerateContentRequest: (options: {
    prompt: string;
    aspectRatio?: string;
    size?: string;
    inputImages?: string[];
  }) => Promise<{
    model: string;
    config: {
      imageConfig: {
        imageSize: string;
        aspectRatio?: string;
      };
      responseModalities: string[];
    };
    contents: Array<{
      role: string;
      parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
    }>;
  }>;
};

let helper: ImageGenerationHelperModule;
const tempDirs: string[] = [];

beforeAll(async () => {
  helper =
    (await import("../swarm/skills/builtins/image-generation/generate.js")) as ImageGenerationHelperModule;
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

describe("image-generation helper", () => {
  it("parses repeated --input-image flags in order", () => {
    expect(
      helper.parseArgs([
        "--prompt",
        "stylize this",
        "--input-image",
        "./sketch.png",
        "--output",
        "./out",
        "--input-image",
        "./reference.jpg",
      ]),
    ).toEqual({
      prompt: "stylize this",
      output: "./out",
      aspectRatio: undefined,
      size: "1K",
      inputImages: ["./sketch.png", "./reference.jpg"],
    });
  });

  it("builds Gemini requests with text and inline image parts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "middleman-image-helper-"));
    tempDirs.push(tempDir);

    const sketchPath = join(tempDir, "sketch.png");
    const referencePath = join(tempDir, "reference.jpg");
    await writeFile(sketchPath, Buffer.from("sketch-bytes"));
    await writeFile(referencePath, Buffer.from("reference-bytes"));

    const request = await helper.buildGenerateContentRequest({
      prompt: "turn this into a poster",
      aspectRatio: "4:3",
      size: "2K",
      inputImages: [sketchPath, referencePath],
    });

    expect(request).toEqual({
      model: "gemini-3-pro-image-preview",
      config: {
        imageConfig: {
          imageSize: "2K",
          aspectRatio: "4:3",
        },
        responseModalities: ["IMAGE", "TEXT"],
      },
      contents: [
        {
          role: "user",
          parts: [
            { text: "turn this into a poster" },
            {
              inlineData: {
                mimeType: "image/png",
                data: Buffer.from("sketch-bytes").toString("base64"),
              },
            },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: Buffer.from("reference-bytes").toString("base64"),
              },
            },
          ],
        },
      ],
    });
  });
});
