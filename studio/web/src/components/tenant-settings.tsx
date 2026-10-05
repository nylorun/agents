import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { StudioTenantInfo } from "@/config";
import { ModelSettings } from "@/components/model-settings";
import { TenantOverview } from "@/components/tenant-overview";
import { VaultModule } from "@/components/vault";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function TenantSettings({ tenant }: { tenant: StudioTenantInfo }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const section = pathname.slice("/settings/".length);
  if (!["overview", "models", "credentials"].includes(section))
    return <Navigate to="/settings/overview" replace />;
  return (
    <Tabs
      value={section}
      onValueChange={(value) => void navigate(`/settings/${value}`)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="mx-auto w-full max-w-4xl px-8 pt-6">
        <TabsList aria-label="Tenant settings">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="overview" className="flex min-h-0 flex-col">
        <TenantOverview tenant={tenant} />
      </TabsContent>
      <TabsContent value="models" className="flex min-h-0 flex-col">
        <ModelSettings tenantId={tenant.id} />
      </TabsContent>
      <TabsContent value="credentials" className="flex min-h-0 flex-col">
        <VaultModule tenantId={tenant.id} />
      </TabsContent>
    </Tabs>
  );
}
