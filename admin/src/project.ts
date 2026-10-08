/**
 * The local machine's Nylorun files (`@nylorun/admin/project`, Node only): the Nylorun home, a
 * local Tenant's Host root, the Project root, and the Project link and credentials, validated
 * with Core's schemas. It is `@nylorun/core/project`, for operator tools that depend on this
 * package and not on Core (`nylo`); `createAdmin` resolves the Project link with it.
 */
export * from "@nylorun/core/project";
