/**
 * The Credentials page's shell credentials (R2c): what a skill's CLI in a pod sandbox uses. An
 * `environment_secret` is a sealed value the sandbox only sees as `nylorun-managed`; egress-gate
 * sets it as a header on requests to its allowed hosts. An `environment_variable` is a plain,
 * visible value. The Runtime checks every field again; these helpers shape the form's input.
 */

/** What the CLI reads in the sandbox in place of a secret's value. */
export const SHELL_SECRET_SENTINEL = "nylorun-managed";
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

export type ShellAuth =
  | {
      type: "environment_secret";
      secretName: string;
      secretValue: string;
      allowedHosts: string[];
      inject?: { header: string; format: string };
    }
  | { type: "environment_variable"; variableName: string; variableValue: string };

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

/** The `auth` of a new shell credential. */
export function shellCreateAuth(
  type: ShellCredentialType,
  form: ShellSecretForm,
): ShellAuth {
  const name = form.name.trim();
  if (!name) throw new Error("Name the variable the sandbox sees, such as GH_TOKEN.");
  if (!form.value) throw new Error("Enter a value.");
  if (type === "environment_variable") return { type, variableName: name, variableValue: form.value };
  const inject = injectOf(form.header, form.format);
  return {
    type,
    secretName: name,
    secretValue: form.value,
    allowedHosts: parseAllowedHosts(form.hosts),
    ...(inject ? { inject } : {}),
  };
}

/** The `auth` of a shell credential's rotation: only its value changes. */
export function shellRotateAuth(
  type: ShellCredentialType,
  value: string,
): { type: "environment_secret"; secretValue: string } | { type: "environment_variable"; variableValue: string } {
  if (!value) throw new Error("Enter the new value.");
  return type === "environment_secret"
    ? { type, secretValue: value }
    : { type, variableValue: value };
}

/** What a request carries for a secret, as the form previews it, with the value masked. */
export function headerPreview(header: string, format: string): string {
  const name = header.trim() || DEFAULT_INJECT.header;
  const shape = format.trim() || DEFAULT_INJECT.format;
  return `${name}: ${shape.replace(/\{base64:([^{}]*(?:\{value\}[^{}]*)?)\}/g, "base64($1)").replace("{value}", "<secret>")}`;
}
