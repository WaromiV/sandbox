import { html } from "lit";
import { ref, createRef, type Ref } from "lit/directives/ref.js";
import type { ResolvedTheme } from "../theme.ts";

export type EmbedFrameProps = {
  baseUrl: string;
  title: string;
  channel: string;
  themeMode: ResolvedTheme;
  themeName: string;
  /** Optional folder/path the embedded app should open (e.g. code-server `?folder=`). */
  folder?: string;
  /** Optional file path (workspace-relative) to open inside the folder. */
  filePath?: string;
  /** Optional slot rendered above the iframe (e.g. a chip strip selector). */
  toolbar?: unknown;
  /** Optional left rail slot rendered next to the iframe. */
  sidebar?: unknown;
};

function resolveBinaryMode(themeMode: ResolvedTheme): "light" | "dark" {
  // ResolvedTheme is a union of variants like "openknot-light" / "custom" /
  // "dark" — normalise to the binary hint embedded apps care about.
  return themeMode === "light" || themeMode.endsWith("-light") ? "light" : "dark";
}

type FrameState = {
  iframeRef: Ref<HTMLIFrameElement>;
  lastPostedKey: string;
  loadHandler: ((event: Event) => void) | null;
};

const STATE_BY_CHANNEL = new Map<string, FrameState>();

function getState(channel: string): FrameState {
  let state = STATE_BY_CHANNEL.get(channel);
  if (!state) {
    state = {
      iframeRef: createRef<HTMLIFrameElement>(),
      lastPostedKey: "",
      loadHandler: null,
    };
    STATE_BY_CHANNEL.set(channel, state);
  }
  return state;
}

function buildSrc(props: EmbedFrameProps): string {
  const url = new URL(props.baseUrl, window.location.origin);
  // Hints for embedded apps that read query params (e.g. paperclip, future patches).
  // Kept stable so the iframe reloads only when the resolved value actually changes.
  url.searchParams.set("theme", resolveBinaryMode(props.themeMode));
  if (props.themeName) {
    url.searchParams.set("themeName", props.themeName);
  }
  url.searchParams.set("embeddedBy", "openclaw");
  if (props.folder) {
    // code-server reads `?folder=` to open a specific directory on launch.
    url.searchParams.set("folder", props.folder);
    if (props.filePath) {
      // Use VS Code's web `payload` to instruct the workbench to open the
      // file once the folder is loaded. Payload format is a JSON array of
      // `[command, ...args]` tuples.
      const absolute = `${props.folder.replace(/\/$/, "")}/${props.filePath.replace(/^\//, "")}`;
      const fileUri = `vscode-remote://.${absolute}`;
      url.searchParams.set("payload", JSON.stringify([["openFile", fileUri]]));
    }
  }
  return url.toString();
}

function postTheme(frame: HTMLIFrameElement | undefined, props: EmbedFrameProps) {
  const win = frame?.contentWindow;
  if (!win) {
    return;
  }
  try {
    win.postMessage(
      {
        type: "openclaw:theme",
        mode: resolveBinaryMode(props.themeMode),
        resolved: props.themeMode,
        name: props.themeName,
      },
      "*",
    );
  } catch {
    // Cross-origin postMessage with "*" never throws on modern browsers, but
    // we swallow defensively in case the contentWindow was nulled.
  }
}

export function renderEmbedFrame(props: EmbedFrameProps) {
  const state = getState(props.channel);
  const src = buildSrc(props);

  // The iframe only reloads when the URL actually changes (Lit diffs the
  // attribute). On theme changes that flip mode, the URL diff triggers a
  // natural reload — the embedded app re-reads its query param on boot.
  if (state.lastPostedKey !== `${props.themeMode}|${props.themeName}`) {
    state.lastPostedKey = `${props.themeMode}|${props.themeName}`;
    // Also push theme via postMessage in case the embedded app prefers a
    // live update over a reload.
    queueMicrotask(() => postTheme(state.iframeRef.value, props));
  }

  const onLoad = () => postTheme(state.iframeRef.value, props);

  const binaryMode = resolveBinaryMode(props.themeMode);
  const iframe = html`
    <iframe
      ${ref(state.iframeRef)}
      class="iframe-tab__frame"
      src=${src}
      title=${props.title}
      allow="clipboard-read; clipboard-write; fullscreen"
      referrerpolicy="same-origin"
      @load=${onLoad}
    ></iframe>
  `;
  return html`
    <section class="iframe-tab" aria-label=${props.title} data-theme-mode=${binaryMode}>
      ${props.toolbar ?? ""}
      ${props.sidebar
        ? html`
            <div class="iframe-tab__body">
              <aside class="iframe-tab__rail">${props.sidebar}</aside>
              ${iframe}
            </div>
          `
        : iframe}
    </section>
  `;
}
