/**
 * An engine built into the workload's image (ADR-99): the Runtime image's tini, node and bundled
 * engine under `/opt/nylorun`, which the sandboxes service runs with `entrypoint: "builtin"` and
 * nothing copied in.
 *
 * The Tenant lists the images that carry one (`engine.images`, by repository). Such an engine is
 * whichever Runtime version the image was built from, so it reports that version when it joins
 * (`IMAGE_ENGINE_HEADER`, sent only by an engine running from `/opt/nylorun`), and the pod's
 * record keeps it beside the digest it ran (`engineImage`). A pod runs the image's engine while
 * that version is the Runtime's own, or not known yet for the digest it runs (a first start, which
 * the Harness API version check at `hello` still guards); otherwise the engine is copied in, so a
 * Runtime upgrade never leaves a pod on an older engine for more than that first turn.
 */
import { RUNTIME_VERSION } from "../../version.js";
import { repositoryOf } from "./lifecycle.js";

export { BUILTIN_ENGINE_ROOT, ENGINE_VERSION_PATTERN, IMAGE_ENGINE_HEADER } from "../../harness/image-engine.js";

/** The engine an image carries, as the pod's record keeps it: its version, seen on `digest`. */
export interface EngineImage {
  readonly version: string;
  readonly digest?: string;
}

/**
 * Whether a pod of `image` (its pinned digest, or as asked) runs the engine the image carries:
 * the Tenant lists its repository, and the engine recorded for that digest is this Runtime's
 * version or not known yet.
 */
export function runsBuiltinEngine(input: {
  readonly image: string | undefined;
  readonly imageDigest: string | undefined;
  readonly engineImage: EngineImage | undefined;
  readonly listed: readonly string[] | undefined;
  readonly runtimeVersion?: string;
}): boolean {
  const image = input.imageDigest ?? input.image;
  if (!image || !input.listed?.length) return false;
  const repository = repositoryOf(image);
  if (!input.listed.some((entry) => repositoryOf(entry) === repository)) return false;
  const known =
    input.engineImage !== undefined && input.imageDigest !== undefined && input.engineImage.digest === input.imageDigest
      ? input.engineImage.version
      : undefined;
  return known === undefined || known === (input.runtimeVersion ?? RUNTIME_VERSION);
}
