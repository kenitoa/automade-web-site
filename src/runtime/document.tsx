import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import SiteApp from "./SiteApp";
import { safeJson } from "../domain/validation";
import { publicProject } from "../domain/publication";
import { findContent } from "../domain/content";
import { publicContentRecord } from "../domain/cms";
export { publicProject } from "../domain/publication";
import type { Project, SiteLanguage } from "../domain/types";
import {
  alternateLinks,
  pageImageUrl,
  pageMetadata,
  pageStructuredData,
} from "../domain/seo";
export {
  sitemap,
  sitemapPage,
  sitemapPageCount,
  sitemapArtifacts,
  robots,
  siteRoutes,
} from "../domain/seo";
export { parseProject, inspectProject } from "../domain/validation";
export {
  verifyPackageIntegrity,
  preflightProject,
  blockEnvironmentIssues,
} from "../domain/packages";
const escape = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function html(
  project: Project,
  pageId?: string,
  contentPath?: string,
  language: SiteLanguage = project.settings.language,
): string {
  const original = project;
  const selected = contentPath ? findContent(project, contentPath) : undefined;
  project = publicProject(project);
  if (selected && selected.collection.access !== "members") {
    const collection = project.collections?.find(
      (item) => item.id === selected.collection.id,
    );
    if (
      collection &&
      !collection.records.some((item) => item.id === selected.record.id)
    )
      collection.records.push(
        publicContentRecord(selected.collection, selected.record, original),
      );
  }
  const page =
    project.pages.find((p) => p.id === pageId) ||
    project.pages.find((p) => p.home)!;
  const content = renderToStaticMarkup(
    createElement(SiteApp, {
      project,
      mode: "site",
      apiBase: "/",
      pageId: page.id,
      contentPath,
      language,
    }),
  );
  const favicon = project.assets.find(
    (a) => a.id === project.settings.faviconAssetId,
  );
  const meta = pageMetadata(project, page.id, contentPath, language);
  const alternates = alternateLinks(project, page.id, contentPath)
    .map(
      (link) =>
        `<link rel="alternate" hreflang="${link.language}" href="${escape(link.href)}">`,
    )
    .join("");
  const imageUrl = pageImageUrl(project, meta);
  const structured = pageStructuredData(project, meta, language);
  return `<!doctype html><html lang="${language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(meta.title)}</title><meta name="description" content="${escape(meta.description)}"><meta property="og:title" content="${escape(meta.title)}"><meta property="og:description" content="${escape(meta.description)}"><meta property="og:type" content="website"><meta name="robots" content="${meta.noIndex ? "noindex,follow" : "index,follow"}">${meta.canonical ? `<link rel="canonical" href="${escape(meta.canonical)}"><meta property="og:url" content="${escape(meta.canonical)}">` : ""}${alternates}${imageUrl ? `<meta property="og:image" content="${escape(imageUrl)}">` : ""}${favicon ? `<link rel="icon" href="${favicon.data}">` : ""}<script type="application/ld+json">${safeJson(structured)}</script><link rel="stylesheet" href="/assets/site.css"></head><body style="margin:0"><div id="root">${content}</div><script id="site-config" type="application/json">${safeJson({ project, mode: "site", apiBase: "/", language })}</script><script type="module" src="/assets/site.js"></script></body></html>`;
}
