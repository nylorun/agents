import type { StudioTenantInfo } from "@/config";
import type { SettingsSection } from "@/components/app-sidebar";
import { ModelSettings } from "@/components/model-settings";
import { TenantOverview } from "@/components/tenant-overview";

export const SETTINGS_SECTIONS: Readonly<Record<SettingsSection, string>> = {
  overview: "Tenant overview",
  models: "Models",
};

export function settingsSection(pathname: string): SettingsSection | undefined {
  const section = pathname.match(/^\/settings\/([^/]+)\/?$/u)?.[1];
  return section !== undefined && Object.hasOwn(SETTINGS_SECTIONS, section)
    ? (section as SettingsSection)
    : undefined;
}

/**
 * One Tenant settings section; the sidebar navigates between them. Secrets are not here: each
 * Environment holds its own vault, on its page.
 */
export function TenantSettings({
  tenant,
  section,
}: {
  tenant: StudioTenantInfo;
  section: SettingsSection;
}) {
  if (section === "models") return <ModelSettings tenantId={tenant.id} />;
  return <TenantOverview tenant={tenant} />;
}
