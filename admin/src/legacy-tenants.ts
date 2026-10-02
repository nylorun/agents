/**
 * The Admin Tenant routes' answers (`/v1/admin/tenants*`) of a protocol 4 Host. A protocol 5
 * Host serves one Tenant and has no such routes (it answers them 404); `@nylorun/core` no
 * longer defines these shapes.
 *
 * @deprecated Kept only for `listTenants`, `getTenant`, `deleteTenant` and `createTenant`,
 * which go with them in the next client release (one Tenant per installation, F2b).
 */
import { z } from "zod";
import { TenantEnvelopeSchema } from "@nylorun/core/contracts";

/** @deprecated See the module comment. */
export const AdminTenantSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable(),
    state: z.enum(["open", "quarantined"]),
    envelope: TenantEnvelopeSchema.nullable(),
  })
  .strict();
/** @deprecated See the module comment. */
export type AdminTenant = z.infer<typeof AdminTenantSchema>;

/** @deprecated See the module comment. */
export const AdminTenantStatusSchema = AdminTenantSchema.extend({
  quarantine: z
    .object({ code: z.string(), message: z.string(), repair: z.string() })
    .strict()
    .optional(),
});
/** @deprecated See the module comment. */
export type AdminTenantStatus = z.infer<typeof AdminTenantStatusSchema>;
