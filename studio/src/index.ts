export { startStudio } from "./host.js";
export type {
  StudioConfig,
  StudioHost,
  StudioOptions,
  StudioTenant,
} from "./host.js";
export type { StudioMode, StudioHello, Pairing } from "./contract.js";
export {
  STUDIO_PROTOCOL,
  HOSTED_ORIGIN,
  PROXY_HOST,
  pairingFragment,
  parsePairingFragment,
  proxyOrigin,
} from "./contract.js";
export { startStudioServer } from "./server.js";
export type {
  StudioServer,
  StudioServerHello,
  StudioServerOptions,
  StudioTenantSummary,
} from "./server.js";
