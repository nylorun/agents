import { pinnedVersion } from "./versions.js";

/**
 * Images a local Tenant runs. The Runtime and Studio tags are pinned by this
 * CLI release; `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them
 * (local builds, CI images). Postgres, Restate, s2-lite and RustFS are the
 * official images, pinned here; RustFS (the Object store, D35) by digest as well, so
 * it is upgraded only on purpose.
 */
export const PINNED_IMAGES = {
  postgres: "postgres:17.11",
  restate: "docker.restate.dev/restatedev/restate:1.7.12",
  s2: "ghcr.io/s2-streamstore/s2:0.43.0",
  rustfs:
    "rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c",
} as const;

export interface StackImages {
  runtime: string;
  studio: string;
  postgres: string;
  restate: string;
  s2: string;
  rustfs: string;
}

function override(
  env: Readonly<Record<string, string | undefined>>,
  name: "NYLORUN_RUNTIME_IMAGE" | "NYLORUN_STUDIO_IMAGE",
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** `NYLORUN_RUNTIME_IMAGE` names the Runtime image, so its version is unknown here. */
export function runtimeImageOverridden(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return override(env, "NYLORUN_RUNTIME_IMAGE") !== undefined;
}

export function stackImages(
  env: Readonly<Record<string, string | undefined>>,
  versions: { runtime: string; studio: string } = {
    runtime: pinnedVersion("runtime"),
    studio: pinnedVersion("studio"),
  },
): StackImages {
  return {
    runtime:
      override(env, "NYLORUN_RUNTIME_IMAGE") ??
      `ghcr.io/nylorun/runtime:${versions.runtime}`,
    studio:
      override(env, "NYLORUN_STUDIO_IMAGE") ??
      `ghcr.io/nylorun/studio:${versions.studio}`,
    ...PINNED_IMAGES,
  };
}
