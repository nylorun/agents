/**
 * `@nylorun/core/folder`: agent folders (track T6, D79). An agent written as a folder of
 * Markdown and JSON, compiled by `compileAgentFolder` into the agent manifest v8 the Runtime
 * runs. The Runtime compiles every folder it is sent with this code, and the CLI checks one
 * offline with the same code. `folderOfManifest` writes the folder of a saved manifest,
 * `agentFolderJsonSchemas` gives the JSON Schema of each kind of file in a folder, for editors, and
 * `applyFolderFixes` makes the fix-its its diagnostics carry (track T7).
 */
export {
  AGENT_FOLDER_COMPILER,
  AGENT_FOLDER_LIMITS,
  compileAgentFolder,
  folderTextPaths,
  type AgentFolderDiagnostic,
  type AgentFolderEntry,
  type AgentFolderFix,
  type AgentFolderLimits,
  type CompileAgentFolderInput,
  type CompiledAgentFolder,
} from "./compile.js";
export { folderOfManifest, type FolderOfManifest, type FolderOfManifestOptions } from "./decompile.js";
export { AGENT_FOLDER_SCHEMA_KINDS, agentFolderJsonSchemas, type AgentFolderSchemaKind } from "./schemas.js";
export { applyFolderFixes, type AppliedFolderFixes } from "./fix.js";
