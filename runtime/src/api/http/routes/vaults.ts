/**
 * Vaults and their credentials (`/v1/tenant/vaults/**`, the Management API, protocol 8): secrets
 * a session's tools use. Only a management key (or Studio's key, acting as itself) reaches these
 * routes; an application key is `403 key_role_mismatch`, and nothing acts for a subject here. The
 * installation's own vaults (`scope: "installation"`) attach to any session (`vaultIds`); a vault
 * of one person (`ownerUserId`) attaches only to that person's sessions.
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
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

/** The Management API's vault routes (`/v1/tenant/vaults`): a management key. */
const MANAGEMENT: RouteAccess = { credentials: ["management"], scopes: "never" };
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

/** The vault routes under `base` (`/v1/tenant/vaults`). */
function vaultRoutesAt(api: OpenAPIHono<TenantEnv>, base: string, access: RouteAccess): void {
  tenantRoute(
    api,
    access,
    {
      method: "post",
      path: `${base}`,
      tags: ["Vaults"],
      summary: "Create a vault",
      description:
        "With `scope: \"installation\"` the installation's own vault, owned by `installation`, which any session may attach; or a vault of one person (`ownerUserId`), which only that person's sessions attach.",
      request: { body: body(CreateVaultRequest) },
      responses: {
        200: json(VaultInfo, "The vault"),
        409: { description: "The idempotency key was used for another vault" },
      },
    },
    async (c) => {
      const request = CreateVaultRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(200, await c.env.tenant.vault.createVault(request));
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}`,
      tags: ["Vaults"],
      summary: "List vaults",
      description:
        "The installation vaults, after the vaults of `ownerUserId` when it names a person.",
      request: {
        query: z.object({
          ownerUserId: z
            .string()
            .optional()
            .meta({ description: "Also list this person's vaults" }),
        }),
      },
      responses: { 200: json(ListVaultsResponse, "The vaults") },
    },
    async (c) => {
      return jsonResponse(200, {
        vaults: await c.env.tenant.vault.listVaults(c.req.query("ownerUserId"), {
          installation: true,
        }),
      });
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}/{vaultId}`,
      tags: ["Vaults"],
      summary: "Get a vault",
      request: { params: vaultId },
      responses: { 200: json(VaultInfo, "The vault") },
    },
    async (c) => {
      return jsonResponse(200, await c.env.tenant.vault.getVault(c.req.param("vaultId")!));
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "delete",
      path: `${base}/{vaultId}`,
      tags: ["Vaults"],
      summary: "Delete a vault and its credentials",
      request: { params: vaultId },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      return jsonResponse(200, await c.env.tenant.vault.deleteVault(c.req.param("vaultId")!));
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "post",
      path: `${base}/{vaultId}/credentials`,
      tags: ["Vaults"],
      summary: "Add a credential",
      description:
        "A bearer token, bound to the URL a tool may send it to.",
      request: { params: vaultId, body: body(CreateCredentialRequest) },
      responses: { 200: json(CredentialInfo, "The credential, without its secret") },
    },
    async (c) => {
      const request = CreateCredentialRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(
        200,
        await c.env.tenant.keys.createCredential(c.req.param("vaultId")!, request),
      );
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}/{vaultId}/credentials`,
      tags: ["Vaults"],
      summary: "List a vault's credentials",
      request: { params: vaultId },
      responses: { 200: json(ListCredentialsResponse, "The credentials, without their secrets") },
    },
    async (c) => {
      return jsonResponse(200, {
        credentials: await c.env.tenant.vault.listCredentials(c.req.param("vaultId")!),
      });
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "get",
      path: `${base}/{vaultId}/credentials/{credentialId}`,
      tags: ["Vaults"],
      summary: "Get a credential",
      request: { params: credentialId },
      responses: { 200: json(CredentialInfo, "The credential, without its secret") },
    },
    async (c) => {
      return jsonResponse(
        200,
        await c.env.tenant.vault.getCredential(c.req.param("vaultId")!, c.req.param("credentialId")!),
      );
    },
  );

  tenantRoute(
    api,
    access,
    {
      method: "post",
      path: `${base}/{vaultId}/credentials/{credentialId}`,
      tags: ["Vaults"],
      summary: "Rotate a credential's secret",
      request: { params: credentialId, body: body(RotateCredentialRequest) },
      responses: {
        200: json(CredentialInfo, "The credential"),
        409: { description: "A credential's type cannot change" },
      },
    },
    async (c) => {
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
    access,
    {
      method: "delete",
      path: `${base}/{vaultId}/credentials/{credentialId}`,
      tags: ["Vaults"],
      summary: "Delete a credential",
      request: { params: credentialId },
      responses: { 200: json(DeletedResponse, "Deleted") },
    },
    async (c) => {
      return jsonResponse(
        200,
        await c.env.tenant.vault.deleteCredential(c.req.param("vaultId")!, c.req.param("credentialId")!),
      );
    },
  );
}

export function vaultRoutes(api: OpenAPIHono<TenantEnv>): void {
  vaultRoutesAt(api, "/v1/tenant/vaults", MANAGEMENT);
}
