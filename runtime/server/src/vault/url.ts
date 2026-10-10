import { VaultError } from "./error.js";

export function normalizeVaultUrl(
  input: string,
  options: { httpsOnly?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new VaultError(400, "Credential url is invalid");
  }
  if (url.username !== "" || url.password !== "")
    throw new VaultError(400, "Credential url must not contain userinfo");
  if (url.hash !== "")
    throw new VaultError(400, "Credential url must not contain a fragment");
  if (url.hostname.includes("*") || url.pathname.includes("*"))
    throw new VaultError(400, "Credential url must not contain a wildcard");
  if (options.httpsOnly) {
    if (url.protocol !== "https:")
      throw new VaultError(400, "Credential url must use https");
  } else if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new VaultError(400, "Credential url must use http or https");
  }
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  )
    url.port = "";
  return `${url.origin}${url.pathname}${url.search}`;
}
