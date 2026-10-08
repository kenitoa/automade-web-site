import type { Project, SiteLanguage } from "./types";
import { ValidationError } from "./validation";
export function normalizeLanguage(value: unknown): SiteLanguage {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)
  )
    throw new ValidationError("올바른 BCP 47 언어 코드를 입력하세요.");
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    if (!canonical || canonical === "x-default") throw new Error();
    return canonical;
  } catch {
    throw new ValidationError("올바른 BCP 47 언어 코드를 입력하세요.");
  }
}
export function languageLabel(
  language: SiteLanguage,
  displayLanguage: SiteLanguage = language,
): string {
  if (language === "ko") return "한국어";
  if (language === "en") return "English";
  try {
    return (
      new Intl.DisplayNames([displayLanguage], { type: "language" }).of(
        language,
      ) || language
    );
  } catch {
    return language;
  }
}
export function languageChain(
  project: Project,
  language: SiteLanguage,
): SiteLanguage[] {
  const result: string[] = [],
    seen = new Set<string>();
  let current: string | undefined = language;
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = project.settings.languageFallbacks?.[current];
  }
  if (!seen.has(project.settings.language))
    result.push(project.settings.language);
  return result;
}
