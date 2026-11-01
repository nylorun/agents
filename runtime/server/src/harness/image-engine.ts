/**
 * An engine the workload image carries (ADR-99): the Runtime image's tini, node and bundled engine
 * under `/opt/nylorun`, run by the sandboxes service with `entrypoint: "builtin"`. Such an engine is
 * the Runtime version the image was built from, so it says which at `host/join`; the Runtime decides
 * from it whether the next pod runs it or copies its own in (`sandbox/pods/builtin.ts`).
 */

/** Where an image keeps the engine it carries. */
export const BUILTIN_ENGINE_ROOT = "/opt/nylorun";

/** Sent at `host/join` only by an engine running from `BUILTIN_ENGINE_ROOT`: its Runtime version. */
export const IMAGE_ENGINE_HEADER = "nylorun-image-engine";

/** A Runtime version, as the header carries it. */
export const ENGINE_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

/** Whether code at `moduleUrl` runs from an image's engine (the engine passes its own URL). */
export function isBuiltinEngine(moduleUrl: string): boolean {
  return moduleUrl.startsWith(`file://${BUILTIN_ENGINE_ROOT}/`);
}
