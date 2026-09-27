/** host.json — durable, no secrets */
export interface HostConfigFile {
  hostId: string; // "host_" + 26 Crockford chars
  host: string;
  port: number; // loopback by default
  allowNonLoopback?: boolean;
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
