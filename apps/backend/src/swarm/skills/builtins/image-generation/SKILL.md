---
name: image-generation
description: Generate images using Google Gemini (gemini-3-pro-image-preview). Requires GEMINI_API_KEY.
envVars:
  - name: GEMINI_API_KEY
    description: Google AI Studio / Gemini API key
    required: true
---

# Image Generation

Generate images using Google Gemini (`gemini-3-pro-image-preview`) for both text-to-image and image-to-image workflows.

Use the packaged CLI:

```bash
middleman image generate \
  --prompt "a cute robot bee in a garden" \
  --output "/path/to/output.png"
```

Image-to-image generation is supported with repeated `--input-image` flags:

```bash
middleman image generate \
  --prompt "turn this sketch into a painted poster with a limited teal and coral palette" \
  --input-image "/path/to/sketch.png" \
  --input-image "/path/to/reference.jpg" \
  --output "/path/to/output.png"
```

## Options

- `--prompt` (required): text description of the image to generate
- `--output` (required): output file path (extension auto-detected when omitted)
- `--input-image` (optional, repeatable): local source image(s) to send alongside the prompt
- `--aspect-ratio` (optional): aspect ratio like `16:9`, `1:1`, `4:3`
- `--size` (optional): image size, default `1K`

## Output

The script prints JSON:

- Success: `{ "ok": true, "file": "/path/to/output.png", "mimeType": "image/png" }`
- Failure: `{ "ok": false, "error": "..." }`
