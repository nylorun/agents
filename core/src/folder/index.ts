/**
 * `@nylorun/core/folder`: agent folders (track T6, D79). An agent written as a folder of
 * Markdown and JSON, compiled by `compileAgentFolder` into the agent manifest v8 the Runtime
 * runs. The Runtime compiles every folder it is sent with this code, and the CLI checks one
 * offline with the same code.
 */
export {
  AGENT_FOLDER_COMPILER,
  AGENT_FOLDER_LIMITS,
  compileAgentFolder,
  folderTextPaths,
  type AgentFolderDiagnostic,
  type AgentFolderEntry,
  type CompileAgentFolderInput,
  type CompiledAgentFolder,
} from "./compile.js";
