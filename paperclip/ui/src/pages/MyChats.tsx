import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { t } from "../lib/i18n";
import { meApi } from "../api/me";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { StatusIcon } from "../components/StatusIcon";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate } from "../lib/utils";

// Cross-company "my chats": every issue this user created, is assigned to,
// commented on, or read — across all their companies. Links are absolute
// (company-prefixed) since the rows span companies.
export function MyChats() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: t("My Chats") }]);
  }, [setBreadcrumbs]);

  const { data: chats, isLoading, error } = useQuery({
    queryKey: ["me", "issues"],
    queryFn: () => meApi.issues(200),
  });

  if (isLoading) return <PageSkeleton variant="list" />;

  const rows = (chats ?? []).filter((i) => !["done", "cancelled"].includes(i.status));

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {rows.length === 0 && <EmptyState icon={MessagesSquare} message={t("No chats yet.")} />}
      {rows.length > 0 && (
        <div className="border border-border">
          {rows.map((issue) => {
            const ref = issue.identifier ?? issue.id;
            const href = issue.companyPrefix ? `/${issue.companyPrefix}/issues/${ref}` : `/issues/${ref}`;
            return (
              <a
                key={issue.id}
                href={href}
                className="flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-muted/50"
              >
                <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                <span className="flex-1 truncate text-sm">{issue.title}</span>
                {issue.companyName && (
                  <span className="text-xs text-muted-foreground shrink-0">{issue.companyName}</span>
                )}
                <span className="text-xs text-muted-foreground shrink-0">{formatDate(issue.createdAt)}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
