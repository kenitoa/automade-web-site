import type { Project, SiteLanguage } from "./types";
import { contentPath, findContent, publishedRecords } from "./content";
import { localizedPath, siteLanguages } from "./localization";
import { languageChain } from "./languages";

/** Works with the sanitized public projection, which has no private record slugs. */
export function isMemberContentPath(project: Project, path: string): boolean {
  return (project.collections ?? []).some(
    (collection) =>
      collection.access === "members" && path.startsWith(`${collection.path}/`),
  );
}

export function pageMetadata(
  project: Project,
  pageId?: string,
  contentRoute?: string,
  language: SiteLanguage = project.settings.language,
): {
  title: string;
  description: string;
  canonical: string;
  image: string;
  imageAssetId: string;
  noIndex: boolean;
  path: string;
} {
  const page =
    project.pages.find((p) => p.id === pageId) ??
    project.pages.find((p) => p.home)!;
  const content = contentRoute ? findContent(project, contentRoute) : undefined;
  const protectedContent = Boolean(
    contentRoute && isMemberContentPath(project, contentRoute),
  );
  const basePath = content
    ? contentPath(content.collection, content.record, language)
    : protectedContent
      ? contentRoute!
      : page.path;
  const path = localizedPath(project, basePath, language);
  const translation = languageChain(project, language)
    .map((candidate) => page.translations?.[candidate])
    .find(Boolean);
  const contentTranslation = languageChain(project, language)
    .map((candidate) => content?.record.translations?.[candidate])
    .find(Boolean);
  const title = content
    ? `${contentTranslation?.title || content.record.title} · ${project.name}`
    : protectedContent
      ? `${language === "en" ? "Member content" : "회원 전용 콘텐츠"} · ${project.name}`
      : translation?.title ||
        page.seo?.title ||
        (page.home ? project.name : `${page.title} · ${project.name}`);
  const description = content
    ? (contentTranslation?.body || content.record.body).slice(0, 200)
    : protectedContent
      ? language === "en"
        ? "Sign in to view member content."
        : "로그인하면 회원 콘텐츠를 볼 수 있습니다."
      : translation?.description ||
        page.seo?.description ||
        page.description ||
        project.settings.description;
  const imageAssetId =
    protectedContent || page.access === "members"
      ? ""
      : content?.record.imageId || page.seo?.imageAssetId || "";
  const image = project.assets.find((a) => a.id === imageAssetId)?.data ?? "";
  return {
    title,
    description,
    path,
    canonical: project.settings.siteUrl
      ? `${project.settings.siteUrl}${path}`
      : "",
    image,
    imageAssetId,
    noIndex:
      protectedContent ||
      (!content && (page.access === "members" || Boolean(page.seo?.noIndex))),
  };
}
export function pageImageUrl(
  project: Project,
  metadata: ReturnType<typeof pageMetadata>,
): string {
  const asset = project.assets.find(
    (candidate) => candidate.id === metadata.imageAssetId,
  );
  return project.settings.siteUrl && asset
    ? `${project.settings.siteUrl}/assets/share-${asset.id}.${asset.mime.split("/")[1]}`
    : "";
}
export function pageStructuredData(
  project: Project,
  metadata: ReturnType<typeof pageMetadata>,
  language: SiteLanguage = project.settings.language,
): Record<string, string> {
  const image = pageImageUrl(project, metadata);
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: metadata.title,
    description: metadata.description,
    inLanguage: language,
    ...(metadata.canonical ? { url: metadata.canonical } : {}),
    ...(image ? { image } : {}),
  };
}
export function siteRoutes(project: Project): Array<{
  path: string;
  pageId: string;
  contentPath?: string;
  noIndex: boolean;
  language: SiteLanguage;
}> {
  const pages: Array<{
    path: string;
    pageId: string;
    contentPath?: string;
    noIndex: boolean;
    language: SiteLanguage;
  }> = project.pages
    .filter((page) => page.published)
    .map((page) => ({
      path: page.path,
      pageId: page.id,
      noIndex: page.access === "members" || Boolean(page.seo?.noIndex),
      language: project.settings.language,
    }));
  const home = project.pages.find((p) => p.home && p.published);
  return [
    ...pages,
    ...(project.collections ?? [])
      .filter(() => Boolean(home))
      .flatMap((collection) =>
        publishedRecords(collection, project)
          .slice(0, collection.queryMode === "server" ? 20 : undefined)
          .map((record) => ({
            path: contentPath(collection, record),
            contentPath: contentPath(collection, record),
            pageId: home!.id,
            noIndex: collection.access === "members",
            language: project.settings.language,
          })),
      ),
  ].flatMap((route) =>
    siteLanguages(project).map((language) => ({
      ...route,
      path: localizedPath(
        project,
        route.contentPath
          ? (() => {
              const content = findContent(project, route.contentPath);
              return content
                ? contentPath(content.collection, content.record, language)
                : route.path;
            })()
          : route.path,
        language,
      ),
      ...(route.contentPath
        ? {
            contentPath: (() => {
              const content = findContent(project, route.contentPath);
              return content
                ? contentPath(content.collection, content.record, language)
                : route.contentPath;
            })(),
          }
        : {}),
      language,
    })),
  );
}
export function alternateLinks(
  project: Project,
  pageId?: string,
  contentRoute?: string,
): Array<{ language: SiteLanguage | "x-default"; href: string }> {
  if (!project.settings.siteUrl) return [];
  return [
    ...siteLanguages(project).map((language) => ({
      language,
      href: pageMetadata(project, pageId, contentRoute, language).canonical,
    })),
    {
      language: "x-default",
      href: pageMetadata(
        project,
        pageId,
        contentRoute,
        project.settings.language,
      ).canonical,
    },
  ];
}
export {
  sitemap,
  sitemapPage,
  sitemapPageCount,
  sitemapArtifacts,
} from "./sitemaps";
export function robots(project: Project): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n${project.settings.siteUrl ? `Sitemap: ${project.settings.siteUrl}/sitemap.xml\n` : ""}`;
}
