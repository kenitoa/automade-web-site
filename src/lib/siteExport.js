export function createSiteFiles(project) {
  return {
    "index.html": createHtml(project),
    "styles.css": createCss(project),
    "script.js": createScript(project),
  };
}

export function createPreviewDocument(project) {
  const siteFiles = createSiteFiles(project);

  return siteFiles["index.html"]
    .replace('<link rel="stylesheet" href="./styles.css" />', `<style>\n${siteFiles["styles.css"]}\n</style>`)
    .replace('<script src="./script.js"></script>', `<script>\n${siteFiles["script.js"]}\n</script>`);
}

export function createReactProjectFiles(project) {
  return {
    "package.json": createReactPackageJson(project),
    "index.html": createReactIndexHtml(project),
    "vite.config.js": createReactViteConfig(),
    "src/main.jsx": createReactMain(),
    "src/App.jsx": createReactApp(),
    "src/projectData.js": createReactProjectData(project),
    "src/styles.css": createReactStyles(project),
    "README.md": createReactReadme(project),
  };
}

function createReactPackageJson(project) {
  return `${JSON.stringify(
    {
      name: toPackageName(project.name),
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "vite --host 127.0.0.1",
        build: "vite build",
        preview: "vite preview --host 127.0.0.1",
      },
      dependencies: {
        "@vitejs/plugin-react": "^5.0.0",
        vite: "^7.0.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {},
      overrides: {
        esbuild: "^0.28.1",
      },
    },
    null,
    2,
  )}
`;
}

function createReactIndexHtml(project) {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(project.name)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;
}

function createReactViteConfig() {
  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
  },
});
`;
}

function createReactMain() {
  return `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`;
}

function createReactProjectData(project) {
  return `export const PROJECT = ${JSON.stringify(project, null, 2)};
`;
}

function createReactApp() {
  return `import { useState } from "react";
import { PROJECT } from "./projectData.js";

