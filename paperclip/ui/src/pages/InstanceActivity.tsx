import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { meApi } from "../api/me";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate } from "../lib/utils";

// Cross-company audit timeline. With every worker an instance_admin, the audit
// log is the load-bearing control — this is the "who did what, where" view.
export function InstanceActivity() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Audit Log" }]);
  }, [setBreadcrumbs]);

  const { data: entries, isLoading, error } = useQuery({
    queryKey: ["instance", "activity"],
    queryFn: () => meApi.instanceActivity(200),
  });

  if (isLoading) return <PageSkeleton variant="list" />;

  const rows = entries ?? [];

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {rows.length === 0 && <EmptyState icon={History} message="No activity recorded yet." />}
      {rows.length > 0 && (
        <div className="border border-border text-sm">
          {rows.map((e) => (
            <div key={e.id} className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0">
              <span className="font-mono text-xs text-muted-foreground shrink-0">{e.actorType}:{e.actorId.slice(0, 12)}</span>
              <span className="flex-1 truncate">
                <span className="font-medium">{e.action}</span>{" "}
                <span className="text-muted-foreground">{e.entityType}</span>
              </span>
              {e.companyName && <span className="text-xs text-muted-foreground shrink-0">{e.companyName}</span>}
              <span className="text-xs text-muted-foreground shrink-0">{formatDate(e.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
