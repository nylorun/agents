export interface ImageEditRequest {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface ImageEditor {
  edit(
    request: ImageEditRequest,
  ): Promise<{ readonly bytes: Uint8Array; readonly mediaType: "image/png" }>;
}

export interface OpenAIImageEditorOptions {
  readonly apiKey: string;
  readonly model: string;
  /** The largest edited image kept. Default `DEFAULT_MAX_IMAGE_BYTES`. */
  readonly maxImageBytes?: number;
}

/** The editor's `maxImageBytes` when its options set none. */
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Minimal host-owned OpenAI Images edit client. Keys and provider payloads never enter Harness. */
export function createOpenAIImageEditor(
  options: OpenAIImageEditorOptions,
): ImageEditor {
  return Object.freeze({
    async edit(request: ImageEditRequest) {
      const body = new FormData();
      body.set("model", options.model);
      body.set("prompt", request.prompt);
      body.set("quality", "medium");
      body.set("output_format", "png");
      body.set("size", "1536x1024");
      body.set(
        "image",
        new Blob([request.bytes as Uint8Array<ArrayBuffer>], {
          type: request.mediaType,
        }),
        `space.${extension(request.mediaType)}`,
      );
      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}` },
        body,
        signal: request.signal,
      });
      if (!response.ok)
        throw new Error(
          `OpenAI image edit failed (${response.status}): ${await response.text()}`,
        );
      const payload = (await response.json()) as {
        data?: Array<{ b64_json?: unknown }>;
      };
      const encoded = payload.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || encoded === "")
        throw new Error(
          "OpenAI image edit response did not include image data.",
        );
      return Object.freeze({
        bytes: decodeImageBase64("image/png", encoded, options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES),
        mediaType: "image/png" as const,
      });
    },
  });
}

function extension(mediaType: string): string {
  return mediaType === "image/jpeg"
    ? "jpg"
    : mediaType === "image/webp"
      ? "webp"
      : "png";
}
import { decodeImageBase64 } from "./image-bytes.js";
