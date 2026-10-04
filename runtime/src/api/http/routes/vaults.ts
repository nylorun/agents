/**
 * Vaults and their credentials (`/v1/vaults/**`): secrets a session's tools use, owned by one
 * person, or by the installation (`scope: "installation"`, any session may attach one). Acting
 * for a subject reaches only the subject's own vaults, and never on another's behalf; only an
 * application key acting for no one creates, lists or changes installation vaults.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
  CreateCredentialRequestSchema,
  CreateVaultRequestSchema,
  RotateCredentialRequestSchema,
} from "@nylorun/core/contracts";
import {
  CreateCredentialRequest,
  CreateVaultRequest,
  CredentialInfo,
  DeletedResponse,
  ListCredentialsResponse,
  ListVaultsResponse,
  RotateCredentialRequest,
  VaultInfo,
} from "../../components.js";
import { ownerOf } from "../../../tenant/auth.js";
import { fail } from "../../../tenant/http.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { pathSegments, tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const OWN_VAULTS: RouteAccess = {
  credentials: ["application", "subject", "token"],
  scopes: ["vaults:own"],
  browser: true,
};

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});
const vaultId = z.object({ vaultId: z.string() });
const credentialId = vaultId.extend({ credentialId: z.string() });

/**
 * Who a vault route acts for: the subject, or no one in particular (an application key). Below
 * a vault, the vault must be the subject's before anything else.
 */
async function ownerFor(c: Context<TenantEnv>): Promise<string | undefined> {
  const { vault } = c.env.tenant;
  const owner = ownerOf(c.get("scope"));
  const id = c.req.param("vaultId");
  if (id !== undefined && owner !== undefined) await vault.assertOwner(id, owner);
  return owner;
}

export function vaultRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "post",
      path: "/v1/vaults",
      tags: ["Vaults"],
      summary: "Create a vault",
      description:
        "A person's vault (`ownerUserId`), or with `scope: \"installation\"` the installation's own vault, owned by `installation`, which any session may attach. Only an application key acting for no one creates an installation vault.",
      request: { body: body(CreateVaultRequest) },
      responses: {
        200: json(VaultInfo, "The vault"),
        409: { description: "The idempotency key was used for another vault" },
      },
    },
    async (c) => {
      const owner = await ownerFor(c);
      const request = CreateVaultRequestSchema.parse(await readJson(c.req.raw));
      if (request.scope === "installation" && c.get("scope").kind !== "application")
        fail(403, "Only an application key acting for no one creates an installation vault", {
          code: "scope_required",
        });
      if (owner !== undefined && request.ownerUserId !== owner)
        fail(403, "ownerUserId must be the subject");
      return jsonResponse(200, await c.env.tenant.vault.createVault(request));
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "get",
      path: "/v1/vaults",
      tags: ["Vaults"],
      summary: "List a person's vaults",
      description:
        "A person's vaults. An application key acting for no one also gets the installation vaults, after the person's, and gets only those without `ownerUserId`.",
      request: {
        query: z.object({
          ownerUserId: z
            .string()
            .optional()
            .meta({ description: "Whose vaults; an application key acting for no one may leave it out" }),
        }),
      },
      responses: { 200: json(ListVaultsResponse, "The vaults") },
    },
    async (c) => {
      const owner = await ownerFor(c);
      const application = c.get("scope").kind === "application";
      const ownerUserId = c.req.query("ownerUserId") ?? owner;
      if (ownerUserId === undefined && !application) fail(400, "ownerUserId is required");
      if (owner !== undefined && ownerUserId !== owner)
        fail(403, "ownerUserId must be the subject");
      return jsonResponse(200, {
        vaults: await c.env.tenant.vault.listVaults(ownerUserId, { installation: application }),
      });
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "get",
      path: "/v1/vaults/{vaultId}",
      tags: ["Vaults"],
      summary: "Get a vault",
      request: { params: vaultId },
      responses: { 200: json(VaultInfo, "The vault") },
    },
    async (c) => {
      await ownerFor(c);
      return jsonResponse(200, await c.env.tenant.vault.getVault(c.req.param("vaultId")!));
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "delete",
      path: "/v1/vaults/{vaultId}",
      tags: ["Vaults"],
      summary: "Delete a vault and its credentials",
      request: { params: vaultId },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      await ownerFor(c);
      return jsonResponse(200, await c.env.tenant.vault.deleteVault(c.req.param("vaultId")!));
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "post",
      path: "/v1/vaults/{vaultId}/credentials",
      tags: ["Vaults"],
      summary: "Add a credential",
      description:
        "A bearer token or OAuth tokens, bound to the URLs a tool may send them to. A subject token cannot store OAuth refresh credentials.",
      request: { params: vaultId, body: body(CreateCredentialRequest) },
      responses: { 200: json(CredentialInfo, "The credential, without its secret") },
    },
    async (c) => {
      await ownerFor(c);
      const request = CreateCredentialRequestSchema.parse(await readJson(c.req.raw));
      // The Runtime calls a refresh credential's token endpoint itself: never for a browser.
      if (
        c.get("scope").kind === "token" &&
        request.auth.type === "oauth" &&
        request.auth.refresh
      )
        fail(403, "A subject token cannot store OAuth refresh credentials", {
          code: "scope_required",
        });
      return jsonResponse(
        200,
        await c.env.tenant.keys.createCredential(c.req.param("vaultId")!, request),
      );
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "get",
      path: "/v1/vaults/{vaultId}/credentials",
      tags: ["Vaults"],
      summary: "List a vault's credentials",
      request: { params: vaultId },
      responses: { 200: json(ListCredentialsResponse, "The credentials, without their secrets") },
    },
    async (c) => {
      await ownerFor(c);
      return jsonResponse(200, {
        credentials: await c.env.tenant.vault.listCredentials(c.req.param("vaultId")!),
      });
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "get",
      path: "/v1/vaults/{vaultId}/credentials/{credentialId}",
      tags: ["Vaults"],
      summary: "Get a credential",
      request: { params: credentialId },
      responses: { 200: json(CredentialInfo, "The credential, without its secret") },
    },
    async (c) => {
      await ownerFor(c);
      return jsonResponse(
        200,
        await c.env.tenant.vault.getCredential(c.req.param("vaultId")!, c.req.param("credentialId")!),
      );
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "post",
      path: "/v1/vaults/{vaultId}/credentials/{credentialId}",
      tags: ["Vaults"],
      summary: "Rotate a credential's secret",
      request: { params: credentialId, body: body(RotateCredentialRequest) },
      responses: {
        200: json(CredentialInfo, "The credential"),
        409: { description: "A credential's type cannot change" },
      },
    },
    async (c) => {
      await ownerFor(c);
      const request = RotateCredentialRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(
        200,
        await c.env.tenant.keys.rotateCredential(
          c.req.param("vaultId")!,
          c.req.param("credentialId")!,
          request,
        ),
      );
    },
  );

  tenantRoute(
    api,
    OWN_VAULTS,
    {
      method: "delete",
      path: "/v1/vaults/{vaultId}/credentials/{credentialId}",
      tags: ["Vaults"],
      summary: "Delete a credential",
      request: { params: credentialId },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      await ownerFor(c);
      return jsonResponse(
        200,
        await c.env.tenant.vault.deleteCredential(c.req.param("vaultId")!, c.req.param("credentialId")!),
      );
    },
  );
}
