/**
 * Environments and their secrets over the Runtime API (protocol 11, D55, D56), for tests that
 * give a session credentials: create the Environment, write its secrets, then name it in
 * `PUT /v1/sessions/{id}` (`environment`).
 */
import { expect } from "vitest";
import type { PutEnvironmentRequest, PutEnvironmentSecretRequest } from "@nylorun/core/contracts";

/** `PUT /v1/environments/{id}` (default kind `none`: credentials, no sandbox); expects a 200. */
export async function putEnvironment(
  url: string,
  headers: Record<string, string>,
  id: string,
  body: PutEnvironmentRequest = { kind: "none" },
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/v1/environments/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(answer)).toBe(200);
  return answer;
}

/** `PUT /v1/environments/{id}/secrets/{name}`: the status and the answer. */
export async function writeSecret(
  url: string,
  headers: Record<string, string>,
  environmentId: string,
  name: string,
  body: PutEnvironmentSecretRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${url}/v1/environments/${encodeURIComponent(environmentId)}/secrets/${encodeURIComponent(name)}`,
    { method: "PUT", headers, body: JSON.stringify(body) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** `writeSecret`, expecting a 200. */
export async function putSecret(
  url: string,
  headers: Record<string, string>,
  environmentId: string,
  name: string,
  body: PutEnvironmentSecretRequest,
): Promise<Record<string, unknown>> {
  const written = await writeSecret(url, headers, environmentId, name, body);
  expect(written.status, JSON.stringify(written.body)).toBe(200);
  return written.body;
}

/** An Environment (kind `none` unless `recipe` says otherwise) holding `secrets`, by name. */
export async function environmentWithSecrets(
  url: string,
  headers: Record<string, string>,
  id: string,
  secrets: Record<string, PutEnvironmentSecretRequest>,
  recipe: PutEnvironmentRequest = { kind: "none" },
): Promise<void> {
  await putEnvironment(url, headers, id, recipe);
  for (const [name, body] of Object.entries(secrets)) await putSecret(url, headers, id, name, body);
}
