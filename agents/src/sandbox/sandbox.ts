import {
  SANDBOX_DEFERRED_FIELDS,
  SANDBOX_FIELDS,
  SANDBOX_INSTRUCTIONS,
  SANDBOX_NETWORK_PRESETS,
  createSandboxTools,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
} from "@nylorun/core/define";
import type {
  CapabilityDeclaration,
  SandboxManifest,
  SandboxNetworkPreset,
  ToolDefinition,
} from "@nylorun/core/define";

/** What computer the agent needs. The Runtime decides where it runs. */
export type SandboxOptions = SandboxManifest;

export interface SandboxCapabilityOptions {
  /** Capability id. Defaults to `"sandbox"`. */
  readonly id?: string;
}

export interface SandboxCapability extends CapabilityDeclaration {
  readonly sandbox: SandboxManifest;
  readonly tools: readonly ToolDefinition[];
}

export class SandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

/**
 * Give the agent an isolated Linux machine with a persistent `/workspace`.
 *
 * Adds the built-in `bash`, `read`, `write`, `edit`, `grep` and `glob` tools. They run in the
 * Nylorun Runtime, which picks the backend. Agent code declares requirements only.
 *
 * ```ts
 * Agent({ id: "analyst", instructions: "..." }).use(sandbox())
 * Agent({ ... }).use(sandbox({ image: "node:24", network: { allow: ["api.github.com"] } }))
 * ```
 */
export function sandbox(
  options: SandboxOptions = {},
  capability: SandboxCapabilityOptions = {}
): SandboxCapability {
  const id = capability.id ?? "sandbox";
  if (!isRecord(options))
    throw new SandboxError("sandbox.invalid", "sandbox() expects an options object");
  for (const key of Object.keys(options)) {
    if ((SANDBOX_DEFERRED_FIELDS as readonly string[]).includes(key))
      throw new SandboxError(
        "sandbox.unsupported",
        `sandbox({ ${key} }) is not supported in this version. ` +
          `Supported options: ${SANDBOX_FIELDS.join(", ")}. See docs/design/sandboxes.md for what is planned.`
      );
    if (!(SANDBOX_FIELDS as readonly string[]).includes(key))
      throw new SandboxError(
        "sandbox.unknown-option",
        `Unknown sandbox option '${key}'. Supported options: ${SANDBOX_FIELDS.join(", ")}`
      );
  }
  return Object.freeze({
    id,
    instructions: Object.freeze([SANDBOX_INSTRUCTIONS]),
    tools: createSandboxTools(),
    sandbox: freezeOptions(options),
  });
}

function freezeOptions(options: SandboxOptions): SandboxManifest {
  const result: {
    image?: string;
    network?: SandboxManifest["network"];
    resources?: SandboxManifest["resources"];
    idle?: string;
  } = {};
  if (options.image !== undefined) {
    if (typeof options.image !== "string" || options.image.trim().length === 0)
      throw new SandboxError("sandbox.invalid-image", "sandbox({ image }) must be a non-empty OCI image reference");
    result.image = options.image;
  }
  if (options.network !== undefined) {
    if (!isRecord(options.network))
      throw new SandboxError("sandbox.invalid-network", "sandbox({ network }) must be an object");
    for (const key of Object.keys(options.network))
      if (key !== "preset" && key !== "allow")
        throw new SandboxError("sandbox.invalid-network", `Unknown network option '${key}'. Use preset and allow.`);
    const { preset, allow } = options.network;
    if (preset !== undefined && !(SANDBOX_NETWORK_PRESETS as readonly string[]).includes(preset))
      throw new SandboxError(
        "sandbox.invalid-network",
        `network.preset must be one of ${SANDBOX_NETWORK_PRESETS.join(", ")}`
      );
    if (allow !== undefined) {
      if (!Array.isArray(allow))
        throw new SandboxError("sandbox.invalid-network", "network.allow must be an array of host names");
      for (const host of allow)
        if (typeof host !== "string" || !isSandboxHostPattern(host))
          throw new SandboxError(
            "sandbox.invalid-network",
            `network.allow entry '${String(host)}' must be a host name such as api.github.com or *.example.com (no scheme, port or path)`
          );
    }
    result.network = Object.freeze({
      ...(preset === undefined ? {} : { preset: preset as SandboxNetworkPreset }),
      ...(allow === undefined ? {} : { allow: Object.freeze([...allow]) }),
    });
  }
  if (options.resources !== undefined) {
    if (!isRecord(options.resources))
      throw new SandboxError("sandbox.invalid-resources", "sandbox({ resources }) must be an object");
    for (const key of Object.keys(options.resources))
      if (key !== "cpus" && key !== "memory")
        throw new SandboxError(
          "sandbox.invalid-resources",
          `resources.${key} is not supported in this version. Use cpus and memory.`
        );
    const { cpus, memory } = options.resources;
    if (cpus !== undefined && (!Number.isInteger(cpus) || cpus < 1 || cpus > 64))
      throw new SandboxError("sandbox.invalid-resources", "resources.cpus must be an integer from 1 to 64");
    if (memory !== undefined && (typeof memory !== "string" || parseSandboxSize(memory) === undefined))
      throw new SandboxError("sandbox.invalid-resources", "resources.memory must be a size such as 512MiB or 2GiB");
    result.resources = Object.freeze({
      ...(cpus === undefined ? {} : { cpus }),
      ...(memory === undefined ? {} : { memory }),
    });
  }
  if (options.idle !== undefined) {
    if (typeof options.idle !== "string" || parseSandboxDuration(options.idle) === undefined)
      throw new SandboxError("sandbox.invalid-idle", "sandbox({ idle }) must be a duration such as 30s, 15m or 1h");
    result.idle = options.idle;
  }
  return Object.freeze(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
