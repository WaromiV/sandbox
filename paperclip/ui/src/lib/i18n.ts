/**
 * Minimal i18n. English source strings stay in the code; dictionaries map
 * them per locale. The DEFAULT locale is Russian — a deploy requirement
 * ("must be Russian out of the box"). Switch back to English per browser
 * with: localStorage.setItem("paperclip-locale", "en") + reload.
 *
 * Usage: t("Create issue") — returns the Russian translation when the
 * locale is ru and a dictionary entry exists, else the English source.
 * ponytail: plain lookup table, no ICU/plurals — add a library only when
 * plural forms actually bite.
 */
import { ru } from "../locales/ru";

function resolveLocale(): string {
  try {
    return localStorage.getItem("paperclip-locale") ?? "ru";
  } catch {
    return "ru";
  }
}

export const LOCALE: string = resolveLocale();

export function t(source: string): string {
  if (LOCALE.startsWith("ru")) {
    return ru[source] ?? source;
  }
  return source;
}
