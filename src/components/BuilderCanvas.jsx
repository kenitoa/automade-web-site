import { useMemo, useRef, useState } from "react";
import { BLOCK_CATALOG } from "../data/blockCatalog.js";
import {
  createDefaultTableRows,
  escapeCsvCell,
  getNavigationItems,
  getTableColumns,
  isBlockVisibleForSection,
  sanitizeFileName,
  splitItems,
} from "../lib/blockRuntime.js";

export default function BuilderCanvas({
  project,
  selectedId,
  placementType,
  t,
  onSelect,
  onPlaceBlock,
  onUpdateBlockLayout,
  onUpdateCanvas,
}) {
  const canvasRef = useRef(null);
  const [hoverPoint, setHoverPoint] = useState(null);
  const [dropType, setDropType] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [resizeState, setResizeState] = useState(null);
  const [activeByBlock, setActiveByBlock] = useState({});
  const [activeNavigationItem, setActiveNavigationItem] = useState(null);
  const [messages, setMessages] = useState({});
  const [tableRows, setTableRows] = useState({});
  const [tableSort, setTableSort] = useState({});
  const navigationItems = useMemo(() => getNavigationItems(project), [project]);
  const currentNavigationItem = navigationItems.includes(activeNavigationItem) ? activeNavigationItem : null;
  const rawGridSize = Number(project.canvas.gridSize);
  const gridSize = Number.isFinite(rawGridSize) && rawGridSize >= 10 ? rawGridSize : 60;
  const placementBlock = useMemo(
    () => BLOCK_CATALOG.find((block) => block.type === (dropType ?? placementType)) ?? null,
    [dropType, placementType],
  );

  function getCanvasPoint(event) {
    const bounds = canvasRef.current.getBoundingClientRect();

    return {
      x: Math.round(event.clientX - bounds.left),
      y: Math.round(event.clientY - bounds.top),
    };
  }

  function snapToGrid(value) {
    return Math.round(Number(value ?? 0) / gridSize) * gridSize;
  }

  function snapSize(value) {
    return Math.max(gridSize, Math.round(Number(value ?? gridSize) / gridSize) * gridSize);
  }

  function getPlacementPoint(point, block) {
    const width = snapSize(block.size.width);
    const height = snapSize(block.size.height);

    return {
      x: snapToGrid(point.x - width / 2) + width / 2,
      y: snapToGrid(point.y - height / 2) + height / 2,
    };
  }

  function handleCanvasClick(event) {
    if (dragState || resizeState || !placementBlock || event.target.closest(".site-block")) {
      return;
    }

    onPlaceBlock(getPlacementPoint(getCanvasPoint(event), placementBlock));
  }

  function handlePointerMove(event) {
    const point = getCanvasPoint(event);

    if (resizeState) {
      onUpdateBlockLayout(resizeState.blockId, getResizedLayout(resizeState, point));
      return;
    }

    if (dragState) {
      onUpdateBlockLayout(dragState.blockId, {
        x: point.x - dragState.offsetX,
        y: point.y - dragState.offsetY,
      });
      return;
    }

    if (!placementBlock) {
      return;
    }

    setHoverPoint(point);
  }

  function handleDragOver(event) {
    const dragTypes = Array.from(event.dataTransfer.types);
    const blockType = dragTypes.includes("application/x-interface-block")
      ? event.dataTransfer.getData("application/x-interface-block")
      : placementType;

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropType(blockType || placementType);
    setHoverPoint(getCanvasPoint(event));
  }

  function handleDrop(event) {
    const blockType = event.dataTransfer.getData("application/x-interface-block") || placementType;
    const block = BLOCK_CATALOG.find((item) => item.type === blockType);

    event.preventDefault();
    setDropType(null);
    setHoverPoint(null);

    if (block) {
      onPlaceBlock(getPlacementPoint(getCanvasPoint(event), block), blockType);
    }
  }

  function handleBlockPointerDown(event, block) {
    if (isInteractiveTarget(event.target)) {
      event.stopPropagation();
      onSelect(block.id);
      return;
    }

    const point = getCanvasPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    onSelect(block.id);
    setHoverPoint(null);
    setDragState({
      blockId: block.id,
      offsetX: point.x - block.layout.x,
      offsetY: point.y - block.layout.y,
    });
  }

  function handleResizePointerDown(event, block, handle) {
    const point = getCanvasPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    onSelect(block.id);
    setHoverPoint(null);
    setResizeState({
      blockId: block.id,
      handle,
      startPoint: point,
      startLayout: { ...block.layout },
    });
  }

  function finishDrag() {
    setDragState(null);
    setResizeState(null);
  }

  function setBlockActive(blockId, value) {
    setActiveByBlock((current) => ({ ...current, [blockId]: value }));
  }

  function setNavigationActive(blockId, value) {
    setBlockActive(blockId, value);
    setActiveNavigationItem(value);
    setBlockMessage(blockId, `${value} 화면을 표시합니다.`);
  }

  function setBlockMessage(blockId, value) {
    setMessages((current) => ({ ...current, [blockId]: value }));
  }

  function getRows(block) {
    return tableRows[block.id] ?? createDefaultTableRows(block);
  }

  function updateRows(block, updater) {
    setTableRows((current) => {
      const currentRows = current[block.id] ?? createDefaultTableRows(block);
      return {
        ...current,
        [block.id]: updater(currentRows),
      };
    });
  }

  function addTableRow(block) {
    const columns = getTableColumns(block);
    updateRows(block, (rows) => [
      ...rows,
      columns.map((column, index) => (index === 0 ? `새 ${column}` : index === 1 ? "미지정" : "대기")),
    ]);
    setBlockMessage(block.id, "새 행을 추가했습니다.");
  }

  function removeTableRow(block, rowIndex) {
    updateRows(block, (rows) => rows.filter((_, index) => index !== rowIndex));
    setBlockMessage(block.id, "선택한 행을 삭제했습니다.");
  }

  function sortTable(block, columnIndex) {
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
    setBlockMessage(block.id, `${getTableColumns(block)[columnIndex] ?? "열"} 기준으로 정렬했습니다.`);
  }

  function exportTableCsv(block) {
    const rows = [getTableColumns(block), ...getRows(block)];
    const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${sanitizeFileName(block.props.title)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    setBlockMessage(block.id, "CSV 파일을 내보냈습니다.");
  }

  const ghostStyle =
    placementBlock && hoverPoint && !dragState && !resizeState
      ? {
          left: `${Math.max(0, snapToGrid(hoverPoint.x - snapSize(placementBlock.size.width) / 2))}px`,
          top: `${Math.max(0, snapToGrid(hoverPoint.y - snapSize(placementBlock.size.height) / 2))}px`,
          width: `${snapSize(placementBlock.size.width)}px`,
          height: `${snapSize(placementBlock.size.height)}px`,
        }
      : null;

  return (
    <section className="panel canvas-panel" aria-label="Website canvas">
      <div className="panel-header canvas-header">
        <div>
          <span className="eyebrow">{t("canvasKicker")}</span>
          <h2>{t("canvasTitle")}</h2>
        </div>
        <div className="canvas-controls">
          <label>
            W
            <input
              min="320"
              type="number"
              value={project.canvas.width}
              onChange={(event) => onUpdateCanvas({ width: Number(event.target.value) })}
            />
          </label>
          <label>
              H
            <input
              min="320"
              type="number"
              value={project.canvas.height}
              onChange={(event) => onUpdateCanvas({ height: Number(event.target.value) })}
            />
          </label>
          <label>
            GRID
            <span className="grid-stepper" aria-label="Grid size control">
              <button
                aria-label="Decrease grid size"
                type="button"
                onClick={() => onUpdateCanvas({ gridSize: Math.max(10, gridSize - 10) })}
              >
                -
              </button>
              <output>{gridSize}</output>
              <button
                aria-label="Increase grid size"
                type="button"
                onClick={() => onUpdateCanvas({ gridSize: gridSize + 10 })}
              >
                +
              </button>
            </span>
          </label>
          <span className="count-label">
            {project.blocks.length} {t("blockCount")}
          </span>
        </div>
      </div>

      <div className="site-canvas-shell">
        <div className="canvas-ruler">
          {project.canvas.width} x {project.canvas.height}px
          {placementBlock ? ` | ${placementBlock.name} 배치 모드` : ""}
        </div>
        <div className="site-canvas-scroll">
          <div
            className="site-canvas"
            ref={canvasRef}
            style={{
              width: `${project.canvas.width}px`,
              height: `${project.canvas.height}px`,
              "--canvas-background": project.canvas.background,
              "--grid-size": `${gridSize}px`,
            }}
            onClick={handleCanvasClick}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onPointerLeave={() => {
              setHoverPoint(null);
              setDropType(null);
            }}
          >
            {ghostStyle ? (
              <div className="placement-ghost" style={ghostStyle}>
                <strong>{placementBlock.name}</strong>
                <span>
                  {placementBlock.size.width} x {placementBlock.size.height}
                </span>
              </div>
            ) : null}

            {currentNavigationItem ? (
              <div className="navigation-filter-label" data-no-drag="true">
                현재 화면: {currentNavigationItem}
              </div>
            ) : null}

            {project.blocks
              .filter((block) => isBlockVisibleForSection(block, currentNavigationItem, navigationItems))
              .map((block) => (
              <PlacedBlock
                activeValue={activeByBlock[block.id]}
                activeNavigationItem={currentNavigationItem}
                block={block}
                isSelected={selectedId === block.id}
                key={block.id}
                message={messages[block.id]}
                navigationItems={navigationItems}
                onSelect={onSelect}
                onPointerDown={handleBlockPointerDown}
                onResizePointerDown={handleResizePointerDown}
                onSetActive={setBlockActive}
                onSetNavigationActive={setNavigationActive}
                onSetMessage={setBlockMessage}
                tableRows={getRows(block)}
                tableSort={tableSort[block.id]}
                onAddTableRow={addTableRow}
                onExportTableCsv={exportTableCsv}
                onRemoveTableRow={removeTableRow}
                onSortTable={sortTable}
              />
            ))}
          </div>
        </div>
      </div>

    </section>
  );
}

function isInteractiveTarget(target) {
  return Boolean(
    target?.closest(
      "button, input, textarea, select, label, a, table, [role='button'], [contenteditable='true'], [data-no-drag='true']",
    ),
  );
}

function getResizedLayout(state, point) {
  const minSize = 32;
  const deltaX = point.x - state.startPoint.x;
  const deltaY = point.y - state.startPoint.y;
  const next = { ...state.startLayout };

  if (state.handle.includes("e")) {
    next.width = Math.max(minSize, state.startLayout.width + deltaX);
  }

  if (state.handle.includes("s")) {
    next.height = Math.max(minSize, state.startLayout.height + deltaY);
  }

  if (state.handle.includes("w")) {
    const width = Math.max(minSize, state.startLayout.width - deltaX);
    next.x = state.startLayout.x + (state.startLayout.width - width);
    next.width = width;
  }

  if (state.handle.includes("n")) {
    const height = Math.max(minSize, state.startLayout.height - deltaY);
    next.y = state.startLayout.y + (state.startLayout.height - height);
    next.height = height;
  }

  return {
    x: Math.round(next.x),
    y: Math.round(next.y),
    width: Math.round(next.width),
    height: Math.round(next.height),
  };
}

function PlacedBlock({
  activeValue,
  activeNavigationItem,
  block,
  isSelected,
  message,
  navigationItems,
  onAddTableRow,
  onExportTableCsv,
  onPointerDown,
  onRemoveTableRow,
  onResizePointerDown,
  onSelect,
  onSetActive,
  onSetNavigationActive,
  onSetMessage,
  onSortTable,
  tableRows,
  tableSort,
}) {
  const style = {
    left: `${block.layout.x}px`,
    top: `${block.layout.y}px`,
    width: `${block.layout.width}px`,
    height: `${block.layout.height}px`,
    zIndex: block.layout.zIndex,
    display: block.design.display,
    gap: `${block.design.gap}px`,
    padding: `${block.design.padding}px`,
    borderRadius: `${block.design.radius}px`,
    background: block.design.background,
    border: block.design.border,
    color: block.design.color,
    boxShadow: block.design.shadow ?? undefined,
  };

  return (
    <article
      className={`site-block tone-${block.props.tone} ${isSelected ? "selected" : ""}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(block.id);
      }}
      onPointerDown={(event) => onPointerDown(event, block)}
    >
      <BlockContent
        activeValue={activeValue}
        activeNavigationItem={activeNavigationItem}
        block={block}
        message={message}
        navigationItems={navigationItems}
        onAddTableRow={onAddTableRow}
        onExportTableCsv={onExportTableCsv}
        onRemoveTableRow={onRemoveTableRow}
        onSetActive={onSetActive}
        onSetNavigationActive={onSetNavigationActive}
        onSetMessage={onSetMessage}
        onSortTable={onSortTable}
        tableRows={tableRows}
        tableSort={tableSort}
      />
      {isSelected ? (
        <ResizeHandles block={block} onResizePointerDown={onResizePointerDown} />
      ) : null}
    </article>
  );
}

function ResizeHandles({ block, onResizePointerDown }) {
  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  return handles.map((handle) => (
    <button
      aria-label={`Resize ${handle}`}
      className={`resize-handle handle-${handle}`}
      key={handle}
      type="button"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => onResizePointerDown(event, block, handle)}
    />
  ));
}

function BlockContent({
  activeValue,
  activeNavigationItem,
  block,
  message,
  navigationItems,
  onAddTableRow,
  onExportTableCsv,
  onRemoveTableRow,
  onSetActive,
  onSetNavigationActive,
  onSetMessage,
  onSortTable,
  tableRows,
  tableSort,
}) {
  if (block.type === "navigation") {
    const items = navigationItems;
    const activeItem = activeNavigationItem ?? activeValue ?? null;

    return (
      <div className="site-nav-content">
        <strong>{block.props.title}</strong>
        <nav>
          {items.map((item) => (
            <button
              className={activeItem === item ? "active secondary" : "secondary"}
              data-no-drag="true"
              key={item}
              type="button"
              onClick={() => onSetNavigationActive(block.id, item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <button
          data-no-drag="true"
          type="button"
          onClick={() => onSetMessage(block.id, `${block.props.primaryAction} 동작을 실행했습니다.`)}
        >
          {block.props.primaryAction}
        </button>
        <StatusMessage message={message ?? `현재 화면: ${activeItem ?? "없음"}`} />
      </div>
    );
  }

  if (block.type === "sidebar") {
    const items = splitItems(block.props.body);
    const activeItem = activeValue ?? items[0];

    return (
      <div className="site-sidebar-content">
        <strong>{block.props.title}</strong>
        {items.map((item) => (
          <button
            className={activeItem === item ? "active" : ""}
            data-no-drag="true"
            type="button"
            key={item}
            onClick={() => {
              onSetActive(block.id, item);
              onSetMessage(block.id, `${item} 영역을 선택했습니다.`);
            }}
          >
            {item}
          </button>
        ))}
        <StatusMessage message={message ?? `현재 영역: ${activeItem ?? "없음"}`} />
      </div>
    );
  }

  if (block.type === "form") {
    return (
      <>
        <BlockText block={block} />
        <form
          className="editor-form"
          data-no-drag="true"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            const requiredValues = ["audience", "dataSource"].map((name) => String(formData.get(name) ?? "").trim());

            if (requiredValues.some((value) => !value)) {
              onSetMessage(block.id, "필수 입력값을 채워야 합니다.");
              return;
            }

            onSetMessage(block.id, "입력값이 저장되었습니다.");
          }}
          onReset={() => onSetMessage(block.id, "입력값을 초기화했습니다.")}
        >
          <label>
            사용자
            <input name="audience" placeholder="예: 관리자" required />
          </label>
          <label>
            데이터 소스
            <input name="dataSource" placeholder="예: 고객 DB" required />
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
            <textarea name="request" placeholder="필요한 화면 기능을 입력하세요." rows="2" />
          </label>
          <div className="site-block-actions">
            <button type="submit">{block.props.primaryAction}</button>
            <button className="secondary" type="reset">
              {block.props.secondaryAction}
            </button>
          </div>
        </form>
        <StatusMessage message={message} />
      </>
    );
  }

  if (block.type === "table") {
    const columns = getTableColumns(block);

    return (
      <>
        <BlockText block={block} />
        <div className="editor-table-wrap" data-no-drag="true">
          <table className="editor-table">
            <thead>
              <tr>
                {columns.map((column, columnIndex) => (
                  <th key={column}>
                    <button type="button" onClick={() => onSortTable(block, columnIndex)}>
                      {column}
                      {tableSort?.columnIndex === columnIndex ? ` ${tableSort.direction === "asc" ? "↑" : "↓"}` : ""}
                    </button>
                  </th>
                ))}
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, rowIndex) => (
                <tr key={`${block.id}-${rowIndex}`}>
                  {columns.map((column, columnIndex) => (
                    <td key={`${column}-${columnIndex}`}>{row[columnIndex] ?? ""}</td>
                  ))}
                  <td>
                    <button className="icon-action danger" type="button" onClick={() => onRemoveTableRow(block, rowIndex)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="site-block-actions" data-no-drag="true">
          <button type="button" onClick={() => onAddTableRow(block)}>
            {block.props.primaryAction}
          </button>
          <button className="secondary" type="button" onClick={() => onExportTableCsv(block)}>
            {block.props.secondaryAction}
          </button>
        </div>
        <StatusMessage message={message ?? `${tableRows.length}개 행`} />
      </>
    );
  }

  if (block.type === "chart") {
    const values = splitItems(block.props.body)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    const max = Math.max(...values, 1);

    return (
      <>
        <BlockText block={block} />
        <div className="chart-toolbar" data-no-drag="true">
          <button
            className={activeValue === "bar" || !activeValue ? "active secondary" : "secondary"}
            type="button"
            onClick={() => onSetActive(block.id, "bar")}
          >
            막대
          </button>
          <button
            className={activeValue === "line" ? "active secondary" : "secondary"}
            type="button"
            onClick={() => onSetActive(block.id, "line")}
          >
            선형
          </button>
          <button
            className={activeValue === "summary" ? "active secondary" : "secondary"}
            type="button"
            onClick={() => onSetActive(block.id, "summary")}
          >
            요약
          </button>
        </div>
        <div className="site-chart-content" data-no-drag="true">
          {values.map((value, index) => (
            <button
              aria-label={`${index + 1}번째 값 ${value}`}
              className={`chart-bar-button ${activeValue === "line" ? "line-mode" : ""}`}
              key={`${value}-${index}`}
              style={{ height: `${Math.max(12, (value / max) * 100)}%` }}
              title={String(value)}
              type="button"
              onClick={() => onSetMessage(block.id, `선택한 값: ${value}`)}
            />
          ))}
        </div>
        <StatusMessage
          message={
            message ??
            `합계 ${values.reduce((sum, value) => sum + value, 0)} / 평균 ${
              values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0
            }`
          }
        />
      </>
    );
  }

  if (block.type === "tabs") {
    const items = splitItems(block.props.body);
    const activeItem = activeValue ?? items[0];

    return (
      <>
        <BlockText block={block} />
        <div className="site-tabs-content" data-no-drag="true">
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
        <div className="tab-panel" data-no-drag="true">
          <strong>{activeItem ?? "탭 없음"}</strong>
          <p>{getTabPanelText(activeItem)}</p>
        </div>
      </>
    );
  }

  if (block.type === "modal") {
    return (
      <>
        <BlockText block={block} />
        <div className="site-block-actions" data-no-drag="true">
          <button type="button" onClick={() => onSetMessage(block.id, "확인했습니다.")}>
            {block.props.primaryAction}
          </button>
          <button className="secondary" type="button" onClick={() => onSetMessage(block.id, "취소했습니다.")}>
            {block.props.secondaryAction}
          </button>
        </div>
        <StatusMessage message={message} />
      </>
    );
  }

  return (
    <>
      <BlockText block={block} />
      <div className="site-block-actions" data-no-drag="true">
        <button type="button" onClick={() => onSetMessage(block.id, block.logic.events[0]?.effect ?? "실행했습니다.")}>
          {block.props.primaryAction}
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => onSetMessage(block.id, block.logic.events[1]?.effect ?? "실행했습니다.")}
        >
          {block.props.secondaryAction}
        </button>
      </div>
      <StatusMessage message={message} />
    </>
  );
}

function BlockText({ block }) {
  return (
    <div>
      <h3>{block.props.title}</h3>
      <p>{block.props.body}</p>
    </div>
  );
}

function StatusMessage({ message }) {
  return message ? (
    <p className="editor-status" data-no-drag="true" role="status">
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
