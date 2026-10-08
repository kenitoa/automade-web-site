import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  Action,
  Block,
  Project,
  Row,
  SiteConfig,
  RichParagraph,
  SiteLanguage,
  TableColumn,
  Item,
} from "../domain/types";
import {
  csv,
  parseProject,
  parseRows,
  record,
  validateForm,
} from "../domain/validation";
import { uid } from "../domain/catalog";
import {
  effectiveDesign,
  findContent,
  getChartData,
  importTableCsv,
  validateTableRows,
  visibleColumns,
} from "../domain/content";
import { locale } from "./locale";
import { languageLabel } from "../domain/languages";
import { projectBlockDefinition } from "../domain/blockRegistry";
import PlatformWidgets from "./PlatformWidgets";
import { useBoundContent } from "./useBoundContent";
import { assetSource } from "../domain/assets";
import {
  alternateLinks,
  isMemberContentPath,
  pageImageUrl,
  pageMetadata,
  pageStructuredData,
} from "../domain/seo";
import {
  localizeProject,
  localizedPath,
  parseLocalizedPath,
  siteLanguages,
} from "../domain/localization";
export interface SiteProps extends SiteConfig {
  pageId?: string;
  contentPath?: string;
  language?: SiteLanguage;
  onPageChange?: (id: string) => void;
  decorate?: (block: Block, node: ReactNode) => ReactNode;
}
interface RuntimeContext {
  project: Project;
  mode: "preview" | "site";
  apiBase: string;
  pageId: string;
  activeBlock: string | null;
  execute: (action: Action) => void;
  navigateContent: (path: string) => void;
  contentHref: (path: string) => string;
  openModal: string | null;
  setOpenModal: (id: string | null) => void;
}
const fonts = {
  system: "Inter, ui-sans-serif, system-ui, sans-serif",
  serif: "Georgia, serif",
  mono: "ui-monospace, monospace",
};
export default function SiteApp({
  project: sourceProject,
  mode,
  apiBase,
  pageId: controlledPage,
  contentPath: initialContentPath,
  language: initialLanguage,
  onPageChange,
  decorate,
}: SiteProps) {
  const [language, setLanguage] = useState<SiteLanguage>(
    initialLanguage ?? sourceProject.settings.language,
  );
  const [memberSource, setMemberSource] = useState<Project | null>(null),
    [memberError, setMemberError] = useState("");
  const activeSource = memberSource ?? sourceProject;
  const project = useMemo(
    () => localizeProject(activeSource, language),
    [activeSource, language],
  );
  useEffect(() => {
    if (mode !== "site") return;
    let alive = true;
    let memberRequest = 0;
    const refreshMember = async (account: unknown) => {
      const ticket = ++memberRequest;
      if (!account) {
        setMemberSource(null);
        setMemberError("");
        return;
      }
      try {
        const value = await runtimeRequest(
          `${apiBase}api/platform/member-project`,
          "GET",
        );
        if (alive && ticket === memberRequest) {
          setMemberSource(parseProject(value));
          setMemberError("");
        }
      } catch (error) {
        if (alive && ticket === memberRequest) {
          setMemberSource(null);
          setMemberError(
            error instanceof Error
              ? error.message
              : "회원 콘텐츠를 조회하지 못했습니다.",
          );
        }
      }
    };
    const changed = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          account?: unknown;
          authenticated?: boolean;
          csrf?: string;
        }>
      ).detail;
      if (detail.csrf) platformCsrf = detail.csrf;
      if (detail.authenticated === false) {
        memberRequest++;
        setMemberSource(null);
        return;
      }
      if ("account" in detail) void refreshMember(detail.account);
    };
    window.addEventListener("site-capabilities", changed);
    window.addEventListener("site-session-changed", changed);
    return () => {
      alive = false;
      window.removeEventListener("site-capabilities", changed);
      window.removeEventListener("site-session-changed", changed);
    };
  }, [mode, apiBase]);
  const [contentRoute, setContentRoute] = useState(initialContentPath ?? "");
  const [pageId, setPageId] = useState(
    project.pages.find((p) => p.home)?.id ?? project.pages[0]!.id,
  );
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const [openModal, setOpenModal] = useState<string | null>(null);
  useEffect(() => {
    if (controlledPage || mode !== "site") return;
    const sync = () => {
      const route = parseLocalizedPath(
        activeSource,
        location.hash.startsWith("#/")
          ? location.hash.slice(1)
          : location.pathname,
      );
      const path = route.path;
      setLanguage(route.language);
      const page = activeSource.pages.find(
        (p) => (p.path === path || p.aliases?.includes(path)) && p.published,
      );
      const content = findContent(activeSource, path);
      const memberContent = isMemberContentPath(activeSource, path);
      setContentRoute(content || memberContent ? path : "");
      setPageId(
        page?.id ??
          (content || memberContent
            ? activeSource.pages.find((p) => p.home)!.id
            : "__missing"),
      );
      setActiveBlock(null);
    };
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, [activeSource, controlledPage, mode]);
  const execute = useCallback(
    (action: Action) => {
      if (action.kind === "navigate") {
        const page = project.pages.find(
          (p) => p.id === action.target && p.published,
        );
        if (page) {
          setContentRoute("");
          setPageId(page.id);
          onPageChange?.(page.id);
          setActiveBlock(null);
          if (!controlledPage && mode === "site")
            history.pushState(
              null,
              "",
              localizedPath(activeSource, page.path, language),
            );
        }
      } else if (action.kind === "scroll") {
        const target = project.blocks.find((b) => b.id === action.target);
        if (target && target.pageId !== "*") {
          const page = project.pages.find(
            (p) => p.id === target.pageId && p.published,
          );
          if (page) {
            setPageId(page.id);
            onPageChange?.(page.id);
            if (!controlledPage && mode === "site")
              history.pushState(
                null,
                "",
                localizedPath(activeSource, page.path, language),
              );
          }
        }
        setContentRoute("");
        setActiveBlock(null);
        requestAnimationFrame(() =>
          document.getElementById(`block-${action.target}`)?.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "auto"
              : "smooth",
            block: "start",
          }),
        );
      } else if (action.kind === "modal") setOpenModal(action.target);
      else if (action.kind === "link") {
        if (action.newTab)
          window.open(action.url, "_blank", "noopener,noreferrer");
        else location.href = action.url;
      }
    },
    [project, activeSource, language, mode, controlledPage, onPageChange],
  );
  const currentPage = controlledPage ?? pageId;
  const selectedContent = contentRoute
    ? findContent(project, contentRoute)
    : undefined;
  const memberLocked =
    mode === "site" &&
    (project.pages.find((p) => p.id === currentPage)?.access === "members" ||
      isMemberContentPath(project, contentRoute)) &&
    !memberSource;
  useEffect(() => {
    if (mode !== "site") return;
    const meta = pageMetadata(
      activeSource,
      currentPage,
      contentRoute,
      language,
    );
    document.title = meta.title;
    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (description) description.content = meta.description;
    const setMeta = (selector: string, content: string) => {
      const element = document.querySelector<HTMLMetaElement>(selector);
      if (element) element.content = content;
    };
    setMeta('meta[property="og:title"]', meta.title);
    setMeta('meta[property="og:description"]', meta.description);
    setMeta('meta[property="og:url"]', meta.canonical);
    const imageUrl = pageImageUrl(activeSource, meta);
    let imageMeta = document.querySelector<HTMLMetaElement>(
      'meta[property="og:image"]',
    );
    if (imageUrl) {
      if (!imageMeta) {
        imageMeta = document.createElement("meta");
        imageMeta.setAttribute("property", "og:image");
        document.head.append(imageMeta);
      }
      imageMeta.content = imageUrl;
    } else imageMeta?.remove();
    const structured = document.querySelector<HTMLScriptElement>(
      'script[type="application/ld+json"]',
    );
    if (structured)
      structured.textContent = JSON.stringify(
        pageStructuredData(activeSource, meta, language),
      );
    setMeta(
      'meta[name="robots"]',
      meta.noIndex ? "noindex,follow" : "index,follow",
    );
    const canonical = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    if (canonical) canonical.href = meta.canonical;
    document
      .querySelectorAll('link[rel="alternate"][hreflang]')
      .forEach((link) => link.remove());
    for (const alternate of alternateLinks(
      activeSource,
      currentPage,
      contentRoute,
    )) {
      const link = document.createElement("link");
      link.rel = "alternate";
      link.hreflang = alternate.language;
      link.href = alternate.href;
      document.head.append(link);
    }
    document.documentElement.lang = language;
  }, [activeSource, currentPage, contentRoute, language, mode]);
  const context: RuntimeContext = {
    project,
    mode,
    apiBase,
    pageId: currentPage,
    activeBlock,
    execute,
    navigateContent: (path) => {
      if (
        mode === "site" &&
        !findContent(project, path) &&
        project.collections?.some(
          (collection) =>
            collection.queryMode === "server" &&
            path.startsWith(`${collection.path}/`),
        )
      ) {
        location.assign(localizedPath(activeSource, path, language));
        return;
      }
      setContentRoute(path);
      const home = project.pages.find((p) => p.home)!;
      setPageId(home.id);
      onPageChange?.(home.id);
      if (!controlledPage && mode === "site")
        history.pushState(
          null,
          "",
          localizedPath(activeSource, path, language),
        );
    },
    contentHref: (path) => localizedPath(activeSource, path, language),
    openModal,
    setOpenModal,
  };
  const render = (block: Block): ReactNode => {
    if (block.hidden) return null;
    const node = (
      <BlockView
        key={block.id}
        block={block}
        context={context}
        render={render}
        selectBlock={setActiveBlock}
      />
    );
    return decorate ? decorate(block, node) : node;
  };
  const visible = project.blocks
    .filter(
      (b) =>
        !b.parentId &&
        (b.pageId === "*" || b.pageId === currentPage) &&
        (b.type === "navigation" ||
          b.type === "footer" ||
          !activeBlock ||
          b.id === activeBlock ||
          b.props.navigationSection === "__all"),
    )
    .sort((a, b) => a.layout.zIndex - b.layout.zIndex);
  const style = {
    "--brand": project.theme.brandColor,
    "--accent": project.theme.accentColor,
    "--surface": project.theme.surfaceColor,
    "--site-width": `${project.theme.typography?.contentWidth ?? project.canvas.width}px`,
    "--section-gap": `${project.theme.typography?.sectionGap ?? (project.theme.density === "compact" ? 12 : project.theme.density === "spacious" ? 40 : 24)}px`,
    "--body-size": `${project.theme.typography?.bodySize ?? 16}px`,
    "--heading-size": `${project.theme.typography?.headingSize ?? 48}px`,
    "--line-height": project.theme.typography?.lineHeight ?? 1.65,
    "--button-radius": `${project.theme.button?.radius ?? 9}px`,
    "--button-padding": `${project.theme.button?.padding ?? 10}px`,
    "--theme-radius": `${project.theme.radius}px`,
    background: project.canvas.background,
    fontFamily: fonts[project.theme.font],
  } as CSSProperties;
  return (
    <div
      className={`site-root density-${project.theme.density}`}
      style={style}
      lang={project.settings.language}
    >
      <a className="site-skip" href="#site-content">
        {locale(project, "콘텐츠로 이동")}
      </a>
      {siteLanguages(activeSource).length > 1 ? (
        <div className="site-language" aria-label="언어 선택">
          {siteLanguages(activeSource).map((lang) => (
            <button
              type="button"
              key={lang}
              aria-pressed={lang === language}
              className={lang === language ? "active" : "secondary"}
              onClick={() => {
                setLanguage(lang);
                if (!controlledPage && mode === "site")
                  history.pushState(
                    null,
                    "",
                    localizedPath(
                      activeSource,
                      contentRoute ||
                        activeSource.pages.find(
                          (page) => page.id === currentPage,
                        )?.path ||
                        "/",
                      lang,
                    ),
                  );
              }}
            >
              {languageLabel(lang)}
            </button>
          ))}
        </div>
      ) : null}
      <main
        id="site-content"
        className="site-content"
        style={{
          minHeight: visible.some((b) => b.layout.mode === "absolute")
            ? project.canvas.height
            : undefined,
        }}
      >
        {!project.pages.some((p) => p.id === currentPage) ? (
          <section className="site-not-found">
            <h1>{locale(project, "페이지를 찾을 수 없습니다.")}</h1>
            <a href={context.contentHref("/")}>
              {locale(project, "홈으로 이동")}
            </a>
          </section>
        ) : memberLocked ? (
          <section className="site-block">
            <h1>회원 전용 페이지</h1>
            <p>
              로그인하면 콘텐츠를 볼 수 있습니다. 아래 회원 로그인 메뉴를
              사용하세요.
            </p>
            {memberError ? (
              <p className="site-error" role="alert">
                {memberError}
              </p>
            ) : null}
          </section>
        ) : selectedContent ? (
          <>
            {" "}
            {visible.filter((b) => b.type === "navigation").map(render)}
            <article className="site-block site-content-detail">
              <h1>{selectedContent.record.title}</h1>
              {selectedContent.record.imageId &&
              project.assets.find(
                (a) => a.id === selectedContent.record.imageId,
              ) ? (
                <img
                  src={assetSource(
                    project.assets.find(
                      (a) => a.id === selectedContent.record.imageId,
                    ),
                    apiBase,
                    mode,
                  )}
                  alt={
                    project.assets.find(
                      (a) => a.id === selectedContent.record.imageId,
                    )!.alt
                  }
                />
              ) : null}
              <p className="site-copy">{selectedContent.record.body}</p>
              {selectedContent.record.category ? (
                <p className="site-muted">{selectedContent.record.category}</p>
              ) : null}
              <a href={context.contentHref("/")}>
                {locale(project, "홈으로 이동")}
              </a>
            </article>
            {visible.filter((b) => b.type === "footer").map(render)}
          </>
        ) : (
          visible.map(render)
        )}
      </main>
      <PlatformWidgets projectId={project.id} apiBase={apiBase} mode={mode} />
    </div>
  );
}
function BlockView({
  block: b,
  context: c,
  render,
  selectBlock,
}: {
  block: Block;
  context: RuntimeContext;
  render: (b: Block) => ReactNode;
  selectBlock: (id: string | null) => void;
}) {
  const design = effectiveDesign(c.project, b);
  const bound = useBoundContent(c.project, b, c.mode, c.apiBase);
  const items = bound.items;
  const style = {
    background: design.background,
    color: design.color,
    borderColor: design.borderColor,
    borderRadius: design.radius,
    padding: design.padding,
    boxShadow: design.shadow ? "0 12px 32px #14213d14" : "none",
    gap: b.layout.gap,
    "--block-padding": `${design.padding}px`,
    "--block-font": `${design.fontSize ?? c.project.theme.typography?.bodySize ?? 16}px`,
    "--block-heading": `${design.headingSize ?? c.project.theme.typography?.headingSize ?? (b.type === "hero" ? 48 : 32)}px`,
    "--block-line":
      design.lineHeight ?? c.project.theme.typography?.lineHeight ?? 1.65,
    "--block-gap": `${b.layout.gap}px`,
    ...Object.fromEntries(
      (["tablet", "mobile"] as const).flatMap((device) =>
        Object.entries(b.layout.responsive?.[device] ?? {}).map(
          ([key, value]) => [
            `--${device}-${key}`,
            key === "columns" ? value : `${value}px`,
          ],
        ),
      ),
    ),
    "--cols": b.layout.columns,
    "--mobile-cols": b.layout.mobileColumns,
    minHeight: b.layout.minHeight || undefined,
    ...(b.layout.mode === "absolute"
      ? {
          position: "absolute",
          left: b.layout.x,
          top: b.layout.y,
          width: b.layout.width,
          minHeight: Math.max(b.layout.minHeight, b.layout.height),
          zIndex: b.layout.zIndex,
        }
      : {}),
    textAlign:
      b.layout.align === "start"
        ? "left"
        : b.layout.align === "end"
          ? "right"
          : "center",
  } as CSSProperties;
  const level = b.props.headingLevel ?? (b.type === "hero" ? 1 : 2);
  const definition = projectBlockDefinition(c.project, b);
  const renderer = definition?.rendererKey ?? b.type;
  const Heading = level === 1 ? "h1" : level === 3 ? "h3" : "h2";
  const heading = (
    <>
      {b.props.title ? <Heading>{b.props.title}</Heading> : null}
      {b.props.richText?.length ? (
        <RichText paragraphs={b.props.richText} />
      ) : b.props.body ? (
        <p className="site-copy">{b.props.body}</p>
      ) : null}
    </>
  );
  let content: ReactNode;
  if (renderer === "automade:timeline")
    content = (
      <>
        {heading}
        <ol className="site-timeline">
          {items.map((item) => (
            <li key={item.id}>
              <h3>{item.title}</h3>
              <p className="site-copy">{item.body}</p>
              {item.action.kind !== "none" ? (
                <button type="button" onClick={() => c.execute(item.action)}>
                  {locale(c.project, "확인")}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      </>
    );
  else if (renderer === "navigation" || renderer === "sidebar")
    content = <Navigation block={b} context={c} selectBlock={selectBlock} />;
  else if (b.type === "form")
    content = (
      <>
        {heading}
        <FormBlock block={b} context={c} />
      </>
    );
  else if (b.type === "table")
    content = (
      <>
        {heading}
        <TableBlock block={b} context={c} />
      </>
    );
  else if (b.type === "chart")
    content = (
      <>
        {heading}
        <ChartBlock
          block={b}
          context={c}
          connected={
            b.props.dataBinding
              ? (bound.points ?? {
                  values: [],
                  labels: [],
                  unit: b.props.chartBinding?.unit ?? "",
                })
              : bound.points
          }
        />
      </>
    );
  else if (b.type === "tabs")
    content = (
      <>
        {heading}
        <TabsBlock block={b} context={c} items={items} />
      </>
    );
  else if (b.type === "modal")
    content = (
      <>
        <span className="site-muted">대화상자</span>
        {heading}
        <button type="button" onClick={() => c.setOpenModal(b.id)}>
          대화상자 열기
        </button>
        {c.openModal === b.id ? <Modal block={b} context={c} /> : null}
      </>
    );
  else if (b.type === "image") {
    const asset = c.project.assets.find((a) => a.id === b.props.assetId);
    content = (
      <figure>
        {asset ? (
          <img
            loading="lazy"
            src={assetSource(asset, c.apiBase, c.mode)}
            alt={
              b.props.imageSettings?.decorative ? "" : b.props.alt || asset.alt
            }
            width={asset.width || undefined}
            height={asset.height || undefined}
            style={{
              objectFit: b.props.imageSettings?.fit ?? "cover",
              objectPosition: `${b.props.imageSettings?.focalX ?? 50}% ${b.props.imageSettings?.focalY ?? 50}%`,
              aspectRatio: b.props.imageSettings?.ratio || undefined,
            }}
          />
        ) : (
          <div className="site-empty">이미지를 연결하세요.</div>
        )}
        {b.props.title ? <figcaption>{b.props.title}</figcaption> : null}
      </figure>
    );
  } else if (renderer === "faq")
    content = (
      <>
        {heading}
        {items.map((i) => (
          <details key={i.id}>
            <summary>{i.title}</summary>
            <p className="site-copy">{i.body}</p>
            {i.action.kind !== "none" ? (
              <button type="button" onClick={() => c.execute(i.action)}>
                {locale(c.project, "확인")}
              </button>
            ) : null}
          </details>
        ))}
      </>
    );
  else if (renderer === "cards" || renderer === "pricing")
    content = (
      <>
        {heading}
        <div className="site-grid">
          {items.map((i) => (
            <article key={i.id} className="site-card">
              {i.imageId && c.project.assets.find((a) => a.id === i.imageId) ? (
                <img
                  loading="lazy"
                  src={assetSource(
                    c.project.assets.find((a) => a.id === i.imageId),
                    c.apiBase,
                    c.mode,
                  )}
                  alt={c.project.assets.find((a) => a.id === i.imageId)!.alt}
                />
              ) : null}
              <h3>{i.title}</h3>
              {i.price ? (
                <strong className="site-price">{i.price}</strong>
              ) : null}
              <p className="site-copy">{i.body}</p>
              {i.detailPath ? (
                <a
                  href={c.contentHref(i.detailPath)}
                  onClick={(event) => {
                    if (
                      event.ctrlKey ||
                      event.metaKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    )
                      return;
                    event.preventDefault();
                    c.navigateContent(i.detailPath!);
                  }}
                >
                  {locale(c.project, "자세히 보기")}
                </a>
              ) : null}
              {i.action.kind !== "none" ? (
                <button onClick={() => c.execute(i.action)} type="button">
                  자세히 보기
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </>
    );
  else if (b.type === "container")
    content = (
      <>
        {heading}
        <div className="site-grid">
          {c.project.blocks
            .filter((x) => x.parentId === b.id)
            .sort((a, b) => a.layout.zIndex - b.layout.zIndex)
            .map(render)}
        </div>
      </>
    );
  else if (b.type === "divider") content = <hr />;
  else
    content = (
      <>
        {heading}
        <Actions block={b} context={c} />
      </>
    );
  return (
    <section
      id={`block-${b.id}`}
      data-block-id={b.id}
      data-layout={b.layout.mode}
      className={`site-block animation-${b.design.animation ?? "none"} block-${b.type} ${b.layout.mobileHidden ? "hide-mobile" : ""} ${b.layout.tabletHidden ? "hide-tablet" : ""} ${b.layout.desktopHidden ? "hide-desktop" : ""}`}
      style={style}
    >
      {content}
      {bound.enabled ? (
        <div className="site-bound-controls" aria-label="연결 콘텐츠 조회">
          {bound.fetchedAt ? (
            <p className="site-muted">
              조회 시각{" "}
              <time dateTime={bound.fetchedAt}>{bound.fetchedAt}</time>
              {bound.cached ? " · 저장된 조회 결과" : ""}
            </p>
          ) : null}
          <label>
            콘텐츠 검색
            <input
              type="search"
              value={bound.query}
              onChange={(event) => bound.setQuery(event.target.value)}
            />
          </label>
          {bound.loading ? (
            <p role="status">데이터를 불러오는 중…</p>
          ) : bound.error ? (
            <p role="alert" className="site-error">
              {bound.error}
              <button type="button" onClick={bound.reload}>
                다시 조회
              </button>
            </p>
          ) : !items.length ? (
            <p className="site-empty">표시할 데이터가 없습니다.</p>
          ) : null}
          <button
            type="button"
            className="secondary"
            disabled={!bound.hasPrevious || bound.loading}
            onClick={bound.previous}
          >
            이전 항목
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!bound.hasNext || bound.loading}
            onClick={bound.next}
          >
            다음 항목
          </button>
        </div>
      ) : null}
    </section>
  );
}
function Actions({
  block: b,
  context: c,
}: {
  block: Block;
  context: RuntimeContext;
}) {
  return (
    <div className="site-actions">
      {b.props.primaryAction ? (
        <button
          type="button"
          disabled={b.props.action.kind === "none"}
          onClick={() => c.execute(b.props.action)}
        >
          {b.props.primaryAction}
        </button>
      ) : null}
      {b.props.secondaryAction ? (
        <button
          className="secondary"
          type="button"
          disabled={b.props.secondary.kind === "none"}
          onClick={() => c.execute(b.props.secondary)}
        >
          {b.props.secondaryAction}
        </button>
      ) : null}
    </div>
  );
}
function Navigation({
  block: b,
  context: c,
  selectBlock,
}: {
  block: Block;
  context: RuntimeContext;
  selectBlock: (id: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const menus =
    b.props.menuMode === "blocks"
      ? c.project.blocks
          .filter(
            (x) =>
              x.id !== b.id &&
              x.type !== "navigation" &&
              x.type !== "footer" &&
              !x.hidden &&
              (x.pageId === c.pageId || x.pageId === "*"),
          )
          .map((x) => ({
            id: x.id,
            label: x.props.navigationLabel || x.props.title || x.name,
            target: x.id,
          }))
      : c.project.pages
          .filter((p) => p.published && p.navigation !== false)
          .map((p) => ({ id: p.id, label: p.title, target: p.id }));
  return (
    <>
      <div className="site-nav-heading">
        <strong>{b.props.title}</strong>
        <button
          type="button"
          className="secondary site-menu-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          메뉴
        </button>
      </div>
      <nav
        aria-label={b.props.title || "사이트 메뉴"}
        className={`site-navigation ${expanded ? "expanded" : ""}`}
      >
        {b.props.menuMode === "blocks" &&
        b.props.navigationBehavior !== "scroll" ? (
          <button
            className="secondary"
            type="button"
            onClick={() => selectBlock(null)}
          >
            전체
          </button>
        ) : null}
        {menus.map((i) => (
          <button
            className={
              i.id ===
              (b.props.menuMode === "blocks" ? c.activeBlock : c.pageId)
                ? "active"
                : "secondary"
            }
            type="button"
            key={i.id}
            onClick={() => {
              if (b.props.menuMode === "blocks") {
                if (b.props.navigationBehavior === "scroll")
                  c.execute({ kind: "scroll", target: i.target });
                else selectBlock(i.target);
              } else c.execute({ kind: "navigate", target: i.target });
              setExpanded(false);
            }}
            aria-current={i.id === c.pageId ? "page" : undefined}
          >
            {i.label}
          </button>
        ))}
      </nav>
    </>
  );
}
let platformCsrf = "";
class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
async function runtimeRequest(
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(platformCsrf && method !== "GET"
        ? { "X-Platform-CSRF": platformCsrf }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const json = record(await response.json());
  if (!response.ok || json.error)
    throw new RuntimeError(
      String(
        record(json.error).message || "저장에 실패했습니다. 다시 시도하세요.",
      ),
      String(record(json.error).code ?? "REQUEST_FAILED"),
    );
  return json.data;
}
function FormBlock({
  block: b,
  context: c,
}: {
  block: Block;
  context: RuntimeContext;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef(uid());
  return (
    <form
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fd = new FormData(form);
        const raw: Record<string, string> = {};
        b.props.fields.forEach(
          (f) =>
            (raw[f.id] =
              f.type === "checkbox"
                ? fd.has(f.id)
                  ? "true"
                  : ""
                : String(fd.get(f.id) ?? "")),
        );
        if (b.props.formSettings?.consentRequired)
          raw.__consent = fd.has("__consent") ? "true" : "";
        const result = validateForm(b.props.fields, raw, b.props.formSettings);
        setErrors(result.errors);
        if (Object.keys(result.errors).length) {
          setStatus(locale(c.project, "입력값을 확인하세요."));
          form
            .querySelector<HTMLElement>(
              `[name="${Object.keys(result.errors)[0]}"]`,
            )
            ?.focus();
          return;
        }
        if (c.mode === "preview") {
          setStatus(
            locale(
              c.project,
              "미리보기 제출을 확인했습니다. 데이터는 저장되지 않습니다.",
            ),
          );
          if (
            b.props.formSettings &&
            b.props.formSettings.successAction.kind !== "none"
          )
            c.execute(b.props.formSettings.successAction);
          return;
        }
        if (b.props.dataSource !== "local") {
          setStatus(locale(c.project, "저장 대상이 연결되지 않았습니다."));
          return;
        }
        setBusy(true);
        setStatus(locale(c.project, "저장 중…"));
        try {
          await runtimeRequest(`${c.apiBase}api/forms/${b.id}`, "POST", {
            values: result.values,
            idempotencyKey: key.current,
          });
          key.current = uid();
          setStatus(
            b.props.formSettings?.successMessage ||
              locale(c.project, "문의가 저장되었습니다."),
          );
          form.reset();
          if (
            b.props.formSettings &&
            b.props.formSettings.successAction.kind !== "none"
          )
            c.execute(b.props.formSettings.successAction);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "제출 실패");
        } finally {
          setBusy(false);
        }
      }}
      onReset={() => {
        setErrors({});
      }}
    >
      {b.props.fields.map((f) => (
        <label
          className={`site-field ${f.type === "checkbox" ? "site-checkbox" : ""}`}
          key={f.id}
        >
          {f.type === "checkbox" ? (
            <input
              type="checkbox"
              name={f.id}
              disabled={busy}
              aria-describedby={
                errors[f.id] ? `${b.id}-${f.id}-error` : undefined
              }
            />
          ) : null}
          <span>
            {f.label}
            {f.required ? " *" : ""}
          </span>
          {f.type === "textarea" ? (
            <textarea
              name={f.id}
              rows={4}
              placeholder={f.placeholder}
              required={f.required}
              disabled={busy}
              aria-invalid={Boolean(errors[f.id])}
              aria-describedby={
                errors[f.id] ? `${b.id}-${f.id}-error` : undefined
              }
            />
          ) : f.type === "select" ? (
            <select
              name={f.id}
              required={f.required}
              disabled={busy}
              aria-invalid={Boolean(errors[f.id])}
            >
              <option value="">선택하세요</option>
              {f.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : f.type === "checkbox" ? null : (
            <input
              name={f.id}
              type={f.type}
              placeholder={f.placeholder}
              required={f.required}
              disabled={busy}
              min={f.type === "number" ? f.min : undefined}
              max={f.type === "number" ? f.max : undefined}
              aria-invalid={Boolean(errors[f.id])}
              aria-describedby={
                errors[f.id] ? `${b.id}-${f.id}-error` : undefined
              }
            />
          )}{" "}
          {f.description ? (
            <span className="site-muted" id={`${b.id}-${f.id}-description`}>
              {f.description}
            </span>
          ) : null}
          {errors[f.id] ? (
            <span id={`${b.id}-${f.id}-error`} className="site-error">
              {errors[f.id]}
            </span>
          ) : null}
        </label>
      ))}
      {b.props.formSettings?.privacyNotice ? (
        <p className="site-copy site-muted">
          {b.props.formSettings.privacyNotice}
        </p>
      ) : null}
      {b.props.formSettings?.consentRequired ? (
        <label className="site-field site-checkbox">
          <input
            name="__consent"
            type="checkbox"
            required
            disabled={busy}
            aria-invalid={Boolean(errors.__consent)}
            aria-describedby={
              errors.__consent ? `${b.id}-consent-error` : undefined
            }
          />
          <span>개인정보 안내를 확인하고 동의합니다. *</span>
          {errors.__consent ? (
            <span className="site-error" id={`${b.id}-consent-error`}>
              {errors.__consent}
            </span>
          ) : null}
        </label>
      ) : null}
      <div className="site-actions">
        <button type="submit" disabled={busy}>
          {busy
            ? locale(c.project, "저장 중…")
            : b.props.primaryAction || locale(c.project, "제출")}
        </button>
        <button className="secondary" type="reset" disabled={busy}>
          {b.props.secondaryAction || "초기화"}
        </button>
      </div>
      <p role="status">{status}</p>
    </form>
  );
}
function TableBlock({
  block: b,
  context: c,
}: {
  block: Block;
  context: RuntimeContext;
}) {
  const [rows, setRows] = useState<Row[]>(b.props.rows),
    [version, setVersion] = useState(0),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState<{ index: number; direction: number }>({
      index: 0,
      direction: 1,
    }),
    [page, setPage] = useState(0),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Row | null>(null),
    [importSource, setImportSource] = useState(""),
    [importMapping, setImportMapping] = useState<Record<string, number>>({}),
    [conflict, setConflict] = useState<{ mine: Row[]; latest: Row[] } | null>(
      null,
    ),
    [tableHistory, setTableHistory] = useState<{
      items: {
        version: number;
        rows: Row[];
        previousRows: Row[];
        actorId: string;
        createdAt: string;
      }[];
      nextCursor: number | null;
    } | null>(null),
    [historyBusy, setHistoryBusy] = useState(false);
  const columns = visibleColumns(b.props.columns);
  const importPreview = useMemo(() => {
    if (!importSource) return null;
    try {
      return {
        result: importTableCsv(
          importSource,
          b.props.columns,
          Object.keys(importMapping).length ? importMapping : undefined,
          rows,
        ),
        error: "",
      };
    } catch (error) {
      return {
        result: null,
        error: error instanceof Error ? error.message : "CSV 읽기 실패",
      };
    }
  }, [importSource, importMapping, b.props.columns, rows]);
  const [canManage, setCanManage] = useState(c.mode === "preview");
  useEffect(() => {
    if (!canManage) {
      setTableHistory(null);
      setEditing(null);
      setConflict(null);
      setImportSource("");
    }
  }, [canManage]);
  useEffect(() => {
    if (c.mode === "preview") {
      setCanManage(true);
      return;
    }
    let active = true;
    runtimeRequest(
      `${c.apiBase}api/platform/capabilities?projectId=${encodeURIComponent(c.project.id)}`,
      "GET",
    )
      .then((data) => {
        if (active) setCanManage(record(data).canManage === true);
      })
      .catch(() => {
        if (active) setCanManage(false);
      });
    const changed = (event: Event) =>
      setCanManage(
        (event as CustomEvent<{ canManage: boolean }>).detail.canManage ===
          true,
      );
    window.addEventListener("site-capabilities", changed);
    return () => {
      active = false;
      window.removeEventListener("site-capabilities", changed);
    };
  }, [c.mode, c.apiBase, c.project.id]);
  const sequence = useRef(0);
  const loadHistory = async (cursor?: number) => {
    if (!canManage || c.mode !== "site" || historyBusy) return;
    setHistoryBusy(true);
    try {
      const result = record(
        await runtimeRequest(
          `${c.apiBase}api/tables/${b.id}/history?limit=10${cursor === undefined ? "" : `&beforeVersion=${cursor}`}`,
          "GET",
        ),
      );
      if (!Array.isArray(result.items))
        throw new Error("변경 이력 형식을 확인하지 못했습니다.");
      const items = result.items.map((value: unknown) => {
        const row = record(value);
        return {
          version: Number(row.version),
          rows: parseRows(row.rows, b.props.columns.length),
          previousRows: parseRows(row.previousRows, b.props.columns.length),
          actorId: String(row.actorId),
          createdAt: String(row.createdAt),
        };
      });
      setTableHistory((previous) => ({
        items:
          cursor === undefined ? items : [...(previous?.items ?? []), ...items],
        nextCursor:
          typeof result.nextCursor === "number" ? result.nextCursor : null,
      }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "변경 이력 조회 실패");
    } finally {
      setHistoryBusy(false);
    }
  };
  useEffect(() => {
    setRows(b.props.rows);
    setVersion(0);
    setPage(0);
    const seq = ++sequence.current;
    if (c.mode === "site" && b.props.dataSource === "local") {
      setBusy(true);
      runtimeRequest(`${c.apiBase}api/tables/${b.id}`, "GET")
        .then((value) => {
          if (sequence.current !== seq) return;
          const data = record(value);
          setRows(parseRows(data.rows, b.props.columns.length));
          setVersion(Number(data.version));
          setStatus("");
        })
        .catch((error) => {
          if (sequence.current === seq)
            setStatus(
              error instanceof Error ? error.message : "데이터 조회 실패",
            );
        })
        .finally(() => {
          if (sequence.current === seq) setBusy(false);
        });
    }
    return () => {
      sequence.current++;
    };
  }, [
    b.id,
    b.props.rows,
    b.props.columns.length,
    b.props.dataSource,
    c.apiBase,
    c.mode,
  ]);
  const save = async (next: Row[]) => {
    if (!canManage) {
      setStatus("표 수정은 관리 권한이 필요합니다.");
      return;
    }
    const ruleErrors = validateTableRows(b.props.columns, next, rows);
    if (ruleErrors.length) {
      setStatus(
        ruleErrors.map((e) => `행 ${e.row + 1}: ${e.message}`).join(" "),
      );
      return;
    }
    setBusy(true);
    try {
      if (c.mode === "site") {
        if (b.props.dataSource !== "local")
          throw new Error("표 저장 대상을 연결하세요.");
        const result = record(
          await runtimeRequest(`${c.apiBase}api/tables/${b.id}`, "PUT", {
            rows: next,
            expectedVersion: version,
          }),
        );
        setVersion(Number(result.version));
      }
      setRows(next);
      setConflict(null);
      setEditing(null);
      window.dispatchEvent(
        new CustomEvent("site-table-updated", {
          detail: { blockId: b.id, rows: next },
        }),
      );
      setStatus(
        c.mode === "preview"
          ? "미리보기 데이터만 변경했습니다."
          : "변경 사항을 저장했습니다.",
      );
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        ["CONFLICT", "TABLE_CONFLICT", "REVISION_CONFLICT"].includes(error.code)
      ) {
        try {
          const latest = record(
            await runtimeRequest(`${c.apiBase}api/tables/${b.id}`, "GET"),
          );
          const fresh = parseRows(latest.rows, b.props.columns.length);
          setConflict({ mine: next, latest: fresh });
          setVersion(Number(latest.version));
          setRows(fresh);
        } catch {
          setStatus(
            "최신 데이터를 조회하지 못했습니다. 내 편집 내용은 유지됩니다.",
          );
          return;
        }
      }
      setStatus(error instanceof Error ? error.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };
  const sorted = rows
    .filter((row) =>
      columns.some(({ index }) =>
        (row.values[index] ?? "")
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    )
    .sort((a, d) => {
      const type = b.props.columns[sort.index]?.type;
      const av = a.values[sort.index] ?? "",
        bv = d.values[sort.index] ?? "";
      return (
        (type === "number"
          ? Number(av) - Number(bv)
          : type === "date"
            ? (Date.parse(av) || 0) - (Date.parse(bv) || 0)
            : av.localeCompare(bv, "ko")) * sort.direction
      );
    });
  const pageCount = Math.max(1, Math.ceil(sorted.length / 10));
  const currentPage = Math.min(page, pageCount - 1);
  const download = () => {
    const contents = csv(
      columns.map(({ column }) => column.label),
      sorted.map((x) => columns.map(({ index }) => x.values[index] ?? "")),
    );
    const url = URL.createObjectURL(
      new Blob([contents], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${b.props.title.replace(/[<>:"/\\|?*]/g, "-") || "data"}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <div className="site-table-toolbar">
        <label>
          {locale(c.project, "검색")}
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <button
          type="button"
          disabled={busy || !canManage}
          onClick={() =>
            setEditing({ id: uid(), values: b.props.columns.map(() => "") })
          }
        >
          {b.props.primaryAction || locale(c.project, "행 추가")}
        </button>
        <label className="site-import-label">
          CSV 가져오기
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy || !canManage}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 8_000_000) {
                setStatus("CSV 파일은 8MB 이하여야 합니다.");
                return;
              }
              setImportMapping({});
              setImportSource(await file.text());
              event.target.value = "";
            }}
          />
        </label>
        <button className="secondary" type="button" onClick={download}>
          {b.props.secondaryAction || locale(c.project, "CSV 다운로드")}
        </button>
        {canManage && c.mode === "site" ? (
          <button
            type="button"
            className="secondary"
            disabled={historyBusy}
            onClick={() => {
              if (tableHistory) setTableHistory(null);
              else void loadHistory();
            }}
          >
            {historyBusy
              ? "이력 조회 중…"
              : tableHistory
                ? "변경 이력 닫기"
                : "변경 이력"}
          </button>
        ) : null}
      </div>
      {!canManage ? (
        <p className="site-muted">표 변경은 관리 계정으로 로그인해야 합니다.</p>
      ) : null}
      {conflict ? (
        <section className="site-row-editor" aria-label="충돌 비교">
          <h3>내 수정과 최신 데이터 비교</h3>
          <p>
            최신 데이터를 불러왔습니다. 비교한 뒤 내 수정 적용 여부를
            선택하세요.
          </p>
          <div className="site-grid">
            <div>
              <h4>내 수정</h4>
              <TableSnapshot columns={b.props.columns} rows={conflict.mine} />
            </div>
            <div>
              <h4>최신 데이터</h4>
              <TableSnapshot columns={b.props.columns} rows={conflict.latest} />
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(conflict.mine)}
          >
            내 수정 적용
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setConflict(null);
              setEditing(null);
            }}
          >
            최신 데이터 유지
          </button>
        </section>
      ) : null}
      {importPreview ? (
        <section className="site-row-editor" aria-label="CSV 가져오기 확인">
          <h3>가져오기 전 열 연결과 오류 확인</h3>
          {b.props.columns.map((col, index) => (
            <label key={col.id}>
              {col.label}
              <input
                type="number"
                min="1"
                max="100"
                value={(importMapping[col.id] ?? index) + 1}
                onChange={(e) =>
                  setImportMapping({
                    ...Object.fromEntries(
                      b.props.columns.map((column, i) => [column.id, i]),
                    ),
                    ...importMapping,
                    [col.id]: Number(e.target.value) - 1,
                  })
                }
              />
            </label>
          ))}
          <p>
            {importPreview.error ||
              `${importPreview.result?.rows.length ?? 0}행 / ${importPreview.result?.errors.length ?? 0}개 오류`}
          </p>
          {importPreview.result?.errors.slice(0, 20).map((e, i) => (
            <p key={i} className="site-error">
              행 {e.row + 1}: {e.message}
            </p>
          ))}
          {importPreview.result ? (
            <TableSnapshot
              columns={b.props.columns}
              rows={importPreview.result.rows.slice(0, 3)}
            />
          ) : null}
          <button
            type="button"
            disabled={
              busy ||
              !importPreview.result ||
              Boolean(importPreview.result.errors.length)
            }
            onClick={() => {
              if (importPreview.result) {
                void save([...rows, ...importPreview.result.rows]);
                setImportSource("");
              }
            }}
          >
            검토한 데이터 추가
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setImportSource("")}
          >
            취소
          </button>
        </section>
      ) : null}
      {editing ? (
        <form
          className="site-row-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save([...rows.filter((x) => x.id !== editing.id), editing]);
          }}
        >
          {columns.map(({ column: col, index: i }) => (
            <label key={col.id}>
              {col.label}
              <input
                required={col.required !== false}
                readOnly={Boolean(
                  col.readOnly && rows.some((r) => r.id === editing.id),
                )}
                type={
                  col.type === "number"
                    ? "number"
                    : col.type === "date"
                      ? "date"
                      : "text"
                }
                value={editing.values[i] ?? ""}
                maxLength={5000}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    values: editing.values.map((v, index) =>
                      index === i ? e.target.value : v,
                    ),
                  })
                }
              />
            </label>
          ))}
          <button disabled={busy} type="submit">
            {locale(c.project, "행 저장")}
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => setEditing(null)}
          >
            {locale(c.project, "취소")}
          </button>
        </form>
      ) : null}
      {tableHistory ? (
        <section className="site-row-editor" aria-label="표 변경 이력">
          <h3>표 변경 이력</h3>
          {!tableHistory.items.length ? (
            <p className="site-empty">저장된 변경 이력이 없습니다.</p>
          ) : (
            tableHistory.items.map((entry) => (
              <details key={entry.version}>
                <summary>
                  버전 {entry.version} ·{" "}
                  {new Date(entry.createdAt).toLocaleString()} ·{" "}
                  {entry.previousRows.length}행 → {entry.rows.length}행
                </summary>
                <p>
                  수정자:{" "}
                  {entry.actorId === "local-owner"
                    ? "로컬 운영자"
                    : entry.actorId.slice(0, 8)}
                </p>
                <div className="site-grid">
                  <div>
                    <h4>변경 전</h4>
                    <TableSnapshot
                      columns={b.props.columns}
                      rows={entry.previousRows.slice(0, 20)}
                    />
                  </div>
                  <div>
                    <h4>변경 후</h4>
                    <TableSnapshot
                      columns={b.props.columns}
                      rows={entry.rows.slice(0, 20)}
                    />
                  </div>
                </div>
                {Math.max(entry.rows.length, entry.previousRows.length) > 20 ? (
                  <p>처음 20행을 표시합니다.</p>
                ) : null}
              </details>
            ))
          )}
          {tableHistory.nextCursor !== null ? (
            <button
              type="button"
              className="secondary"
              disabled={historyBusy}
              onClick={() => void loadHistory(tableHistory.nextCursor!)}
            >
              이전 이력 더 보기
            </button>
          ) : null}
        </section>
      ) : null}
      <div className="site-table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map(({ column: col, index: i }) => (
                <th
                  key={col.id}
                  style={{ width: col.width }}
                  aria-sort={
                    sort.index === i
                      ? sort.direction === 1
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setSort({
                        index: i,
                        direction: sort.index === i ? -sort.direction : 1,
                      })
                    }
                  >
                    {col.label}{" "}
                    {sort.index === i ? (sort.direction === 1 ? "↑" : "↓") : ""}
                  </button>
                </th>
              ))}
              <th>작업</th>
            </tr>
          </thead>
          <tbody>
            {sorted
              .slice(currentPage * 10, currentPage * 10 + 10)
              .map((row) => (
                <tr key={row.id}>
                  {columns.map(({ column, index }) => (
                    <td key={column.id}>{row.values[index]}</td>
                  ))}
                  <td>
                    <button
                      type="button"
                      disabled={busy || !canManage}
                      className="secondary"
                      onClick={() => setEditing(structuredClone(row))}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy || !canManage}
                      onClick={() => {
                        if (
                          window.confirm(
                            locale(c.project, "이 행을 삭제하시겠습니까?"),
                          )
                        )
                          void save(rows.filter((r) => r.id !== row.id));
                      }}
                    >
                      {locale(c.project, "삭제")}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!sorted.length ? (
          <p className="site-empty">
            {busy
              ? locale(c.project, "데이터를 불러오는 중…")
              : locale(c.project, "표시할 데이터가 없습니다.")}
          </p>
        ) : null}
      </div>
      <div className="site-pagination">
        <button
          className="secondary"
          disabled={currentPage === 0}
          type="button"
          onClick={() => setPage(currentPage - 1)}
        >
          {locale(c.project, "이전")}
        </button>
        <span>
          {currentPage + 1} / {pageCount} / {sorted.length}개
        </span>
        <button
          className="secondary"
          disabled={currentPage + 1 >= pageCount}
          type="button"
          onClick={() => setPage(currentPage + 1)}
        >
          {locale(c.project, "다음")}
        </button>
      </div>
      <p role="status">{status}</p>
    </>
  );
}
function TableSnapshot({
  columns,
  rows,
}: {
  columns: TableColumn[];
  rows: Row[];
}) {
  const shown = visibleColumns(columns);
  return (
    <div className="site-table-wrap">
      <table>
        <thead>
          <tr>
            {shown.map(({ column }) => (
              <th key={column.id}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {shown.map(({ column, index }) => (
                <td key={column.id}>{row.values[index]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? (
        <p className="site-empty">표시할 데이터가 없습니다.</p>
      ) : null}
    </div>
  );
}
function ChartBlock({
  block: b,
  context: c,
  connected,
}: {
  block: Block;
  context: RuntimeContext;
  connected?: { values: number[]; labels: string[]; unit: string };
}) {
  const [mode, setMode] = useState(b.props.chartType),
    [selected, setSelected] = useState<number | null>(null);
  const [tableRows, setTableRows] = useState<Row[] | undefined>(undefined),
    [loadError, setLoadError] = useState("");
  const binding = b.props.chartBinding;
  useEffect(() => {
    let active = true;
    setTableRows(undefined);
    setLoadError("");
    const table = c.project.blocks.find(
      (block) => block.id === binding?.tableBlockId && block.type === "table",
    );
    if (table && c.mode === "site" && table.props.dataSource === "local")
      runtimeRequest(`${c.apiBase}api/tables/${table.id}`, "GET")
        .then((value) => {
          if (active)
            setTableRows(
              parseRows(record(value).rows, table.props.columns.length),
            );
        })
        .catch((error) => {
          if (active)
            setLoadError(
              error instanceof Error ? error.message : "표 데이터 조회 실패",
            );
        });
    const updated = (event: Event) => {
      const detail = (event as CustomEvent<{ blockId: string; rows: Row[] }>)
        .detail;
      if (detail.blockId === binding?.tableBlockId) setTableRows(detail.rows);
    };
    window.addEventListener("site-table-updated", updated);
    return () => {
      active = false;
      window.removeEventListener("site-table-updated", updated);
    };
  }, [binding?.tableBlockId, c.apiBase, c.mode, c.project.blocks]);
  const { values, labels, unit } =
    connected ?? getChartData(c.project, b, tableRows);
  if (loadError)
    return (
      <p role="alert" className="site-error">
        {loadError}
      </p>
    );
  if (!values.length)
    return <p className="site-empty">차트 데이터가 없습니다.</p>;
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    range = max - min;
  const points = values
    .map(
      (value, i) =>
        `${30 + (i * 540) / Math.max(1, values.length - 1)},${180 - ((value - min) / range) * 150}`,
    )
    .join(" ");
  return (
    <>
      {binding ? (
        <p className="site-muted">
          표 데이터 · {binding.xLabel} / {binding.yLabel}
          {unit ? ` (${unit})` : ""}
        </p>
      ) : (
        <p className="site-muted">수동 입력 데이터</p>
      )}
      <div className="site-actions">
        {(["bar", "line", "summary"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? "active" : "secondary"}
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {m === "bar"
              ? locale(c.project, "막대")
              : m === "line"
                ? locale(c.project, "선")
                : locale(c.project, "요약")}
          </button>
        ))}
      </div>
      {mode === "summary" ? (
        <dl className="site-metrics">
          <div>
            <dt>합계</dt>
            <dd>{values.reduce((a, v) => a + v, 0)}</dd>
          </div>
          <div>
            <dt>평균</dt>
            <dd>
              {(values.reduce((a, v) => a + v, 0) / values.length).toFixed(2)}
            </dd>
          </div>
          <div>
            <dt>최대</dt>
            <dd>{Math.max(...values)}</dd>
          </div>
        </dl>
      ) : (
        <svg
          className="site-chart"
          viewBox="0 0 600 220"
          role="img"
          aria-label={`${b.props.title}: ${values.map((v, i) => `${labels[i] ?? i + 1} ${v}${unit}`).join(", ")}`}
        >
          <line
            x1="30"
            y1={180 - ((0 - min) / range) * 150}
            x2="570"
            y2={180 - ((0 - min) / range) * 150}
            stroke="#94a3b8"
          />
          {mode === "line" ? (
            <polyline
              points={points}
              fill="none"
              stroke="var(--brand)"
              strokeWidth="3"
            />
          ) : null}
          {values.map((value, i) => {
            const x = 30 + (i * 540) / Math.max(1, values.length - 1);
            const y = 180 - ((value - min) / range) * 150;
            const baseline = 180 - ((0 - min) / range) * 150;
            return (
              <g
                key={i}
                tabIndex={0}
                role="button"
                aria-label={`${i + 1}번째 값 ${value}`}
                onClick={() => setSelected(value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setSelected(value);
                }}
              >
                {mode === "bar" ? (
                  <rect
                    x={x - 10}
                    y={Math.min(y, baseline)}
                    width="20"
                    height={Math.max(2, Math.abs(baseline - y))}
                    fill="var(--brand)"
                  />
                ) : (
                  <circle cx={x} cy={y} r="5" fill="var(--brand)" />
                )}
                <text x={x} y="208" textAnchor="middle" fontSize="12">
                  {labels[i] || value}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <p role="status">
        {selected === null
          ? `${values.length}개의 값`
          : `선택한 값: ${selected}`}
      </p>
    </>
  );
}
function TabsBlock({
  block: b,
  context: c,
  items,
}: {
  block: Block;
  context: RuntimeContext;
  items: Item[];
}) {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.min(active, Math.max(0, items.length - 1)),
    item = items[activeIndex];
  return (
    <>
      <div className="site-tabs" role="tablist" aria-label={b.props.title}>
        {items.map((i, index) => (
          <button
            id={`${b.id}-tab-${i.id}`}
            key={i.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={index === activeIndex}
            aria-controls={`${b.id}-panel-${i.id}`}
            tabIndex={index === activeIndex ? 0 : -1}
            className={index === activeIndex ? "active" : "secondary"}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight") next = (index + 1) % items.length;
              else if (event.key === "ArrowLeft")
                next = (index - 1 + items.length) % items.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = items.length - 1;
              else return;
              event.preventDefault();
              setActive(next);
              refs.current[next]?.focus();
            }}
          >
            {i.title}
          </button>
        ))}
      </div>
      {item ? (
        <div
          id={`${b.id}-panel-${item.id}`}
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`${b.id}-tab-${item.id}`}
        >
          <p className="site-copy">{item.body}</p>
          {item.action.kind !== "none" ? (
            <button type="button" onClick={() => c.execute(item.action)}>
              실행
            </button>
          ) : null}
        </div>
      ) : (
        <p>탭을 추가하세요.</p>
      )}
    </>
  );
}
function Modal({
  block: b,
  context: c,
}: {
  block: Block;
  context: RuntimeContext;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="site-modal"
      aria-labelledby={`${b.id}-dialog-title`}
      onCancel={() => c.setOpenModal(null)}
    >
      <h2 id={`${b.id}-dialog-title`}>{b.props.title}</h2>
      <p className="site-copy">{b.props.body}</p>
      <div className="site-actions">
        <button
          type="button"
          onClick={() => {
            c.setOpenModal(null);
            c.execute(b.props.action);
          }}
        >
          {b.props.primaryAction || locale(c.project, "확인")}
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => c.setOpenModal(null)}
        >
          {b.props.secondaryAction || locale(c.project, "취소")}
        </button>
      </div>
    </dialog>
  );
}

function RichText({ paragraphs }: { paragraphs: RichParagraph[] }) {
  const nodes: ReactNode[] = [];
  for (let i = 0; i < paragraphs.length;) {
    const p = paragraphs[i]!;
    const spans = (paragraph: RichParagraph) =>
      paragraph.spans.map((span, j) => {
        let node: ReactNode = span.text;
        if (span.bold) node = <strong>{node}</strong>;
        if (span.italic) node = <em>{node}</em>;
        if (span.href)
          node = (
            <a href={span.href} rel="noopener noreferrer">
              {node}
            </a>
          );
        return <span key={j}>{node}</span>;
      });
    if (p.kind === "paragraph") {
      nodes.push(
        <p className="site-copy" key={i}>
          {spans(p)}
        </p>,
      );
      i++;
    } else {
      const start = i,
        children: ReactNode[] = [];
      while (i < paragraphs.length && paragraphs[i]!.kind === p.kind) {
        children.push(<li key={i}>{spans(paragraphs[i]!)}</li>);
        i++;
      }
      nodes.push(
        p.kind === "ordered" ? (
          <ol key={start}>{children}</ol>
        ) : (
          <ul key={start}>{children}</ul>
        ),
      );
    }
  }
  return <div className="site-rich-text">{nodes}</div>;
}
