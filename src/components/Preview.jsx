import { useMemo, useState } from "react";
import {
  createDefaultTableRows,
  escapeCsvCell,
  getNavigationItems,
  getTableColumns,
  isBlockVisibleForSection,
  sanitizeFileName,
  splitItems,
} from "../lib/blockRuntime.js";

export default function Preview({ project, t }) {
  const navigationItems = useMemo(() => getNavigationItems(project), [project]);
  const [activeNavigationItem, setActiveNavigationItem] = useState(null);
  const [activeByBlock, setActiveByBlock] = useState({});
  const [messages, setMessages] = useState({});
  const [tableRows, setTableRows] = useState({});
  const [tableSort, setTableSort] = useState({});
  const currentNavigationItem = navigationItems.includes(activeNavigationItem) ? activeNavigationItem : null;
  const style = {
    "--brand-color": project.theme.brandColor,
    "--accent-color": project.theme.accentColor,
    "--surface-color": project.theme.surfaceColor,
    "--preview-radius": `${project.theme.radius}px`,
  };

  function setActive(blockId, value) {
    setActiveByBlock((current) => ({ ...current, [blockId]: value }));
  }

  function setMessage(blockId, value) {
    setMessages((current) => ({ ...current, [blockId]: value }));
  }

  function getRows(block) {
    return tableRows[block.id] ?? createDefaultTableRows(block);
  }

  function updateRows(block, updater) {
    setTableRows((current) => {
      const currentRows = current[block.id] ?? createDefaultTableRows(block);
      return { ...current, [block.id]: updater(currentRows) };
    });
  }

  function addRow(block) {
    const columns = getTableColumns(block);
    updateRows(block, (rows) => [
      ...rows,
      columns.map((column, index) => (index === 0 ? `새 ${column}` : index === 1 ? "미지정" : "대기")),
    ]);
    setMessage(block.id, "새 행을 추가했습니다.");
  }

  function removeRow(block, rowIndex) {
    updateRows(block, (rows) => rows.filter((_, index) => index !== rowIndex));
    setMessage(block.id, "선택한 행을 삭제했습니다.");
  }

  function sortRows(block, columnIndex) {
    const currentSort = tableSort[block.id];
    const direction =
      currentSort?.columnIndex === columnIndex && currentSort.direction === "asc" ? "desc" : "asc";

    updateRows(block, (rows) =>
      [...rows].sort((left, right) => {
        const result = String(left[columnIndex] ?? "").localeCompare(String(right[columnIndex] ?? ""), "ko");
        return direction === "asc" ? result : -result;
      }),
    );
    setTableSort((current) => ({ ...current, [block.id]: { columnIndex, direction } }));
  }

  function exportCsv(block) {
    const rows = [getTableColumns(block), ...getRows(block)];
    const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${sanitizeFileName(block.props.title)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    setMessage(block.id, "CSV 파일을 내보냈습니다.");
  }

  return (
    <section className="panel preview-panel" aria-label="Live preview">
      <div className="panel-header preview-header">
        <div>
          <span className="eyebrow">{t("previewKicker")}</span>
          <h2>{t("previewTitle")}</h2>
        </div>
        <span className="count-label">{currentNavigationItem ?? project.name}</span>
      </div>

      <div className="preview-stage" style={style}>
        {project.blocks.length === 0 ? (
          <div className="preview-empty">{t("previewEmpty")}</div>
        ) : (
          project.blocks
            .filter((block) => isBlockVisibleForSection(block, currentNavigationItem, navigationItems))
            .map((block) => (
              <PreviewBlock
                activeNavigationItem={currentNavigationItem}
                activeValue={activeByBlock[block.id]}
                block={block}
                key={block.id}
                message={messages[block.id]}
                navigationItems={navigationItems}
                onAddRow={addRow}
                onExportCsv={exportCsv}
                onRemoveRow={removeRow}
                onSetActive={setActive}
                onSetMessage={setMessage}
                onSetNavigationItem={(value) => {
                  setActiveNavigationItem(value);
                  setMessage(block.id, `${value} 화면을 표시합니다.`);
                }}
                onSortRows={sortRows}
                rows={getRows(block)}
                sort={tableSort[block.id]}
              />
            ))
        )}
      </div>
    </section>
  );
}

function PreviewBlock({
  activeNavigationItem,
  activeValue,
  block,
  message,
  navigationItems,
  onAddRow,
  onExportCsv,
  onRemoveRow,
  onSetActive,
  onSetMessage,
  onSetNavigationItem,
  onSortRows,
  rows,
  sort,
}) {
  const { props, type } = block;
  const className = `preview-block tone-${props.tone} density-${props.density} align-${props.alignment}`;

  if (type === "navigation") {
    const items = navigationItems;
    const activeItem = activeNavigationItem ?? null;

    return (
      <article className={className}>
        <div className="nav-preview">
          <strong>{props.title}</strong>
          <div>
            {items.map((item) => (
              <button
                className={activeItem === item ? "active" : "secondary"}
                key={item}
                type="button"
                onClick={() => onSetNavigationItem(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => onSetMessage(block.id, `${props.primaryAction} 동작을 실행했습니다.`)}>
            {props.primaryAction}
          </button>
        </div>
        <StatusMessage message={message ?? `현재 화면: ${activeItem ?? "없음"}`} />
      </article>
    );
  }

  if (type === "form") {
    return (
      <article className={className}>
        <BlockHeading props={props} />
        <form
          className="preview-form"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const missing = ["audience", "dataSource"].some((name) => !String(formData.get(name) ?? "").trim());
            onSetMessage(block.id, missing ? "필수 입력값을 채워야 합니다." : "입력값이 저장 전 미리보기에 반영되었습니다.");
          }}
          onReset={() => onSetMessage(block.id, "입력값을 초기화했습니다.")}
        >
          <label>
            사용자
            <input name="audience" required />
          </label>
          <label>
            데이터 소스
            <input name="dataSource" required />
          </label>
          <label>
            권한
            <select name="permission" defaultValue="editor">
              <option value="viewer">보기</option>
              <option value="editor">편집</option>
              <option value="admin">관리</option>
            </select>
          </label>
          <label>
            요청 내용
            <textarea name="request" rows="2" />
          </label>
          <BlockActions props={props} submit />
        </form>
        <StatusMessage message={message} />
      </article>
    );
  }

  if (type === "table") {
    const columns = getTableColumns(block);

    return (
      <article className={className}>
        <BlockHeading props={props} />
        <div className="preview-table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((column, columnIndex) => (
                  <th key={column}>
                    <button type="button" onClick={() => onSortRows(block, columnIndex)}>
                      {column}
                      {sort?.columnIndex === columnIndex ? ` ${sort.direction === "asc" ? "↑" : "↓"}` : ""}
                    </button>
                  </th>
                ))}
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${block.id}-${rowIndex}`}>
                  {columns.map((column, columnIndex) => (
                    <td key={`${column}-${columnIndex}`}>{row[columnIndex] ?? ""}</td>
                  ))}
                  <td>
                    <button className="danger mini-button" type="button" onClick={() => onRemoveRow(block, rowIndex)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="preview-actions">
          <button type="button" onClick={() => onAddRow(block)}>
            {props.primaryAction}
          </button>
          <button className="secondary" type="button" onClick={() => onExportCsv(block)}>
            {props.secondaryAction}
          </button>
        </div>
        <StatusMessage message={message ?? `${rows.length}개 행`} />
      </article>
    );
  }

  if (type === "chart") {
    const values = splitItems(props.body).map(Number).filter(Number.isFinite);
    const total = values.reduce((sum, value) => sum + value, 0);
    const max = Math.max(...values, 1);
    const mode = activeValue ?? "bar";

    return (
      <article className={className}>
        <BlockHeading props={props} />
        <div className="chart-toolbar">
          {["bar", "line", "summary"].map((item) => (
            <button
              className={mode === item ? "active secondary" : "secondary"}
              key={item}
              type="button"
              onClick={() => onSetActive(block.id, item)}
            >
              {item === "bar" ? "막대" : item === "line" ? "선형" : "요약"}
            </button>
          ))}
        </div>
        {mode === "summary" ? (
          <div className="metric-grid">
            <div className="metric-item">
              <strong>{total}</strong>
              <span>합계</span>
            </div>
            <div className="metric-item">
              <strong>{values.length ? Math.round(total / values.length) : 0}</strong>
              <span>평균</span>
            </div>
            <div className="metric-item">
              <strong>{Math.max(...values, 0)}</strong>
              <span>최대</span>
            </div>
          </div>
        ) : (
          <div className="chart-preview">
            {values.map((value, index) => (
              <button
                className={`chart-bar ${mode === "line" ? "line-mode" : ""}`}
                key={`${value}-${index}`}
                style={{ height: `${Math.max(12, (value / max) * 100)}%` }}
                title={`${value}`}
                type="button"
                onClick={() => onSetMessage(block.id, `선택한 값: ${value}`)}
              />
            ))}
          </div>
        )}
        <StatusMessage message={message ?? `합계 ${total} / 평균 ${values.length ? Math.round(total / values.length) : 0}`} />
      </article>
    );
  }

  if (type === "tabs") {
    const items = splitItems(props.body);
    const activeItem = activeValue ?? items[0];

    return (
      <article className={className}>
        <BlockHeading props={props} />
        <div className="tabs-preview">
          {items.map((item) => (
            <button
              className={activeItem === item ? "active" : ""}
              type="button"
              key={item}
              onClick={() => onSetActive(block.id, item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="tab-panel">
          <strong>{activeItem ?? "탭 없음"}</strong>
          <p>{getTabPanelText(activeItem)}</p>
        </div>
      </article>
    );
  }

  if (type === "sidebar") {
    const items = splitItems(props.body);
    const activeItem = activeValue ?? items[0];

    return (
      <article className={className}>
        <BlockHeading props={props} />
        <div className="sidebar-preview">
          {items.map((item) => (
            <button
              className={activeItem === item ? "active" : ""}
              type="button"
              key={item}
              onClick={() => onSetActive(block.id, item)}
            >
              {item}
            </button>
          ))}
        </div>
        <StatusMessage message={`현재 영역: ${activeItem ?? "없음"}`} />
      </article>
    );
  }

  if (type === "modal") {
    return (
      <article className={className}>
        <div className="modal-preview">
          <BlockHeading props={props} />
          <div className="preview-actions">
            <button type="button" onClick={() => onSetMessage(block.id, "확인했습니다.")}>
              {props.primaryAction}
            </button>
            <button className="secondary" type="button" onClick={() => onSetMessage(block.id, "취소했습니다.")}>
              {props.secondaryAction}
            </button>
          </div>
          <StatusMessage message={message} />
        </div>
      </article>
    );
  }

  return (
    <article className={className}>
      <BlockHeading props={props} />
      <div className="preview-actions">
        <button type="button" onClick={() => onSetMessage(block.id, block.logic.events[0]?.effect ?? "실행했습니다.")}>
          {props.primaryAction}
        </button>
        <button className="secondary" type="button" onClick={() => onSetMessage(block.id, block.logic.events[1]?.effect ?? "실행했습니다.")}>
          {props.secondaryAction}
        </button>
      </div>
      <StatusMessage message={message} />
    </article>
  );
}

function BlockHeading({ props }) {
  return (
    <div className="preview-copy">
      <h3>{props.title || "제목 없는 블록"}</h3>
      <p>{props.body || "설정 패널에서 설명을 입력하세요."}</p>
    </div>
  );
}

function BlockActions({ props, submit = false }) {
  return (
    <div className="preview-actions">
      <button type={submit ? "submit" : "button"}>{props.primaryAction || "주요 버튼"}</button>
      <button className="secondary" type={submit ? "reset" : "button"}>
        {props.secondaryAction || "보조 버튼"}
      </button>
    </div>
  );
}

function StatusMessage({ message }) {
  return message ? (
    <p className="editor-status" role="status">
      {message}
    </p>
  ) : null;
}

function getTabPanelText(item) {
  const normalized = String(item ?? "").toLowerCase();

  if (normalized.includes("design") || normalized.includes("디자인")) {
    return "색상, 간격, 형태 같은 화면 디자인 설정을 확인합니다.";
  }

  if (normalized.includes("logic") || normalized.includes("로직")) {
    return "버튼 클릭, 입력 저장, 데이터 전환 같은 동작 로직을 확인합니다.";
  }

  if (normalized.includes("permission") || normalized.includes("권한")) {
    return "사용자 권한별 접근 가능 범위를 확인합니다.";
  }

  if (normalized.includes("deploy") || normalized.includes("배포")) {
    return "저장 직전 배포 준비 상태를 확인합니다.";
  }

  return `${item ?? "선택한 항목"} 화면의 세부 내용을 표시합니다.`;
}
