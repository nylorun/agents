/** host.json — durable, no secrets */
export interface HostConfigFile {
  hostId: string; // "host_" + 26 Crockford chars
  host: string;
  port: number; // loopback by default
  allowNonLoopback?: boolean;
  /**
   * Whether browser requests (an `Origin` with a publishable key) may reach Tenant routes.
   * Default off for a Host started from host.json; container mode reads
   * `NYLORUN_BROWSER_ACCESS` instead.
   */
  browserAccess?: boolean;
  proxy?: {
    httpsProxy?: string;
    noProxy?: string;
    nodeExtraCaCerts?: string;
  };
}

/** host-credentials.json, mode 0600 */
export interface HostCredentialsFile {
  adminKey: string;
}
