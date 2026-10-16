/**
 * An Agent's Secrets tab's shell credentials (R2c, D56): what a skill's CLI in an Agent's
 * sandbox uses. An `environment_secret` is a sealed value the sandbox only sees as
 * `nylorun_managed`; egress-gate sets it as a header on requests to its allowed hosts. An
 * `environment_variable` is a plain value the sandbox sees. Either is written with `PUT
 * /v1/agents/{id}/secrets/{name}`, where the name is the variable's. The Runtime checks every
 * field again; these helpers shape the form's input.
 */

/** What the CLI reads in the sandbox in place of a secret's value. */
export const SHELL_SECRET_SENTINEL = "nylorun_managed";
/** The header a secret sets unless the form names another. */
export const DEFAULT_INJECT = { header: "Authorization", format: "Bearer {value}" } as const;

export type ShellCredentialType = "environment_secret" | "environment_variable";

export interface ShellSecretForm {
  readonly name: string;
  readonly hosts: string;
  readonly value: string;
  readonly header: string;
  readonly format: string;
}

/** The body of `PUT /v1/agents/{id}/secrets/{name}` for a shell credential. */
export type ShellSecretRequest =
  | {
      type: "environment_secret";
      value: string;
      allowedHosts: string[];
      inject?: { header: string; format: string };
    }
  | { type: "environment_variable"; value: string };

export function isShellType(type: string): type is ShellCredentialType {
  return type === "environment_secret" || type === "environment_variable";
}

/**
 * The hosts a secret is sent to, from a list separated by commas, spaces or lines: lowercase,
 * each once. Refuses an empty list, a URL, a port, a wildcard or an IP address, as the Runtime
 * would, so the form says which entry is wrong.
 */
export function parseAllowedHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const entry of text.split(/[\s,]+/)) {
    const host = entry.trim().toLowerCase();
    if (!host || hosts.includes(host)) continue;
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ||
      /^\d+(\.\d+){3}$/.test(host)
    )
      throw new Error(
        `“${entry.trim()}” is not a host name. List exact host names such as api.github.com: no scheme, port, wildcard or IP address.`,
      );
    hosts.push(host);
  }
  if (hosts.length === 0) throw new Error("List at least one host the secret is sent to.");
  return hosts;
}

/** The secret's header and format, left out when they are the default. */
export function injectOf(header: string, format: string): { header: string; format: string } | undefined {
  const name = header.trim() || DEFAULT_INJECT.header;
  const shape = format.trim() || DEFAULT_INJECT.format;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`“${name}” is not a header name.`);
  if (shape.split("{value}").length !== 2)
    throw new Error("The header format must contain {value} exactly once, such as Bearer {value}.");
  if (name.toLowerCase() === DEFAULT_INJECT.header.toLowerCase() && shape === DEFAULT_INJECT.format) return undefined;
  return { header: name, format: shape };
}

/**
 * A shell credential's name and body. The same call creates one and replaces its value: a
 * secret's hosts and header are sent again, as the form holds them.
 */
export function shellSecretRequest(
  type: ShellCredentialType,
  form: ShellSecretForm,
): { name: string; secret: ShellSecretRequest } {
  const name = form.name.trim();
  if (!name) throw new Error("Name the variable the sandbox sees, such as GH_TOKEN.");
  if (!form.value) throw new Error("Enter a value.");
  if (type === "environment_variable") return { name, secret: { type, value: form.value } };
  const inject = injectOf(form.header, form.format);
  return {
    name,
    secret: {
      type,
      value: form.value,
      allowedHosts: parseAllowedHosts(form.hosts),
      ...(inject ? { inject } : {}),
    },
  };
}

/** What a request carries for a secret, as the form previews it, with the value masked. */
export function headerPreview(header: string, format: string): string {
  const name = header.trim() || DEFAULT_INJECT.header;
  const shape = format.trim() || DEFAULT_INJECT.format;
  return `${name}: ${shape.replace(/\{base64:([^{}]*(?:\{value\}[^{}]*)?)\}/g, "base64($1)").replace("{value}", "<secret>")}`;
}