function splitItems(value) {
  return String(value ?? "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNavigationItems() {
  return PROJECT.blocks
    .filter((block) => block.type !== "navigation")
    .map((block) => getBlockNavigationLabel(block))
    .filter(Boolean);
}

function getBlockNavigationLabel(block) {
  return String(block.props?.navigationLabel || block.props?.title || block.name || block.type || "").trim();
}

function getBlockSection(block, navigationItems) {
  if (!navigationItems.length || block.type === "navigation") return null;
  const explicitSection = block.props?.navigationSection;
  if (explicitSection && explicitSection !== "__auto" && explicitSection !== "__all") return explicitSection;
  const label = getBlockNavigationLabel(block);
  const labelMatch = navigationItems.find((item) => item === label);
  return labelMatch ?? label;
  const hints = {
    dashboard: ["dashboard", "대시보드", "현황"],
    builder: ["builder", "빌더", "제작", "조립"],
    data: ["data", "데이터", "자료"],
    settings: ["settings", "setting", "설정"],
  };
  const typeSections = {
    chart: "dashboard",
    table: "data",
    form: "builder",
    hero: "builder",
    shape: "builder",
    sidebar: "settings",
    tabs: "settings",
    modal: "settings",
    metrics: "dashboard",
    workflow: "builder",
  };
  const wanted = typeSections[block.type] ?? "builder";
  const matched = navigationItems.find((item) => {
    const normalized = item.toLowerCase();
    return (hints[wanted] ?? []).some((hint) => normalized.includes(hint));
  });
  return matched ?? navigationItems[0];
}

function isVisibleForSection(block, activeSection, navigationItems) {
  return (
    !activeSection ||
    block.type === "navigation" ||
    block.props?.navigationSection === "__all" ||
    getBlockSection(block, navigationItems) === activeSection
  );
}

function getTableColumns(block) {
  const columns = splitItems(block.props.body);
  return columns.length ? columns.slice(0, 4) : ["이름", "담당자", "상태"];
}

function createDefaultTableRows(block) {
  const columns = getTableColumns(block);
  const baseRows = [
    ["랜딩 페이지", "디자인 팀", "완료", "오늘"],
    ["회원 가입", "프론트엔드", "진행중", "내일"],
    ["관리자 화면", "운영팀", "검토", "이번 주"],
  ];
  return baseRows.map((row) => columns.map((_, index) => row[index] ?? ""));
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function createBlockStyle(block) {
  return {
    position: block.layout.position,
    left: block.layout.x,
    top: block.layout.y,
    width: block.layout.width,
    height: block.layout.height,
    zIndex: block.layout.zIndex,
    display: block.design.display,
    gap: block.design.gap,
    padding: block.design.padding,
    borderRadius: block.design.radius,
    background: block.design.background,
    border: block.design.border,
    color: block.design.color,
    boxShadow: block.design.shadow,
  };
}

function getTabPanelText(item) {
  const normalized = String(item ?? "").toLowerCase();
  if (normalized.includes("design") || normalized.includes("디자인")) return "색상, 간격, 형태 같은 화면 디자인 설정을 확인합니다.";
  if (normalized.includes("logic") || normalized.includes("로직")) return "버튼 클릭, 입력 저장, 데이터 전환 같은 동작 로직을 확인합니다.";
  if (normalized.includes("permission") || normalized.includes("권한")) return "사용자 권한별 접근 가능 범위를 확인합니다.";
  if (normalized.includes("deploy") || normalized.includes("배포")) return "저장 직전 배포 준비 상태를 확인합니다.";
  return String(item ?? "선택한 항목") + " 화면의 세부 내용을 표시합니다.";
}

export default function App() {
  const navigationItems = getNavigationItems();
  const [activeNavigationItem, setActiveNavigationItem] = useState(null);
  const [activeByBlock, setActiveByBlock] = useState({});
  const [messages, setMessages] = useState({});
  const [hiddenBlocks, setHiddenBlocks] = useState({});
  const [tableSort, setTableSort] = useState({});
  const [tableRows, setTableRows] = useState(() =>
    Object.fromEntries(
      PROJECT.blocks
        .filter((block) => block.type === "table")
        .map((block) => [block.id, createDefaultTableRows(block)]),
    ),
  );

  function setActive(blockId, value) {
    setActiveByBlock((current) => ({ ...current, [blockId]: value }));
  }

  function setMessage(blockId, value) {
    setMessages((current) => ({ ...current, [blockId]: value }));
  }

  function addTableRow(block) {
    const columns = getTableColumns(block);
    setTableRows((current) => ({
      ...current,
      [block.id]: [
        ...(current[block.id] ?? createDefaultTableRows(block)),
        columns.map((column, index) => (index === 0 ? "새 " + column : index === 1 ? "미지정" : "대기")),
      ],
    }));
    setMessage(block.id, "새 행을 추가했습니다.");
  }

  function removeTableRow(block, rowIndex) {
    setTableRows((current) => ({
      ...current,
      [block.id]: (current[block.id] ?? createDefaultTableRows(block)).filter((_, index) => index !== rowIndex),
    }));
    setMessage(block.id, "선택한 행을 삭제했습니다.");
  }

  function sortTable(block, columnIndex) {
    const currentSort = tableSort[block.id];
    const direction = currentSort?.columnIndex === columnIndex && currentSort.direction === "asc" ? "desc" : "asc";
    setTableRows((current) => ({
      ...current,
      [block.id]: [...(current[block.id] ?? createDefaultTableRows(block))].sort((left, right) => {
        const result = String(left[columnIndex] ?? "").localeCompare(String(right[columnIndex] ?? ""), "ko");
        return direction === "asc" ? result : -result;
      }),
    }));
    setTableSort((current) => ({ ...current, [block.id]: { columnIndex, direction } }));
  }

  function exportTableCsv(block) {
    const rows = [getTableColumns(block), ...(tableRows[block.id] ?? createDefaultTableRows(block))];
    const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\\n");
    const blob = new Blob(["\\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = block.props.title + ".csv";
    link.click();
    URL.revokeObjectURL(link.href);
    setMessage(block.id, "CSV 파일을 내보냈습니다.");
  }

  return (
    <main
      className="page-canvas"
      style={{
        width: PROJECT.canvas.width,
        height: PROJECT.canvas.height,
        minHeight: PROJECT.canvas.height,
        background: PROJECT.canvas.background,
      }}
    >
      {activeNavigationItem ? <div className="screen-badge">현재 화면: {activeNavigationItem}</div> : null}
      {PROJECT.blocks
        .filter((block) => !hiddenBlocks[block.id])
        .filter((block) => isVisibleForSection(block, activeNavigationItem, navigationItems))
        .map((block) => (
          <GeneratedBlock
            activeByBlock={activeByBlock}
            activeNavigationItem={activeNavigationItem}
            addTableRow={addTableRow}
            block={block}
            exportTableCsv={exportTableCsv}
            key={block.id}
            messages={messages}
            navigationItems={navigationItems}
            removeTableRow={removeTableRow}
            setActive={setActive}
            setActiveNavigationItem={setActiveNavigationItem}
            setHiddenBlocks={setHiddenBlocks}
            setMessage={setMessage}
            sortTable={sortTable}
            tableRows={tableRows}
            tableSort={tableSort}
          />
        ))}
    </main>
  );
}

function GeneratedBlock({
  activeByBlock,
  activeNavigationItem,
  addTableRow,
  block,
  exportTableCsv,
  messages,
  navigationItems,
  removeTableRow,
  setActive,
  setActiveNavigationItem,
  setHiddenBlocks,
  setMessage,
  sortTable,
  tableRows,
  tableSort,
}) {
  const active = activeByBlock[block.id];
  const style = createBlockStyle(block);

  if (block.type === "navigation") {
    const items = navigationItems;
    const activeItem = activeNavigationItem ?? active ?? null;
    return (
      <section className="site-block block-navigation" style={style}>
        <strong>{block.props.title}</strong>
        <nav>
          {items.map((item) => (
            <button
              className={activeItem === item ? "active secondary" : "secondary"}
              key={item}
              type="button"
              onClick={() => {
                setActive(block.id, item);
                setActiveNavigationItem(item);
                setMessage(block.id, item + " 화면을 표시합니다.");
              }}
            >
              {item}
            </button>
          ))}
        </nav>
        <button type="button" onClick={() => setMessage(block.id, block.props.primaryAction + " 동작을 실행했습니다.")}>
          {block.props.primaryAction}
        </button>
        <p role="status">{messages[block.id] ?? "현재 화면: " + activeItem}</p>
      </section>
    );
  }

  if (block.type === "form") {
    return (
      <section className="site-block" style={style}>
        <BlockText block={block} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const missing = ["audience", "dataSource"].some((name) => !String(formData.get(name) ?? "").trim());
            setMessage(block.id, missing ? "필수 입력값을 채워야 합니다." : "입력값이 저장되었습니다.");
          }}
          onReset={() => setMessage(block.id, "입력값을 초기화했습니다.")}
        >
          <label>사용자<input name="audience" required /></label>
          <label>데이터 소스<input name="dataSource" required /></label>
          <label>권한<select name="permission" defaultValue="editor"><option value="viewer">보기</option><option value="editor">편집</option><option value="admin">관리</option></select></label>
          <label>요청 내용<textarea name="request" rows="2" /></label>
          <div className="actions">
            <button type="submit">{block.props.primaryAction}</button>
            <button type="reset" className="secondary">{block.props.secondaryAction}</button>
          </div>
        </form>
        <p role="status">{messages[block.id]}</p>
      </section>
    );
  }

  if (block.type === "table") {
    const rows = tableRows[block.id] ?? createDefaultTableRows(block);
    const columns = getTableColumns(block);
    const sort = tableSort[block.id];
    return (
      <section className="site-block" style={style}>
        <BlockText block={block} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((column, columnIndex) => (
                  <th key={column}>
                    <button type="button" onClick={() => sortTable(block, columnIndex)}>
                      {column}{sort?.columnIndex === columnIndex ? " " + (sort.direction === "asc" ? "↑" : "↓") : ""}
                    </button>
                  </th>
                ))}
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {columns.map((column, columnIndex) => <td key={column}>{row[columnIndex] ?? ""}</td>)}
                  <td><button className="danger mini-button" type="button" onClick={() => removeTableRow(block, rowIndex)}>삭제</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button type="button" onClick={() => addTableRow(block)}>{block.props.primaryAction}</button>
          <button type="button" className="secondary" onClick={() => exportTableCsv(block)}>{block.props.secondaryAction}</button>
        </div>
        <p role="status">{messages[block.id] ?? rows.length + "개 행"}</p>
      </section>
    );
  }

  if (block.type === "chart") {
    const values = splitItems(block.props.body).map(Number).filter(Number.isFinite);
    const max = Math.max(...values, 1);
    const mode = active ?? "bar";
    const total = values.reduce((sum, value) => sum + value, 0);
    return (
      <section className="site-block" style={style}>
        <BlockText block={block} />
        <div className="chart-toolbar">
          {["bar", "line", "summary"].map((item) => (
            <button className={mode === item ? "active secondary" : "secondary"} key={item} type="button" onClick={() => setActive(block.id, item)}>
              {item === "bar" ? "막대" : item === "line" ? "선형" : "요약"}
            </button>
          ))}
        </div>
        {mode === "summary" ? (
          <div className="metric-grid">
            <div><strong>{total}</strong><span>합계</span></div>
            <div><strong>{values.length ? Math.round(total / values.length) : 0}</strong><span>평균</span></div>
            <div><strong>{Math.max(...values, 0)}</strong><span>최대</span></div>
          </div>
        ) : (
          <div className="chart-bars">
            {values.map((value, index) => (
              <button
                className={mode === "line" ? "chart-bar line-mode" : "chart-bar"}
                key={index}
                style={{ height: Math.max(12, (value / max) * 100) + "%" }}
                title={String(value)}
                type="button"
                onClick={() => setMessage(block.id, "선택한 값: " + value)}
              />
            ))}
          </div>
        )}
        <p role="status">{messages[block.id] ?? "합계 " + total + " / 평균 " + (values.length ? Math.round(total / values.length) : 0)}</p>
      </section>
    );
  }

  if (block.type === "tabs") {
    const items = splitItems(block.props.body);
    const activeItem = active ?? items[0];
    return (
      <section className="site-block" style={style}>
        <BlockText block={block} />
        <div className="tabs">
          {items.map((item) => (
            <button className={activeItem === item ? "active secondary" : "secondary"} key={item} type="button" onClick={() => setActive(block.id, item)}>
              {item}
            </button>
          ))}
        </div>
        <div className="tab-panel"><strong>{activeItem}</strong><p>{getTabPanelText(activeItem)}</p></div>
      </section>
    );
  }

  if (block.type === "sidebar") {
    const items = splitItems(block.props.body);
    const activeItem = active ?? items[0];
    return (
      <aside className="site-block block-sidebar" style={style}>
        <strong>{block.props.title}</strong>
        {items.map((item) => (
          <button className={activeItem === item ? "active secondary" : "secondary"} key={item} type="button" onClick={() => setActive(block.id, item)}>
            {item}
          </button>
        ))}
        <p role="status">현재 영역: {activeItem}</p>
      </aside>
    );
  }

  if (block.type === "modal") {
    return (
      <section className="site-block" style={style}>
        <BlockText block={block} />
        <div className="actions">
          <button type="button" onClick={() => setMessage(block.id, "확인했습니다.")}>{block.props.primaryAction}</button>
          <button type="button" className="secondary" onClick={() => setHiddenBlocks((current) => ({ ...current, [block.id]: true }))}>{block.props.secondaryAction}</button>
        </div>
        <p role="status">{messages[block.id]}</p>
      </section>
    );
  }

  return (
    <section className="site-block" style={style}>
      <BlockText block={block} />
      <div className="actions">
        <button type="button" onClick={() => setMessage(block.id, block.logic.events[0]?.effect ?? "실행했습니다.")}>{block.props.primaryAction}</button>
        <button type="button" className="secondary" onClick={() => setMessage(block.id, block.logic.events[1]?.effect ?? "실행했습니다.")}>{block.props.secondaryAction}</button>
      </div>
      <p role="status">{messages[block.id]}</p>
    </section>
  );
}

function BlockText({ block }) {
  return (
    <div>
      <h2>{block.props.title}</h2>
      <p>{block.props.body}</p>
    </div>
  );
}
`;
}

function createReactStyles(project) {
  return `${createBaseCss(project)}

.screen-badge {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 1000;
  border-radius: 999px;
  background: rgba(29, 37, 39, 0.84);
  color: #fff;
  font-size: 12px;
  font-weight: 900;
  padding: 8px 10px;
}
`;
}

function createReactReadme(project) {
  return `# ${project.name}

This folder is a generated React/Vite site.

## Run

\`\`\`bash
npm install
npm run dev
\`\`\`

## Build

\`\`\`bash
npm run build
\`\`\`
`;
}

