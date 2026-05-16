import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { findSpaceById, getAgentSpaces, type AgentSpace } from "./editor-spaces.ts";
import { renderEmbedFrame, type EmbedFrameProps } from "./embed-frame.ts";

const BASE_URL = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
  ?.VITE_EDITOR_URL ?? "/editor/") as string;

const AGENT_FILES: { label: string; path: string }[] = [
  { label: "AGENTS.md", path: "AGENTS.md" },
  { label: "IDENTITY.md", path: "IDENTITY.md" },
  { label: "SOUL.md", path: "SOUL.md" },
  { label: "TOOLS.md", path: "TOOLS.md" },
  { label: "MEMORY.md", path: "MEMORY.md" },
  { label: "HEARTBEAT.md", path: "HEARTBEAT.md" },
  { label: "USER.md", path: "USER.md" },
  { label: "openclaw.json", path: "openclaw.json" },
];

export type EditorProps = Pick<EmbedFrameProps, "themeMode" | "themeName"> & {
  /** Currently selected agent id (e.g. "viktor"), or null. */
  selectedAgentId: string | null;
  /** Workspace-relative file path open inside the agent's folder. */
  filePath: string | null;
  /** Called when the user picks a different agent chip. */
  onSelectAgent: (id: string) => void;
  /** Called when the user picks a file from the rail. */
  onSelectFile: (filePath: string | null) => void;
};

function renderChips(
  spaces: AgentSpace[],
  activeId: string,
  onSelect: (id: string) => void,
): TemplateResult {
  return html`
    <nav class="iframe-tab__toolbar" aria-label=${t("editor.allAgents")}>
      <span class="iframe-tab__toolbar-label">${t("editor.allAgents")}</span>
      <div class="iframe-tab__chips" role="tablist">
        ${spaces.map(
          (s) => html`
            <button
              type="button"
              role="tab"
              class="iframe-tab__chip ${s.id === activeId ? "iframe-tab__chip--active" : ""}"
              aria-selected=${s.id === activeId ? "true" : "false"}
              @click=${() => onSelect(s.id)}
            >
              ${s.label}
            </button>
          `,
        )}
      </div>
    </nav>
  `;
}

function renderRail(
  space: AgentSpace,
  filePath: string | null,
  onSelectFile: (filePath: string | null) => void,
): TemplateResult {
  return html`
    <div class="editor-rail">
      <section class="editor-rail__section">
        <div class="editor-rail__entity">
          <div class="editor-rail__entity-name">
            <span class="editor-rail__entity-icon" aria-hidden="true">🤖</span>
            <span>${space.label}</span>
          </div>
          <p class="editor-rail__path">${space.folder}</p>
          <ul class="editor-rail__items">
            ${AGENT_FILES.map(
              (item) => html`
                <li>
                  <button
                    type="button"
                    class="editor-rail__item ${filePath === item.path
                      ? "editor-rail__item--active"
                      : ""}"
                    @click=${() => onSelectFile(item.path)}
                  >
                    ${item.label}
                  </button>
                </li>
              `,
            )}
          </ul>
        </div>
        <button type="button" class="editor-rail__reset" @click=${() => onSelectFile(null)}>
          ${t("editor.openFolder")}
        </button>
      </section>
    </div>
  `;
}

export function renderEditor(props: EditorProps) {
  const spaces = getAgentSpaces();
  const active = findSpaceById(props.selectedAgentId) ?? spaces[0] ?? null;
  const activeId = active?.id ?? "";
  const toolbar = renderChips(spaces, activeId, props.onSelectAgent);

  if (!active) {
    return html`
      <section class="iframe-tab" aria-label=${t("tabs.editor")}>
        ${toolbar}
        <p style="padding:24px;color:var(--muted)">${t("editor.pickAgent")}</p>
      </section>
    `;
  }

  return renderEmbedFrame({
    baseUrl: BASE_URL,
    title: active.label,
    channel: `editor:${active.id}:${props.filePath ?? ""}`,
    themeMode: props.themeMode,
    themeName: props.themeName,
    folder: active.folder,
    filePath: props.filePath ?? undefined,
    toolbar,
    sidebar: renderRail(active, props.filePath, props.onSelectFile),
  });
}
