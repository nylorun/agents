import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  checkCompatibility,
  type ProtocolRange,
} from "@nylorun/agents";

export type RuntimeCompatibility = Readonly<{
  compatible: boolean;
  message?: string;
}>;

/** `@nylorun/studio`'s package version, read once. */
export const STUDIO_VERSION: string = (() => {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.min !== "number" ||
    typeof record.max !== "number" ||
    !Array.isArray(record.features) ||
    !record.features.every((feature) => typeof feature === "string")
  )
    return undefined;
  return {
    min: record.min,
    max: record.max,
    features: record.features as readonly string[],
  };
}

/** Probes Runtime `/health` and reports SDK protocol compatibility. */
export async function probeRuntimeCompatibility(
  runtimeUrl: string,
): Promise<RuntimeCompatibility> {
  try {
    const response = await fetch(`${runtimeUrl}/health`, {
      method: "GET",
      redirect: "error",
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    if (!response.ok) {
      return Object.freeze({
        compatible: false,
        message: `Runtime health returned HTTP ${response.status}`,
      });
    }
    const protocol = parseProtocolRange(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).protocol
        : undefined,
    );
    if (!protocol) {
      return Object.freeze({
        compatible: false,
        message:
          "Runtime health did not advertise a protocol range; upgrade the Runtime Host.",
      });
    }
    const result = checkCompatibility(
      { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
      protocol,
    );
    if (result.ok) return Object.freeze({ compatible: true });
    const message =
      result.reason === "version"
        ? `Client protocol ${result.client} is outside Host range ${result.host.min}–${result.host.max}`
        : `Host is missing required features: ${result.missing.join(", ")}`;
    return Object.freeze({ compatible: false, message });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      compatible: false,
      message: `Runtime is unavailable${detail ? `: ${detail}` : ""}`,
    });
  }
}
