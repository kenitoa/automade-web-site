import type { Project } from "./types";
import { isRecordPublished } from "./cms";
import { publicationRecord } from "./contentState";
import { localizedPath, siteLanguages } from "./localization";

// Below the protocol's 50,000 URL / 50 MiB ceilings, even at the document's URL bounds.
export const SITEMAP_PAGE_SIZE = 10000;
const namespace = "http://www.sitemaps.org/schemas/sitemap/0.9";
const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
interface SitemapUrl {
  path: string;
  modifiedAt: string;
}
/** Enumerate public URLs without serializing private bodies or applying the HTML's 20 record snapshot. */
function* publicUrls(project: Project, now: string): Generator<SitemapUrl> {
  const languages = siteLanguages(project);
  for (const page of project.pages)
    if (page.published && page.access !== "members" && !page.seo?.noIndex)
      for (const language of languages)
        yield {
          path: localizedPath(project, page.path, language),
          modifiedAt: project.updatedAt,
        };
  const home = project.pages.find(
    (page) => page.home && page.published && page.access !== "members",
  );
  if (!home) return;
  for (const collection of project.collections ?? []) {
    if (collection.access === "members") continue;
    for (const item of collection.records.map(publicationRecord))
      if (
        isRecordPublished(
          item,
          now,
          !project.featurePins?.some(
            (pin) => pin.packageId === "automade.content",
          ),
        )
      ) {
        for (const language of languages)
          yield {
            path: localizedPath(
              project,
              `${collection.path === "/" ? "" : collection.path}/${item.localizedSlugs?.[language] ?? item.slug}`,
              language,
            ),
            modifiedAt: item.publishedAt || project.updatedAt,
          };
      }
  }
}
export function sitemapPageCount(
  project: Project,
  now = new Date().toISOString(),
): number {
  if (!project.settings.siteUrl) return 0;
  let count = project.pages.filter(
    (page) => page.published && page.access !== "members" && !page.seo?.noIndex,
  ).length;
  if (
    project.pages.some(
      (page) => page.home && page.published && page.access !== "members",
    )
  )
    for (const collection of project.collections ?? [])
      if (collection.access !== "members")
        for (const record of collection.records)
          if (
            isRecordPublished(
              record,
              now,
              !project.featurePins?.some(
                (pin) => pin.packageId === "automade.content",
              ),
            )
          )
            count++;
  return Math.ceil((count * siteLanguages(project).length) / SITEMAP_PAGE_SIZE);
}
export function sitemapPage(
  project: Project,
  page: number,
  now = new Date().toISOString(),
): string {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new RangeError("Sitemap page must be a positive integer.");
  if (page > Math.max(1, sitemapPageCount(project, now)))
    throw new RangeError("Sitemap page does not exist.");
  const start = (page - 1) * SITEMAP_PAGE_SIZE,
    entries: string[] = [];
  let position = 0;
  if (project.settings.siteUrl)
    for (const url of publicUrls(project, now)) {
      if (position++ < start) continue;
      const canonical = `${project.settings.siteUrl}${url.path}`;
      entries.push(
        `<url><loc>${xml(canonical)}</loc><lastmod>${xml(url.modifiedAt)}</lastmod></url>`,
      );
      if (entries.length === SITEMAP_PAGE_SIZE) break;
    }
  if (page > 1 && !entries.length)
    throw new RangeError("Sitemap page does not exist.");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${namespace}">${entries.join("")}</urlset>`;
}
export function sitemap(
  project: Project,
  now = new Date().toISOString(),
): string {
  const pages = sitemapPageCount(project, now);
  if (pages <= 1) return sitemapPage(project, 1, now);
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="${namespace}">${Array.from({ length: pages }, (_, index) => `<sitemap><loc>${xml(`${project.settings.siteUrl}/sitemaps/${index + 1}.xml`)}</loc></sitemap>`).join("")}</sitemapindex>`;
}
/** One pass keeps a large export from repeatedly rescanning earlier sitemap pages. */
export function* sitemapArtifacts(
  project: Project,
  now = new Date().toISOString(),
): Generator<{ path: string; content: string }> {
  yield { path: "sitemap.xml", content: sitemap(project, now) };
  if (sitemapPageCount(project, now) <= 1) return;
  let entries: string[] = [],
    page = 1;
  for (const url of publicUrls(project, now)) {
    entries.push(
      `<url><loc>${xml(`${project.settings.siteUrl}${url.path}`)}</loc><lastmod>${xml(url.modifiedAt)}</lastmod></url>`,
    );
    if (entries.length === SITEMAP_PAGE_SIZE) {
      yield {
        path: `sitemaps/${page++}.xml`,
        content: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${namespace}">${entries.join("")}</urlset>`,
      };
      entries = [];
    }
  }
  if (entries.length)
    yield {
      path: `sitemaps/${page}.xml`,
      content: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${namespace}">${entries.join("")}</urlset>`,
    };
}
