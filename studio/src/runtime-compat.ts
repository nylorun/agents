import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkHealth, describeIncompatibility } from "@nylorun/agents";

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

/** Probes Runtime `/health` and reports SDK protocol compatibility. */
export async function probeRuntimeCompatibility(
  runtimeUrl: string,
): Promise<RuntimeCompatibility> {
  try {
    const health = await checkHealth(runtimeUrl);
    if (health.result === "failed")
      return Object.freeze({
        compatible: false,
        message: `Runtime health returned HTTP ${health.status}`,
      });
    if (health.result === "unadvertised")
      return Object.freeze({
        compatible: false,
        message:
          "Runtime health did not advertise a protocol range; upgrade the Runtime Host.",
      });
    if (health.result === "compatible") return Object.freeze({ compatible: true });
    const detail = describeIncompatibility(health.compatibility);
    return Object.freeze({
      compatible: false,
      message: detail.charAt(0).toUpperCase() + detail.slice(1),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      compatible: false,
      message: `Runtime is unavailable${detail ? `: ${detail}` : ""}`,
    });
  }
}
