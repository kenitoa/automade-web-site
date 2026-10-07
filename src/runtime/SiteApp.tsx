import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Action, Block, Project, Row, SiteConfig } from "../domain/types";
import { csv, parseRows, record, validateForm } from "../domain/validation";
import { uid } from "../domain/catalog";
import { locale } from "./locale";
export interface SiteProps extends SiteConfig {
  pageId?: string;
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
  openModal: string | null;
  setOpenModal: (id: string | null) => void;
}
const fonts = {
  system: "Inter, ui-sans-serif, system-ui, sans-serif",
  serif: "Georgia, serif",
  mono: "ui-monospace, monospace",
};
export default function SiteApp({
  project,
  mode,
  apiBase,
  pageId: controlledPage,
  onPageChange,
  decorate,
}: SiteProps) {
  const [pageId, setPageId] = useState(
    project.pages.find((p) => p.home)?.id ?? project.pages[0]!.id,
  );
  const [activeBlock, setActiveBlock] = useState<string | null>(null);
  const [openModal, setOpenModal] = useState<string | null>(null);
  useEffect(() => {
    if (controlledPage) return;
    const sync = () => {
      const path =
        location.hash.slice(1) || location.pathname.replace(/\/$/, "") || "/";
      const page = project.pages.find((p) => p.path === path && p.published);
      setPageId(page?.id ?? "__missing");
      setActiveBlock(null);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [project.pages, controlledPage]);
  const execute = useCallback(
    (action: Action) => {
      if (action.kind === "navigate") {
        const page = project.pages.find(
          (p) => p.id === action.target && p.published,
        );
        if (page) {
          setPageId(page.id);
          onPageChange?.(page.id);
          setActiveBlock(null);
          if (!controlledPage) location.hash = page.path;
        }
      } else if (action.kind === "scroll") {
        setActiveBlock(null);
        requestAnimationFrame(() =>
          document
            .getElementById(`block-${action.target}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" }),
        );
      } else if (action.kind === "modal") setOpenModal(action.target);
      else if (action.kind === "link") {
        if (action.newTab)
          window.open(action.url, "_blank", "noopener,noreferrer");
        else location.href = action.url;
      }
    },
    [project.pages, controlledPage, onPageChange],
  );
  const currentPage = controlledPage ?? pageId;
  const context: RuntimeContext = {
    project,
    mode,
    apiBase,
    pageId: currentPage,
    activeBlock,
    execute,
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
    "--site-width": `${project.canvas.width}px`,
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
            <a href="#/">{locale(project, "홈으로 이동")}</a>
          </section>
        ) : (
          visible.map(render)
        )}
      </main>
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
  const style = {
    background: b.design.background,
    color: b.design.color,
    borderColor: b.design.borderColor,
    borderRadius: b.design.radius,
    padding: b.design.padding,
    boxShadow: b.design.shadow ? "0 12px 32px #14213d14" : "none",
    gap: b.layout.gap,
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
  const Heading = b.type === "hero" ? "h1" : "h2";
  const heading = (
    <>
      {b.props.title ? <Heading>{b.props.title}</Heading> : null}
      {b.props.body ? <p className="site-copy">{b.props.body}</p> : null}
    </>
  );
  let content: ReactNode;
  if (b.type === "navigation" || b.type === "sidebar")
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
        <ChartBlock block={b} context={c} />
      </>
    );
  else if (b.type === "tabs")
    content = (
      <>
        {heading}
        <TabsBlock block={b} context={c} />
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
          <img loading="lazy" src={asset.data} alt={b.props.alt || asset.alt} />
        ) : (
          <div className="site-empty">이미지를 연결하세요.</div>
        )}
        {b.props.title ? <figcaption>{b.props.title}</figcaption> : null}
      </figure>
    );
  } else if (b.type === "faq")
    content = (
      <>
        {heading}
        {b.props.items.map((i) => (
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
  else if (b.type === "cards" || b.type === "pricing")
    content = (
      <>
        {heading}
        <div className="site-grid">
          {b.props.items.map((i) => (
            <article key={i.id} className="site-card">
              {i.imageId && c.project.assets.find((a) => a.id === i.imageId) ? (
                <img
                  loading="lazy"
                  src={c.project.assets.find((a) => a.id === i.imageId)!.data}
                  alt={c.project.assets.find((a) => a.id === i.imageId)!.alt}
                />
              ) : null}
              <h3>{i.title}</h3>
              {i.price ? (
                <strong className="site-price">{i.price}</strong>
              ) : null}
              <p className="site-copy">{i.body}</p>
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
      className={`site-block block-${b.type} ${b.layout.mobileHidden ? "hide-mobile" : ""} ${b.layout.tabletHidden ? "hide-tablet" : ""} ${b.layout.desktopHidden ? "hide-desktop" : ""}`}
      style={style}
    >
      {content}
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
          .filter((p) => p.published)
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
        {b.props.menuMode === "blocks" ? (
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
              if (b.props.menuMode === "blocks") selectBlock(i.target);
              else c.execute({ kind: "navigate", target: i.target });
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
async function runtimeRequest(
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const json = record(await response.json());
  if (!response.ok || json.error)
    throw new Error(
      String(
        record(json.error).message || "저장에 실패했습니다. 다시 시도하세요.",
      ),
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
        const result = validateForm(b.props.fields, raw);
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
          setStatus(locale(c.project, "문의가 저장되었습니다."));
          form.reset();
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
          {errors[f.id] ? (
            <span id={`${b.id}-${f.id}-error`} className="site-error">
              {errors[f.id]}
            </span>
          ) : null}
        </label>
      ))}
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
    [editing, setEditing] = useState<Row | null>(null);
  const sequence = useRef(0);
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
      setEditing(null);
      setStatus(
        c.mode === "preview"
          ? "미리보기 데이터만 변경했습니다."
          : "변경 사항을 저장했습니다.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };
  const sorted = rows
    .filter((row) =>
      row.values.some((v) =>
        v.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
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
      b.props.columns.map((x) => x.label),
      sorted.map((x) => x.values),
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
          disabled={busy}
          onClick={() =>
            setEditing({ id: uid(), values: b.props.columns.map(() => "") })
          }
        >
          {b.props.primaryAction || locale(c.project, "행 추가")}
        </button>
        <button className="secondary" type="button" onClick={download}>
          {b.props.secondaryAction || locale(c.project, "CSV 다운로드")}
        </button>
      </div>
      {editing ? (
        <form
          className="site-row-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save([...rows.filter((x) => x.id !== editing.id), editing]);
          }}
        >
          {b.props.columns.map((col, i) => (
            <label key={col.id}>
              {col.label}
              <input
                required
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
      <div className="site-table-wrap">
        <table>
          <thead>
            <tr>
              {b.props.columns.map((col, i) => (
                <th
                  key={col.id}
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
                  {row.values.map((v, i) => (
                    <td key={i}>{v}</td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => setEditing(structuredClone(row))}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
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
function ChartBlock({
  block: b,
  context: c,
}: {
  block: Block;
  context: RuntimeContext;
}) {
  const [mode, setMode] = useState(b.props.chartType),
    [selected, setSelected] = useState<number | null>(null);
  const values = b.props.series;
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
          aria-label={`${b.props.title}: ${values.join(", ")}`}
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
                  {value}
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
}: {
  block: Block;
  context: RuntimeContext;
}) {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const item =
    b.props.items[Math.min(active, Math.max(0, b.props.items.length - 1))];
  return (
    <>
      <div className="site-tabs" role="tablist" aria-label={b.props.title}>
        {b.props.items.map((i, index) => (
          <button
            id={`${b.id}-tab-${i.id}`}
            key={i.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={index === active}
            aria-controls={`${b.id}-panel-${i.id}`}
            tabIndex={index === active ? 0 : -1}
            className={index === active ? "active" : "secondary"}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight")
                next = (index + 1) % b.props.items.length;
              else if (event.key === "ArrowLeft")
                next =
                  (index - 1 + b.props.items.length) % b.props.items.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = b.props.items.length - 1;
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
