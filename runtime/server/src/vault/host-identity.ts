/**
 * The Host's identity for model calls (ADR-71): a model credential of type `host_identity` holds
 * no secret, only the Google Cloud project and location. The model gate calls Agent Platform with
 * the Host's Google Application Default Credentials, which Google's client library finds at each
 * call (`GOOGLE_APPLICATION_CREDENTIALS`, gcloud's file, or the metadata server on Google Cloud).
 * Nothing of them is stored, logged or passed to a sandbox.
 *
 * Off unless the Host's operator lends it, per provider, with `NYLORUN_MODEL_HOST_IDENTITY` on the
 * process that runs the gates. Every Tenant on the Host may then use it, so a Host that serves
 * several organizations must not set it.
 */

/** The providers that can use the Host's identity. */
export const HOST_IDENTITY_PROVIDERS = ["google-vertex"] as const;

/**
 * What pi-ai's Vertex AI client takes in place of an API key to use Application Default
 * Credentials, with the project and location in the call's `env`.
 */
export const VERTEX_ADC_MARKER = "gcp-vertex-credentials";

let lent: readonly string[] = [];

/** Sets the providers this process lends the Host's identity to (at startup). */
export function useHostIdentity(providers: readonly string[]): void {
  lent = [...providers];
}

/** Why a model of `provider` may not use the Host's identity here, or undefined when it may. */
export function hostIdentityRefused(provider: string): string | undefined {
  if (!(HOST_IDENTITY_PROVIDERS as readonly string[]).includes(provider))
    return `The Host's identity authenticates ${HOST_IDENTITY_PROVIDERS.join(", ")} only, not ${provider}.`;
  if (!lent.includes(provider))
    return `This Host doesn't lend its identity to ${provider}: its operator sets NYLORUN_MODEL_HOST_IDENTITY=${provider}.`;
  return undefined;
}

/** The call's `env` for a `host_identity` credential: where Agent Platform runs it. */
export function hostIdentityEnv(project: string, location: string): Record<string, string> {
  return { GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_LOCATION: location };
}
