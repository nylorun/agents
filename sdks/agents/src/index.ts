// Definition authoring and wire contracts are the only harness runtime imports.
export {
  hashManifest,
  PROTOCOL_VERSION,
  PROTOCOL_FEATURES,
  HOST_PROTOCOL,
  DEFINITION_SCHEMA_VERSION,
  PROTOCOL_HEADER,
  SUBJECT_HEADER,
  SCOPES_HEADER,
  SESSION_ID_HEADER,
  TURN_ID_HEADER,
  AGENT_ID_HEADER,
  TENANT_ID_PATTERN,
  isTenantId,
  newTenantId,
  newPrincipalId,
  checkCompatibility,
  compareVersions,
  ERROR_CODES,
} from "@nylorun/core/compatibility";
export type {
  ProtocolFeature,
  ProtocolRange,
  Compatibility,
  ErrorCode,
} from "@nylorun/core/compatibility";
// The `/health` compatibility probe every Runtime client shares (Studio's server uses it).
export {
  checkHealth,
  describeIncompatibility,
  parseProtocolRange,
} from "@nylorun/core/transport";
export type { HealthCheck, Incompatibility } from "@nylorun/core/transport";
export { Agent, AgentBuilder } from "./builder.js";
export {
  AgentBuildError,
  AgentLifecycleError,
  VerdictSchema,
  isVerdict,
  WorkflowBuildError,
  isBuiltWorkflow,
  flow,
  tool,
  http,
  defineSchema,
  ToolError,
  // The harness section `agentManifests.save` makes from a built agent or flow, and the gaps the
  // Runtime refuses between a manifest's two sections, for code that builds a manifest itself.
  harnessSectionOf,
  sectionGaps,
} from "@nylorun/core/define";
export type {
  FlowAgentBuilder,
  Flow,
  Named,
  LoopOptions,
  StageOptions,
  HttpTarget,
} from "@nylorun/core/define";
export type {
  AgentOptions,
  AgentManifest,
  BuiltAgent,
  BuiltWorkflow,
  Verdict,
  WorkflowBinding,
  WorkflowManifest,
  ToolDefinition,
  ToolExecutionContext,
  ToolOutcome,
  JsonValue,
  JsonObject,
} from "@nylorun/core/define";
export type {
  SessionPage,
  SessionListItem,
  SessionManifestView,
  HistoryPage,
  SessionUsageTotals,
  SessionModelChoice,
  SessionModelView,
  CostSplit,
  ModelCall,
  ModelCallsPage,
  AgentPage,
  ToolCall,
  ToolCallsPage,
  LiveEvent,
  SessionEvent,
  SessionEventOf,
  EventType,
  SessionCommand,
  SubjectScope,
  AgentView,
  AgentState,
  AgentAttention,
  AgentEvent,
  AgentEventType,
  EgressRunningTurn,
  EnvironmentKind,
  EnvironmentRecipe,
  EnvironmentSecretSlot,
  AgentSecretView,
  AgentSnapshot,
  AgentRestore,
  AgentDiskVersions,
  RestoreAgentRequest,
  AgentForkPlan,
  AgentMovePlan,
  RestartAgentRequest,
  ForkAgentRequest,
  ForkAgentResponse,
  DeleteAgentResponse,
  PutAgentRequest,
  PutAgentSecretRequest,
  AgentManifestV8,
  AgentManifestFile,
  HarnessManifestFile,
  RuntimeManifestFile,
  RuntimeSection,
  AgentManifestChange,
  AgentManifestWarning,
  AgentManifestPlan,
  AgentManifestSource,
  AgentManifestSourceDiff,
  AgentManifestSourceSummary,
  AgentFolderDiagnostic,
  AgentManifestView,
  AgentManifestVersions,
  SaveAgentManifestResponse,
  DeleteAgentManifestResponse,
  MessagePart,
  ArtifactView,
  ArtifactKind,
  ArtifactListItem,
  ArtifactPage,
  ArtifactVersionView,
  ArtifactLink,
  UploadArtifactResponse,
  DefinitionFileView,
  ArtifactTree,
  ArtifactDiff,
  FolderEntry,
} from "@nylorun/core/contracts";
export {
  AGENT_EVENT_TYPES,
  AGENT_FOLDER_MEDIA_TYPE,
  AGENT_STATES,
  COMPUTE_STATES,
  RUNTIME_LIMIT_DEFAULTS,
  SUBJECT_SCOPES,
} from "@nylorun/core/contracts";
export type {
  AgentHarnessSection,
  HarnessSection,
  HarnessSkill,
  HarnessMcpServer,
  WorkflowHarnessSection,
} from "@nylorun/core";
export { AgentsClient, SessionClient, createClient } from "./client.js";
export { ArtifactsClient } from "./artifacts.js";
export { FilesClient, definitionFileHash } from "./files.js";
export type {
  ArtifactBody,
  ArtifactPageOptions,
  ArtifactLinkWithUrl,
  UploadArtifactOptions,
} from "./artifacts.js";
export type {
  ActAsOptions,
  AgentSource,
  SessionView,
  CommandOptions,
  CreateSessionOptions,
  SessionSandbox,
  AgentFilter,
  AgentInput,
  AgentSecretInput,
  RuntimeFileBytes,
  AgentManifestDocument,
  AgentManifestFromAgent,
  AgentManifestInput,
  AgentManifestSaveOptions,
  ComposedManifest,
  DefinitionFiles,
} from "./client.js";
export {
  AgentInstancesClient,
  AgentManifestsClient,
  AgentMemoriesClient,
  AgentSecretsClient,
  ManifestGapsError,
  agentManifest,
  requirementGaps,
  runtimeFiles,
} from "./client.js";
export { composeManifest, manifestFolders, ComposeError, AGENT_MANIFEST_FILE } from "./compose.js";
export { AGENT_FOLDER_FILE, FolderError, FolderInvalidError, diagnosticLine } from "./folder.js";
export { checkFolder, folderOfManifest, type FolderOfManifest, type FolderOfManifestOptions } from "./folder-check.js";
export type { PackedFolder } from "./folder.js";
export { packFolder, isAgentFolder, FOLDER_IGNORE_FILE } from "./folder-pack.js";
export { ignoreMatcher } from "./folder-ignore.js";
export { AccessClient } from "./access.js";
export { resolveConnection, ConnectionError } from "./connection.js";
export type { ResolvedConnection } from "./connection.js";
export { RuntimeError, IncompatibleRuntimeError } from "./http.js";
export type { Destination, IncompatibleReason, TokenSource } from "./http.js";
export { loadMcpServers, loadPlugin, PluginError } from "./plugins/load.js";
export type { LoadedPlugin, PluginDiagnostic } from "./plugins/load.js";
export {
  hashFolder,
  loadSkillsFromDirectory,
  resolveSkillsRoot,
  parseSkill,
  SkillsError,
} from "./skills/index.js";
export type { SkillDiagnostic } from "./skills/index.js";
export { McpError } from "./mcp/index.js";
export type { McpServerSpec } from "./mcp/index.js";

export type { SessionPageOptions } from "./reads.js";
// The A2A client (`@nylorun/agents/a2a` also has the gateway handler).
export * from "./a2a/client-api.js";
export type * as A2a from "./a2a/types.js";
