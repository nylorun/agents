/**
 * Definition files (track R2 M4): `client.files`. A definition names the files it needs by the
 * SHA-256 of their bytes (a skill's folder, `SkillManifest.files`); the Runtime holds each one
 * once, uploaded with `PUT /v1/files/sha256:<hex>`, and refuses a definition naming a file it
 * does not hold (`400 definition_files_missing`). `saveAgent` uploads an agent's files itself.
 */
import {
  isDefinitionFileHash,
  type DefinitionFileView,
} from "@nylorun/core/contracts";
import type { SkillFileSource } from "@nylorun/core/define";
import { RuntimeError, type Transport } from "./http.js";

/** `sha256:<hex>` of `bytes`. */
export async function definitionFileHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function pathOf(sha256: string): string {
  if (!isDefinitionFileHash(sha256))
    throw new TypeError(`${sha256} is not a definition file's hash: sha256:<64 lowercase hex>`);
  return `/v1/files/${sha256}`;
}

export class FilesClient {
  constructor(private readonly transport: Transport) {}

  /** Whether the Runtime holds the file `sha256` (`sha256:<hex>`) names. */
  async has(sha256: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    try {
      await this.transport.request(pathOf(sha256), {
        method: "HEAD",
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return true;
    } catch (error) {
      if (error instanceof RuntimeError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * Uploads one file, at most 10 MiB. The Runtime checks its bytes hash to `sha256` (default:
   * their hash) and keeps a file it already holds as it is.
   */
  async upload(
    bytes: Uint8Array,
    options: { sha256?: string; signal?: AbortSignal } = {},
  ): Promise<DefinitionFileView> {
    const response = await this.transport.request(pathOf(options.sha256 ?? (await definitionFileHash(bytes))), {
      method: "PUT",
      body: bytes as BodyInit,
      headers: { "content-type": "application/octet-stream" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return (await response.json()) as DefinitionFileView;
  }

  /** Uploads each of `files` the Runtime does not hold yet. */
  async ensure(
    files: ReadonlyMap<string, SkillFileSource>,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    for (const [sha256, source] of files) {
      if (await this.has(sha256, options)) continue;
      await this.upload(await source.read(), { sha256, ...options });
    }
  }
}