function createHtml(project) {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(project.name)}</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="page-canvas" data-project-name="${escapeHtml(project.name)}"></main>
    <script id="project-data" type="application/json">${serializeJsonForScript(project)}</script>
    <script src="./script.js"></script>
  </body>
</html>
`;
}

function createCss(project) {
  return createBaseCss(project);
}

function createBaseCss(project) {
  return `:root {
  --brand-color: ${project.theme.brandColor};
  --accent-color: ${project.theme.accentColor};
  --surface-color: ${project.theme.surfaceColor};
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: ${project.canvas.width}px;
  min-height: ${project.canvas.height}px;
  color: #1d2527;
  background: #ede9dd;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
input,
select,
textarea {
  font: inherit;
}

.page-canvas {
  position: relative;
  width: ${project.canvas.width}px;
  height: ${project.canvas.height}px;
  min-height: ${project.canvas.height}px;
  overflow: hidden;
  background: ${project.canvas.background};
}

.site-block {
  overflow: hidden;
}

.site-block h2,
.site-block p {
  margin: 0;
}

.site-block p {
  line-height: 1.5;
}

.actions,
.tabs,
nav,
.chart-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

button {
  border: 1px solid var(--brand-color);
  border-radius: 6px;
  background: var(--brand-color);
  color: #ffffff;
  min-height: 34px;
  padding: 7px 10px;
  cursor: pointer;
}

button.secondary,
.secondary {
  border-color: #ddd6c8;
  background: #f3efe5;
  color: #1d2527;
}

.active {
  border-color: var(--brand-color);
  background: var(--brand-color);
  color: #ffffff;
}

form {
  display: grid;
  gap: 10px;
}

form label {
  display: grid;
  gap: 5px;
  font-weight: 700;
}

input,
select,
textarea {
  border: 1px solid #d6d0c2;
  border-radius: 6px;
  min-height: 34px;
  padding: 7px 9px;
}

.table-wrap {
  border: 1px solid #ddd6c8;
  border-radius: 6px;
  max-height: 190px;
  overflow: auto;
}

table {
  border-collapse: collapse;
  width: 100%;
}

th,
td {
  border-bottom: 1px solid #ddd6c8;
  padding: 8px;
  text-align: left;
  white-space: nowrap;
}

th {
  background: #f3efe5;
  position: sticky;
  top: 0;
}

th button {
  background: transparent;
  border: 0;
  color: #1d2527;
  min-height: 0;
  padding: 0;
}

.chart-bars {
  align-items: end;
  display: flex;
  flex: 1;
  gap: 8px;
  min-height: 130px;
}

.chart-bar {
  flex: 1;
  min-width: 18px;
  border: 0;
  border-radius: 5px 5px 0 0;
  background: linear-gradient(180deg, var(--brand-color), var(--accent-color));
  padding: 0;
}

.chart-bar.line-mode {
  background: #ffffff;
  border: 3px solid var(--brand-color);
  border-bottom-width: 5px;
}

.metric-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.metric-grid div {
  background: #f3efe5;
  border-radius: 6px;
  display: grid;
  gap: 4px;
  padding: 12px;
}

.tab-panel {
  background: #f8f6ee;
  border: 1px solid #ddd6c8;
  border-radius: 6px;
  display: grid;
  gap: 4px;
  padding: 10px;
}

.mini-button {
  min-height: 28px;
  padding: 4px 8px;
}

.danger {
  background: #8a2f24;
  border-color: #8a2f24;
  color: #ffffff;
}
`;
}

function createScript(project) {
  const data = JSON.stringify(project);

  return `const PROJECT = JSON.parse(document.getElementById("project-data").textContent);
const root = document.querySelector(".page-canvas");
root.innerHTML = "";

function splitItems(value) {
  return String(value || "").split("|").map((item) => item.trim()).filter(Boolean);
}

function getNavigationItems() {
  return PROJECT.blocks
    .filter((block) => block.type !== "navigation")
    .map((block) => getBlockNavigationLabel(block))
    .filter(Boolean);
}

function getBlockNavigationLabel(block) {
  return String((block.props && block.props.navigationLabel) || (block.props && block.props.title) || block.name || block.type || "").trim();
}

function getBlockSection(block, navigationItems) {
  if (!navigationItems.length || block.type === "navigation") return null;
  if (block.props && block.props.navigationSection && block.props.navigationSection !== "__auto" && block.props.navigationSection !== "__all") return block.props.navigationSection;
  const label = getBlockNavigationLabel(block);
  return navigationItems.find((item) => item === label) || label;
  const typeSections = { chart: "dashboard", table: "data", form: "builder", hero: "builder", shape: "builder", sidebar: "settings", tabs: "settings", modal: "settings" };
  const hints = { dashboard: ["dashboard", "대시보드"], builder: ["builder", "빌더"], data: ["data", "데이터"], settings: ["settings", "설정"] };
  const wanted = typeSections[block.type] || "builder";
  return navigationItems.find((item) => (hints[wanted] || []).some((hint) => item.toLowerCase().includes(hint))) || navigationItems[0];
}

function visible(block) {
  return !activeSection || block.type === "navigation" || (block.props && block.props.navigationSection === "__all") || getBlockSection(block, navigationItems) === activeSection;
}

function blockStyle(block) {
  return "position:" + block.layout.position + ";left:" + block.layout.x + "px;top:" + block.layout.y + "px;width:" + block.layout.width + "px;height:" + block.layout.height + "px;z-index:" + block.layout.zIndex + ";display:" + block.design.display + ";gap:" + block.design.gap + "px;padding:" + block.design.padding + "px;border-radius:" + block.design.radius + "px;background:" + block.design.background + ";border:" + block.design.border + ";color:" + block.design.color + ";box-shadow:" + (block.design.shadow || "none") + ";";
}

const navigationItems = getNavigationItems();
let activeSection = null;
const tableRows = {};
const messages = {};

function defaultRows(block) {
  const columns = splitItems(block.props.body).slice(0, 4);
  const rows = [["랜딩 페이지", "디자인 팀", "완료", "오늘"], ["회원 가입", "프론트엔드", "진행중", "내일"], ["관리자 화면", "운영팀", "검토", "이번 주"]];
  return rows.map((row) => columns.map((_, index) => row[index] || ""));
}

function render() {
  root.innerHTML = activeSection ? '<div class="screen-badge">현재 화면: ' + activeSection + '</div>' : "";
  PROJECT.blocks.filter(visible).forEach((block) => root.insertAdjacentHTML("beforeend", renderBlock(block)));
  bind();
}

function renderBlock(block) {
  const props = block.props;
  const style = blockStyle(block);
  if (block.type === "navigation") {
    return '<section class="site-block block-navigation" style="' + style + '"><strong>' + props.title + '</strong><nav>' + navigationItems.map((item) => '<button type="button" data-nav="' + item + '" class="' + (activeSection === item ? "active secondary" : "secondary") + '">' + item + '</button>').join("") + '</nav><button type="button" data-message="' + block.id + '">' + props.primaryAction + '</button><p role="status">' + (messages[block.id] || "현재 화면: " + (activeSection || "전체")) + '</p></section>';
  }
  if (block.type === "table") {
    const columns = splitItems(props.body).slice(0, 4);
    const rows = tableRows[block.id] || defaultRows(block);
    tableRows[block.id] = rows;
    return '<section class="site-block" style="' + style + '"><h2>' + props.title + '</h2><p>' + props.body + '</p><div class="table-wrap"><table><thead><tr>' + columns.map((column, index) => '<th><button type="button" data-sort="' + block.id + '" data-column="' + index + '">' + column + '</button></th>').join("") + '<th>관리</th></tr></thead><tbody>' + rows.map((row, rowIndex) => '<tr>' + columns.map((_, columnIndex) => '<td>' + (row[columnIndex] || "") + '</td>').join("") + '<td><button class="danger mini-button" type="button" data-delete-row="' + block.id + '" data-row="' + rowIndex + '">삭제</button></td></tr>').join("") + '</tbody></table></div><div class="actions"><button type="button" data-add-row="' + block.id + '">' + props.primaryAction + '</button><button type="button" class="secondary" data-export="' + block.id + '">' + props.secondaryAction + '</button></div><p role="status">' + (messages[block.id] || rows.length + "개 행") + '</p></section>';
  }
  if (block.type === "form") {
    return '<section class="site-block" style="' + style + '"><h2>' + props.title + '</h2><p>' + props.body + '</p><form data-form="' + block.id + '"><label>사용자<input name="audience" required></label><label>데이터 소스<input name="dataSource" required></label><label>권한<select name="permission"><option>보기</option><option selected>편집</option><option>관리</option></select></label><label>요청 내용<textarea name="request" rows="2"></textarea></label><div class="actions"><button type="submit">' + props.primaryAction + '</button><button class="secondary" type="reset">' + props.secondaryAction + '</button></div></form><p role="status">' + (messages[block.id] || "") + '</p></section>';
  }
  if (block.type === "chart") {
    const values = splitItems(props.body).map(Number).filter(Number.isFinite);
    const max = Math.max.apply(null, values.concat([1]));
    const total = values.reduce((sum, value) => sum + value, 0);
    return '<section class="site-block" style="' + style + '"><h2>' + props.title + '</h2><p>' + props.body + '</p><div class="chart-bars">' + values.map((value) => '<button class="chart-bar" type="button" data-chart="' + block.id + '" data-value="' + value + '" style="height:' + Math.max(12, value / max * 100) + '%"></button>').join("") + '</div><p role="status">' + (messages[block.id] || "합계 " + total + " / 평균 " + (values.length ? Math.round(total / values.length) : 0)) + '</p></section>';
  }
  if (block.type === "tabs") {
    const items = splitItems(props.body);
    return '<section class="site-block" style="' + style + '"><h2>' + props.title + '</h2><p>' + props.body + '</p><div class="tabs">' + items.map((item, index) => '<button type="button" class="' + (index === 0 ? "active secondary" : "secondary") + '">' + item + '</button>').join("") + '</div><div class="tab-panel"><strong>' + (items[0] || "") + '</strong><p>선택한 탭의 세부 내용을 표시합니다.</p></div></section>';
  }
  return '<section class="site-block" style="' + style + '"><h2>' + props.title + '</h2><p>' + props.body + '</p><div class="actions"><button type="button">' + props.primaryAction + '</button><button type="button" class="secondary">' + props.secondaryAction + '</button></div></section>';
}

function bind() {
  root.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => { activeSection = button.dataset.nav; render(); }));
  root.querySelectorAll("[data-add-row]").forEach((button) => button.addEventListener("click", () => { const block = PROJECT.blocks.find((item) => item.id === button.dataset.addRow); tableRows[block.id].push(["새 항목", "미지정", "대기", ""]); messages[block.id] = "새 행을 추가했습니다."; render(); }));
  root.querySelectorAll("[data-delete-row]").forEach((button) => button.addEventListener("click", () => { const block = PROJECT.blocks.find((item) => item.id === button.dataset.deleteRow); tableRows[block.id].splice(Number(button.dataset.row), 1); messages[block.id] = "선택한 행을 삭제했습니다."; render(); }));
  root.querySelectorAll("[data-chart]").forEach((button) => button.addEventListener("click", () => { messages[button.dataset.chart] = "선택한 값: " + button.dataset.value; render(); }));
  root.querySelectorAll("form[data-form]").forEach((form) => form.addEventListener("submit", (event) => { event.preventDefault(); messages[form.dataset.form] = "입력값이 저장되었습니다."; render(); }));
}

window.SITE_PROJECT = ${data};
render();
`;
}

function toPackageName(value) {
  const normalized = String(value ?? "generated-site")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return normalized || "generated-site";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function serializeJsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
