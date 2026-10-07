import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import SiteApp from "./SiteApp";
import { safeJson } from "../domain/validation";
import { publicProject } from "../domain/publication";
import type { Project } from "../domain/types";
export { parseProject, inspectProject } from "../domain/validation";
const escape = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function html(project: Project, pageId?: string): string {
  project = publicProject(project);
  const page =
    project.pages.find((p) => p.id === pageId) ||
    project.pages.find((p) => p.home)!;
  const content = renderToStaticMarkup(
    createElement(SiteApp, {
      project,
      mode: "site",
      apiBase: "/",
      pageId: page.id,
    }),
  );
  const favicon = project.assets.find(
    (a) => a.id === project.settings.faviconAssetId,
  );
  return `<!doctype html><html lang="${project.settings.language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.home ? project.name : `${page.title} · ${project.name}`)}</title><meta name="description" content="${escape(page.description || project.settings.description)}"><meta property="og:title" content="${escape(project.name)}"><meta property="og:description" content="${escape(project.settings.description)}">${favicon ? `<link rel="icon" href="${favicon.data}">` : ""}<link rel="stylesheet" href="/assets/site.css"></head><body style="margin:0"><div id="root">${content}</div><script id="site-config" type="application/json">${safeJson({ project, mode: "site", apiBase: "/" })}</script><script type="module" src="/assets/site.js"></script></body></html>`;
}
