/**
 * The Studio server that `ghcr.io/nylorun/studio` runs (`server-main.ts` is the
 * container entry). This package is private: it ships only as that image.
 */
export {
  parseAnalyticsId,
  parseRuntimeUrl,
  readAdminKeyFile,
  startStudioServer,
} from "./server.js";
export type {
  StudioServer,
  StudioServerHello,
  StudioServerOptions,
  StudioTenantSummary,
} from "./server.js";
export { proxyRuntime } from "./proxy.js";
export type { StudioProxyOptions } from "./proxy.js";
