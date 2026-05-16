import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { renderEmbedFrame, type EmbedFrameProps } from "./embed-frame.ts";

const BASE_URL = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
  ?.VITE_ISSUES_URL ?? "/issues/") as string;

export type IssuesProps = Pick<EmbedFrameProps, "themeMode" | "themeName">;

export function renderIssues(props: IssuesProps) {
  return html`
    ${renderEmbedFrame({
      baseUrl: BASE_URL,
      title: t("tabs.issues"),
      channel: "issues",
      themeMode: props.themeMode,
      themeName: props.themeName,
    })}
  `;
}
