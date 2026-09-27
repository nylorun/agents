export type Compatibility = Readonly<{
  core: string;
  cli: string;
  harness: string;
  agents: string;
  admin: string;
  runtime: string;
}>;

export type CreateOptions = Readonly<{
  directory: string;
  yes: boolean;
  /** Deprecation notes for accepted-and-ignored flags, printed first. */
  notes?: readonly string[];
}>;

/** Docker and Compose v2, which the local stack needs. */
export type DockerCheck =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; problem: string }>;

export type Process = Readonly<{
  status: number | null;
  signal?: NodeJS.Signals | null;
}>;

export type CreatorDependencies = Readonly<{
  currentDirectory: () => string;
  isInteractive: () => boolean;
  log: (message: string) => void;
  signal?: AbortSignal;
  exists: (path: string) => Promise<boolean>;
  makeDirectory: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  write: (path: string, content: string) => Promise<void>;
  run: (
    command: string,
    args: readonly string[],
    directory: string,
  ) => Promise<Process>;
  /** `process.versions.node`: the CLI and the application need Node 24 or newer. */
  nodeVersion: string;
  /** Check that Docker's engine answers and Compose v2 is installed. */
  checkDocker: () => Promise<DockerCheck>;
}>;
