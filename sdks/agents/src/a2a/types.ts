/**
 * The A2A 1.0 wire types the client reads and sends, as ProtoJSON (camelCase fields, enum
 * values such as `TASK_STATE_WORKING`). They follow the Runtime's own (`api/a2a/protocol.ts`)
 * and add what profile v2 serves: metadata on tasks and artifacts, the update events a push
 * carries, `ListTasks` and the card's extensions. Only types: nothing here runs.
 */

export type TaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED";

export type Metadata = Record<string, unknown>;

/** Exactly one of `text`, `data`, `raw` (base64 bytes) or `url` (A2A §4.1.6). */
export type Part =
  | { text: string; mediaType?: string; metadata?: Metadata }
  | { data: unknown; mediaType?: string; metadata?: Metadata }
  | { raw: string; mediaType?: string; filename?: string; metadata?: Metadata }
  | { url: string; mediaType?: string; filename?: string; metadata?: Metadata };

export type Role = "ROLE_USER" | "ROLE_AGENT";

export interface Message {
  messageId: string;
  role: Role;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  /** The extension URIs whose data this message carries in `metadata`. */
  extensions?: string[];
  metadata?: Metadata;
  referenceTaskIds?: string[];
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  extensions?: string[];
  metadata?: Metadata;
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  /** ISO 8601. Order updates by it. */
  timestamp?: string;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Metadata;
}

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Metadata;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Metadata;
}

/** One update: the body of a push delivery, or one frame of a stream. Exactly one field is set. */
export type StreamResponse =
  | { task: Task }
  | { message: Message }
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent };

/** Where an agent sends push deliveries for a task. */
export interface PushNotificationConfig {
  url: string;
  /** Sent back on every delivery as `X-A2A-Notification-Token`. */
  token?: string;
  id?: string;
}

export interface ListTasksResult {
  tasks: Task[];
  /** Empty when this is the last page. */
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Metadata;
}

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion?: string;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
  extensions?: AgentExtension[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  iconUrl?: string;
  securitySchemes?: Record<string, unknown>;
  securityRequirements?: unknown[];
  [field: string]: unknown;
}
