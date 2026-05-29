import { resolveControlUiAuthHeader } from "../control-ui-auth.ts";

/**
 * Drives the "Update from OpenClaw UI" stack updater over HTTP (POST
 * <base>/update/run, GET <base>/update/status). Unlike most controllers this
 * uses raw fetch rather than the WS client: the worker is detached and may
 * outlive the socket (openclaw restarts itself), and status must survive that
 * window via the polled JSON file.
 */

export type StackUpdateComponentState = {
  state: string;
  fromRunId: string | null;
  toRunId: string | null;
};

export type StackUpdateStatus = {
  phase: string;
  runId?: string | null;
  launchMethod?: string;
  changed?: string[];
  components?: Record<string, StackUpdateComponentState>;
  error?: { reason?: string; message?: string; component?: string } | null;
  rollback?: { component?: string; outcome?: string; restoredTarget?: string | null } | null;
  runtime?: { euid?: number | null; requiresSudoPassword?: boolean };
};

const TERMINAL_PHASES = new Set(["done", "error", "idle"]);

export type StackUpdateUiState = {
  basePath?: string;
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
  stackUpdateBusy: boolean;
  stackUpdateStatus: StackUpdateStatus | null;
  stackUpdateError: string | null;
  stackUpdatePassword: string;
  stackUpdatePollInterval?: number | null;
};

const POLL_INTERVAL_MS = 2000;

function clearPolling(state: StackUpdateUiState): void {
  if (state.stackUpdatePollInterval != null) {
    clearTimeout(state.stackUpdatePollInterval);
    state.stackUpdatePollInterval = null;
  }
}

// Self-scheduling poll loop: keeps polling until the worker reports a terminal
// phase (or vanishes). Tolerant of the gateway briefly disappearing while
// openclaw restarts itself.
function drivePolling(state: StackUpdateUiState): void {
  clearPolling(state);
  const tick = async () => {
    await pollStackUpdateStatus(state);
    if (state.stackUpdateBusy) {
      state.stackUpdatePollInterval = window.setTimeout(tick, POLL_INTERVAL_MS);
    } else {
      state.stackUpdatePollInterval = null;
    }
  };
  state.stackUpdatePollInterval = window.setTimeout(tick, POLL_INTERVAL_MS);
}

function authHeaders(state: StackUpdateUiState): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const auth = resolveControlUiAuthHeader(state);
  if (auth) {
    headers.Authorization = auth;
  }
  return headers;
}

function baseUrl(state: StackUpdateUiState): string {
  return (state.basePath ?? "").replace(/\/$/, "");
}

/** Kick off an update. On success the caller should start status polling. */
export async function startStackUpdate(state: StackUpdateUiState): Promise<void> {
  if (state.stackUpdateBusy) {
    return;
  }
  state.stackUpdateBusy = true;
  state.stackUpdateError = null;
  try {
    const password = state.stackUpdatePassword.trim();
    const res = await fetch(`${baseUrl(state)}/update/run`, {
      method: "POST",
      headers: { ...authHeaders(state), "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(password ? { sudoPassword: password } : {}),
    });
    const body: {
      status?: StackUpdateStatus;
      error?: { message?: string };
    } | null = await res.json().catch(() => null);

    if (res.status === 202) {
      // Accepted — drop the password from memory and start polling status.
      state.stackUpdatePassword = "";
      state.stackUpdateStatus = { phase: "running" };
      drivePolling(state);
      return;
    }
    if (res.status === 409) {
      state.stackUpdateStatus = body?.status ?? { phase: "running" };
      state.stackUpdateError = "An update is already in progress.";
      state.stackUpdateBusy = false;
      return;
    }
    state.stackUpdateError =
      body?.error?.message ?? `Update request failed (HTTP ${res.status}).`;
    state.stackUpdateBusy = false;
  } catch (err) {
    state.stackUpdateError = String(err);
    state.stackUpdateBusy = false;
  }
}

/** Poll status once; flips `stackUpdateBusy` off when the worker reaches a terminal phase. */
export async function pollStackUpdateStatus(state: StackUpdateUiState): Promise<void> {
  try {
    const res = await fetch(`${baseUrl(state)}/update/status`, {
      headers: authHeaders(state),
      credentials: "same-origin",
    });
    if (!res.ok) {
      // The gateway is briefly unreachable while openclaw restarts itself —
      // treat as transient and keep polling rather than surfacing an error.
      return;
    }
    const status = (await res.json()) as StackUpdateStatus;
    state.stackUpdateStatus = status;
    if (TERMINAL_PHASES.has(status.phase)) {
      state.stackUpdateBusy = false;
      if (status.phase === "error") {
        state.stackUpdateError =
          status.error?.message ?? status.error?.reason ?? "Update failed.";
      }
    } else {
      state.stackUpdateBusy = true;
    }
  } catch {
    // Transient network failure (likely the self-restart); keep polling.
  }
}
