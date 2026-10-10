export {
  openTenantRuntime,
  TenantRuntime,
  type TenantOpenHooks,
} from "../tenant/runtime.js";
export {
  startEphemeralRuntime,
  type StartEphemeralRuntimeOptions,
  type EphemeralRuntime,
} from "../tenant/ephemeral.js";
export { scriptedModel, gatewayModel, type ModelProvider } from "./provider.js";

/** @deprecated Use TenantHandle. */
export type { TenantHandle as CoreRuntime } from "../tenant/types.js";
