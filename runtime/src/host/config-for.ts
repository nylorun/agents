import type { HostConfigFile } from "./config.js";
import { tenantPaths } from "../tenant/paths.js";
import type { Logger, TenantConfig } from "../tenant/types.js";
import { tenantChildEnvironment } from "./environment.js";

/**
 * Builds the TenantConfig of the Host's Tenant for `openTenantRuntime`.
 * The sandbox backend here is the Host default; a Tenant's seeded `sandbox.backend`
 * setting overrides it when the Tenant opens (I1, A18).
 */
export function configForFactory(options: {
  hostRoot: string;
  hostConfig: HostConfigFile;
  logger: Logger;
  /** Allowlisted baseline from `baselineEnvironment` (built in `host/main.ts`). */
  baseline: Readonly<Record<string, string>>;
  mode?: TenantConfig["mode"];
  /** Override model; default vault. Fixture/scripted require ephemeral/test mode. */
  model?: TenantConfig["model"];
  /** How Tenants may call Action endpoints (`StackConfig.delivery`). */
  delivery?: TenantConfig["delivery"];
}): (id: string) => TenantConfig {
  const { baseline } = options;
  return (id: string): TenantConfig => {
    const tenant = tenantPaths(options.hostRoot);
    const sandboxBackend: TenantConfig["sandbox"]["backend"] = "auto";
    return {
      tenantId: id,
      mode: options.mode ?? "shared",
      paths: tenant,
      sandbox: { backend: sandboxBackend },
      model: options.model ?? { kind: "vault" },
      ...(options.delivery ? { delivery: options.delivery } : {}),
      childEnv: tenantChildEnvironment(
        baseline,
        options.hostConfig,
        tenant,
      ),
      logger: {
        info: (message, fields) =>
          options.logger.info(message, { tenantId: id, ...fields }),
        warn: (message, fields) =>
          options.logger.warn(message, { tenantId: id, ...fields }),
        error: (message, fields) =>
          options.logger.error(message, { tenantId: id, ...fields }),
      },
    };
  };
}
