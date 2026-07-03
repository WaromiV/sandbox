import { useEffect, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import { t } from "../lib/i18n";
import { meApi } from "../api/me";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";

// The user's personal workspace: an embedded code-server (served per-user at
// /editor by paperclip's container proxy). We ask the server to start the
// container first, then drop the editor into an iframe.
export function MyWorkspace() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("My Workspace") }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    let cancelled = false;
    meApi
      .ensureWorkspace()
      .then((r) => {
        if (cancelled) return;
        if (r.ready) setState("ready");
        else {
          setState("error");
          setError(r.error ?? "workspace not ready");
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setState("error");
        setError(e?.message ?? String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") {
    return <EmptyState icon={MonitorSmartphone} message={t("Starting your workspace…")} />;
  }
  if (state === "error") {
    return <EmptyState icon={MonitorSmartphone} message={`${t("Workspace not ready:")} ${error}`} />;
  }
  return (
    <iframe
      title={t("My Workspace")}
      src="/editor/"
      className="w-full border border-border"
      style={{ height: "calc(100vh - 7rem)" }}
    />
  );
}
