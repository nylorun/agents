/**
 * Image checks for the image editor, which handles image bytes itself: the supported types, a
 * size cap the caller sets, and a signature check. Storing images is the job of file artifacts.
 */
export const IMAGE_MEDIA_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

/** The bytes of canonical base64 `base64`, checked as an image of `mediaType` of at most `maxBytes`. */
export function decodeImageBase64(mediaType: string, base64: string, maxBytes: number): Uint8Array {
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) throw new Error("Only JPEG, PNG, and WebP images are supported.");
  if (typeof base64 !== "string" || base64 === "") throw new Error("Image data is required.");
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64))
    throw new Error("Image data must be canonical base64.");
  const decoded = atob(base64);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (btoa(decoded) !== base64) throw new Error("Image data must be canonical base64.");
  validateImageBytes(mediaType, bytes, maxBytes);
  return bytes;
}

/** Verify the asserted media type, the size and a lightweight file signature for a supported image. */
export function validateImageBytes(mediaType: string, bytes: Uint8Array, maxBytes: number): void {
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) throw new Error("Only JPEG, PNG, and WebP images are supported.");
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes)
    throw new Error(`Images must be no larger than ${maxBytes} bytes.`);
  const signature =
    mediaType === "image/jpeg"
      ? bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mediaType === "image/png"
        ? bytes.byteLength >= 8 &&
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47 &&
          bytes[4] === 0x0d &&
          bytes[5] === 0x0a &&
          bytes[6] === 0x1a &&
          bytes[7] === 0x0a
        : bytes.byteLength >= 12 &&
          bytes[0] === 0x52 &&
          bytes[1] === 0x49 &&
          bytes[2] === 0x46 &&
          bytes[3] === 0x46 &&
          bytes[8] === 0x57 &&
          bytes[9] === 0x45 &&
          bytes[10] === 0x42 &&
          bytes[11] === 0x50;
  if (!signature) throw new Error(`Image bytes do not match ${mediaType}.`);
}
