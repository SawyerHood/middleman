export interface ParsedImageGenerationArgs {
  prompt: string;
  output: string;
  aspectRatio?: string;
  size: string;
  inputImages: string[];
}

export interface InlineImagePart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface ImageGenerationRequest {
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
    parts: Array<{ text: string } | InlineImagePart>;
  }>;
}

export function parseArgs(argv: string[]): ParsedImageGenerationArgs;
export function resolveInputImagePart(rawPath: string): Promise<InlineImagePart>;
export function buildUserParts(
  prompt: string,
  inputImages?: string[],
): Promise<Array<{ text: string } | InlineImagePart>>;
export function buildGenerateContentRequest(options: {
  prompt: string;
  aspectRatio?: string;
  size?: string;
  inputImages?: string[];
}): Promise<ImageGenerationRequest>;
