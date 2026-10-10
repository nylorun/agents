import type { StudioTenantInfo } from "@/config";
import type { SettingsSection } from "@/components/app-sidebar";
import { ModelSettings } from "@/components/model-settings";
import { TenantOverview } from "@/components/tenant-overview";
import { VaultModule } from "@/components/vault";

export const SETTINGS_SECTIONS: Readonly<Record<SettingsSection, string>> = {
  overview: "Tenant overview",
  models: "Models",
  credentials: "Credentials",
};

export function settingsSection(pathname: string): SettingsSection | undefined {
  const section = pathname.match(/^\/settings\/([^/]+)\/?$/u)?.[1];
  return section !== undefined && Object.hasOwn(SETTINGS_SECTIONS, section)
    ? (section as SettingsSection)
    : undefined;
}

/** One Tenant settings section; the sidebar navigates between them. */
export function TenantSettings({
  tenant,
  section,
}: {
  tenant: StudioTenantInfo;
  section: SettingsSection;
}) {
  if (section === "models") return <ModelSettings tenantId={tenant.id} />;
  if (section === "credentials") return <VaultModule tenantId={tenant.id} />;
  return <TenantOverview tenant={tenant} />;
}
