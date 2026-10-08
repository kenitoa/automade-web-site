import type { ContentRecord, Project, SiteLanguage } from "./types";
import { languageChain } from "./languages";
export function siteLanguages(project: Project): SiteLanguage[] {
  return [
    ...new Set([
      project.settings.language,
      ...(project.settings.languages ?? []),
    ]),
  ];
}
export function localizedPath(
  project: Project,
  path: string,
  language: SiteLanguage,
): string {
  return language === project.settings.language
    ? path
    : `/${language}${path === "/" ? "/" : path}`;
}
export function parseLocalizedPath(
  project: Project,
  input: string,
): { path: string; language: SiteLanguage } {
  const normalized = input.replace(/\/$/, "") || "/";
  for (const language of siteLanguages(project))
    if (
      language !== project.settings.language &&
      (normalized === `/${language}` || normalized.startsWith(`/${language}/`))
    )
      return { language, path: normalized.slice(language.length + 1) || "/" };
  return { path: normalized, language: project.settings.language };
}
export function localizeProject(
  project: Project,
  language: SiteLanguage,
): Project {
  if (language === project.settings.language) return project;
  const chain = languageChain(project, language);
  const translation = <T>(
    translations?: Partial<Record<string, T>>,
  ): T | undefined =>
    chain.map((locale) => translations?.[locale]).find(Boolean);
  const translatedRecord = (record: ContentRecord): ContentRecord => ({
    ...record,
    slug: record.localizedSlugs?.[language] ?? record.slug,
    title: translation(record.translations)?.title || record.title,
    body: translation(record.translations)?.body || record.body,
    ...(record.values
      ? {
          values: {
            ...record.values,
            ...translation(record.translations)?.values,
          },
        }
      : {}),
    ...(record.publication
      ? {
          publication: {
            ...record.publication,
            record: translatedRecord(record.publication.record),
          },
        }
      : {}),
  });
  return {
    ...project,
    settings: { ...project.settings, language },
    pages: project.pages.map((page) => ({
      ...page,
      title: translation(page.translations)?.title || page.title,
      description:
        translation(page.translations)?.description || page.description,
    })),
    blocks: project.blocks.map((block) => ({
      ...block,
      props: {
        ...block.props,
        title:
          translation(block.props.translations)?.title || block.props.title,
        body: translation(block.props.translations)?.body || block.props.body,
        primaryAction:
          translation(block.props.translations)?.primaryAction ||
          block.props.primaryAction,
        secondaryAction:
          translation(block.props.translations)?.secondaryAction ||
          block.props.secondaryAction,
        richText: translation(block.props.translations)?.body
          ? undefined
          : block.props.richText,
      },
    })),
    collections: project.collections?.map((collection) => ({
      ...collection,
      records: collection.records.map((record) => ({
        ...translatedRecord(record),
        title: translation(record.translations)?.title || record.title,
        body: translation(record.translations)?.body || record.body,
        ...(record.values
          ? {
              values: {
                ...record.values,
                ...Object.fromEntries(
                  Object.entries(
                    translation(record.translations)?.values ?? {},
                  ).filter(([id]) =>
                    collection.schema?.some(
                      (field) => field.id === id && field.localized,
                    ),
                  ),
                ),
              },
            }
          : {}),
      })),
    })),
  };
}
