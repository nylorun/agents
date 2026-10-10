/** Control transfer to a durable host, never a model/tool failure. */
export class HostSuspension extends Error {
  constructor(
    readonly effectId: string,
    readonly status: "pending" | "uncertain",
  ) {
    super(`Host suspended at ${effectId}`);
  }
}
