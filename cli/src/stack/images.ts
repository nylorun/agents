import { pinnedVersion } from "./versions.js";

/**
 * Images the local stack runs. The Runtime and Studio tags are pinned by this
 * CLI release; `NYLORUN_RUNTIME_IMAGE` and `NYLORUN_STUDIO_IMAGE` override them
 * (local builds, CI images). Postgres, Restate and s2-lite are the official
 * images, pinned here.
 */
export const PINNED_IMAGES = {
  postgres: "postgres:17.11",
  restate: "docker.restate.dev/restatedev/restate:1.7.12",
  s2: "ghcr.io/s2-streamstore/s2:0.43.0",
} as const;

export interface StackImages {
  runtime: string;
  studio: string;
  postgres: string;
  restate: string;
  s2: string;
}

export function stackImages(
  env: Readonly<Record<string, string | undefined>>,
  versions: { runtime: string; studio: string } = {
    runtime: pinnedVersion("runtime"),
    studio: pinnedVersion("studio"),
  },
): StackImages {
  const override = (name: string) => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  return {
    runtime:
      override("NYLORUN_RUNTIME_IMAGE") ??
      `ghcr.io/nylorun/runtime:${versions.runtime}`,
    studio:
      override("NYLORUN_STUDIO_IMAGE") ??
      `ghcr.io/nylorun/studio:${versions.studio}`,
    ...PINNED_IMAGES,
  };
}
