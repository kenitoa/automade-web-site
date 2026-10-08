import { CATALOG, createBlock, createProject } from "./catalog";
import { enhanceProject } from "./enhancements";
import { getChartData, validateTableRows } from "./content";
import { blockContrast } from "./colors";
import { normalizeLanguage } from "./languages";
import { assertProjectCompatibility } from "./packages";
import { createCmsUniqueIndex, validateCmsRecord } from "./cms";
import { getBlockDefinition } from "./blockRegistry";
import type {
  Action,
  Asset,
  Block,
  BlockType,
  Field,
  Issue,
  Project,
  Row,
} from "./types";
export class ValidationError extends Error {
  code = "INVALID_PROJECT";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max = 10000): string => {
  if (typeof value !== "string") return "";
  if (value.length > max)
    throw new ValidationError(`문자열은 ${max}자를 초과할 수 없습니다.`);
  return value;
};
const finite = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new ValidationError(`수치는 ${min}~${max} 범위여야 합니다.`);
  return value;
};
const boolean = (value: unknown, fallback = false): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new ValidationError("참 또는 거짓 값을 입력하세요.");
  return value;
};
export const safeColor = (value: unknown, fallback = "#ffffff"): string => {
  const str = text(value, 50);
  if (!str) return fallback;
  if (!/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(str))
    throw new ValidationError("색상은 HEX 형식이어야 합니다.");
  return str;
};
const id = (value: unknown): string => {
  const str = text(value, 100);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(str))
    throw new ValidationError("올바른 ID가 필요합니다.");
  return str;
};
const list = (value: unknown, max: number): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new ValidationError(`목록은 최대 ${max}개여야 합니다.`);
  return value;
};
export function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function parseAction(value: unknown): Action {
  const v = record(value);
  const kind = v.kind;
  if (kind === "navigate" || kind === "scroll" || kind === "modal")
    return { kind, target: id(v.target) };
  if (kind === "link") {
    const url = text(v.url, 2048);
    if (!safeUrl(url))
      throw new ValidationError("허용되지 않은 링크 주소입니다.");
    return { kind, url, newTab: boolean(v.newTab) };
  }
  if (kind === "submit" || kind === "download") return { kind };
  if (kind !== undefined && kind !== "none")
    throw new ValidationError("지원하지 않는 동작입니다.");
  return { kind: "none" };
}
export function parseField(value: unknown): Field {
  const v = record(value);
  const fieldId = id(v.id);
  if (["__consent", "__proto__", "constructor", "prototype"].includes(fieldId))
    throw new ValidationError("예약된 필드 ID를 사용할 수 없습니다.");
  const type = v.type;
  if (
    ![
      "text",
      "email",
      "tel",
      "number",
      "textarea",
      "select",
      "checkbox",
    ].includes(String(type))
  )
    throw new ValidationError("지원하지 않는 폼 필드입니다.");
  return {
    id: fieldId,
    label: text(v.label, 200),
    type: type as Field["type"],
    required: boolean(v.required),
    placeholder: text(v.placeholder, 300),
    min: finite(v.min, 0, -1000000, 1000000),
    max: finite(v.max, 2000, -1000000, 1000000),
    options: list(v.options, 100).map((x) => text(x, 200)),
    ...(v.description !== undefined
      ? { description: text(v.description, 2000) }
      : {}),
  };
}
export function parseRows(value: unknown, columnCount: number): Row[] {
  const rows = list(value, 10000).map((item) => {
    const r = record(item);
    const values = list(r.values, 100).map((x) => text(x, 5000));
    if (values.length !== columnCount)
      throw new ValidationError("행의 열 수가 일치하지 않습니다.");
    return { id: id(r.id), values };
  });
  if (new Set(rows.map((x) => x.id)).size !== rows.length)
    throw new ValidationError("중복된 행 ID입니다.");
  return rows;
}
function parseAsset(value: unknown): Asset {
  const v = record(value);
  const mime = v.mime;
  const data = text(v.data, 8_000_000);
  const ref = v.blobRef === undefined ? undefined : record(v.blobRef);
  const blobRef = ref
    ? {
        id: id(ref.id),
        projectId: id(ref.projectId),
        sha256: text(ref.sha256, 64),
      }
    : undefined;
  if (blobRef && !/^[a-f0-9]{64}$/.test(blobRef.sha256))
    throw new ValidationError("이미지 파일 해시를 확인하세요.");
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      String(mime),
    ) ||
    (!data && !blobRef) ||
    (Boolean(data) &&
      (!data.startsWith(`data:${String(mime)};base64,`) ||
        !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(
          data,
        )))
  )
    throw new ValidationError("허용된 이미지 파일만 사용할 수 있습니다.");
  return {
    id: id(v.id),
    name: text(v.name, 200),
    mime: mime as Asset["mime"],
    data,
    alt: text(v.alt, 1000),
    ...(blobRef ? { blobRef } : {}),
  };
}
export function parseProject(value: unknown): Project {
  assertProjectCompatibility(value);
  const v = record(value);
  if (v.schemaVersion !== 2) return migrateLegacy(value);
  const defaultProject = createProject();
  const settings = record(v.settings),
    canvas = record(v.canvas),
    theme = record(v.theme);
  const p: Project = {
    schemaVersion: 2,
    id: id(v.id),
    revision: finite(v.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    name: text(v.name, 200),
    updatedAt: text(v.updatedAt, 100),
    settings: {
      language: normalizeLanguage(settings.language ?? "ko"),
      description: text(settings.description, 2000),
      faviconAssetId: text(settings.faviconAssetId, 100),
      customLanguageText: text(settings.customLanguageText, 20000),
    },
    canvas: {
      width: finite(canvas.width, 1440, 320, 10000),
      height: finite(canvas.height, 900, 320, 50000),
      gridSize: finite(canvas.gridSize, 8, 1, 200),
      background: safeColor(canvas.background, "#f7f9fc"),
    },
    theme: {
      brandColor: safeColor(theme.brandColor, "#2563eb"),
      accentColor: safeColor(theme.accentColor, "#0f766e"),
      surfaceColor: safeColor(theme.surfaceColor),
      radius: finite(theme.radius, 16, 0, 100),
      density:
        theme.density === "compact"
          ? "compact"
          : theme.density === "spacious"
            ? "spacious"
            : "comfortable",
      font:
        theme.font === "serif"
          ? "serif"
          : theme.font === "mono"
            ? "mono"
            : "system",
    },
    pages: list(v.pages, 100).map((value) => {
      const page = record(value);
      const path = text(page.path, 200);
      if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(path))
        throw new ValidationError(
          "페이지 경로는 /로 시작하는 영문·숫자 경로여야 합니다.",
        );
      return {
        id: id(page.id),
        title: text(page.title, 200),
        path: path === "/" ? "/" : path.replace(/\/$/, ""),
        description: text(page.description, 2000),
        published: boolean(page.published, true),
        home: boolean(page.home),
      };
    }),
    blocks: [],
    assets: list(v.assets, 100).map(parseAsset),
  };
  if (!p.pages.length)
    throw new ValidationError("최소 한 페이지가 필요합니다.");
  p.blocks = list(v.blocks, 1000).map((value) => {
    const b = record(value);
    if (!CATALOG.some((x) => x.type === b.type))
      throw new ValidationError("지원하지 않는 블록입니다.");
    const base = createBlock(
      b.type as BlockType,
      defaultProject,
      p.pages[0]!.id,
    );
    const props = record(b.props),
      layout = record(b.layout),
      design = record(b.design);
    return {
      ...base,
      id: id(b.id),
      name: text(b.name, 200),
      pageId: text(b.pageId, 100),
      parentId: b.parentId ? id(b.parentId) : null,
      groupId: b.groupId ? id(b.groupId) : null,
      locked: boolean(b.locked),
      hidden: boolean(b.hidden),
      props: {
        title: text(props.title, 1000),
        body: text(props.body, 50000),
        primaryAction: text(props.primaryAction, 200),
        secondaryAction: text(props.secondaryAction, 200),
        navigationLabel: text(props.navigationLabel, 200),
        alt: text(props.alt, 1000),
        assetId: text(props.assetId, 100),
        chartType:
          props.chartType === "line"
            ? "line"
            : props.chartType === "summary"
              ? "summary"
              : "bar",
        fields: list(props.fields, 100).map(parseField),
        items: list(props.items, 100).map((value) => {
          const i = record(value);
          return {
            id: id(i.id),
            title: text(i.title, 1000),
            body: text(i.body, 20000),
            ...(i.imageId ? { imageId: id(i.imageId) } : {}),
            ...(i.price ? { price: text(i.price, 200) } : {}),
            action: parseAction(i.action),
          };
        }),
        columns: list(props.columns, 100).map((value) => {
          const c = record(value);
          return {
            id: id(c.id),
            label: text(c.label, 200),
            type:
              c.type === "number"
                ? "number"
                : c.type === "date"
                  ? "date"
                  : "text",
          };
        }),
        rows: parseRows(props.rows, list(props.columns, 100).length),
        series: list(props.series, 1000).map((x) => finite(x, 0, -1e12, 1e12)),
        dataSource: props.dataSource === "local" ? "local" : "none",
        action: parseAction(props.action),
        secondary: parseAction(props.secondary),
        menuMode: props.menuMode === "blocks" ? "blocks" : "pages",
        navigationSection: text(props.navigationSection, 100),
      },
      layout: {
        x: finite(layout.x, 32, 0, 10000),
        y: finite(layout.y, 32, 0, 50000),
        width: finite(layout.width, 560, 24, 10000),
        height: finite(layout.height, 280, 24, 50000),
        zIndex: finite(layout.zIndex, 1, 0, 10000),
        mode: layout.mode === "absolute" ? "absolute" : "flow",
        columns: finite(layout.columns, 1, 1, 12),
        gap: finite(layout.gap, 20, 0, 200),
        align:
          layout.align === "center"
            ? "center"
            : layout.align === "end"
              ? "end"
              : "start",
        mobileColumns: finite(layout.mobileColumns, 1, 1, 4),
        mobileHidden: boolean(layout.mobileHidden),
        tabletHidden: boolean(layout.tabletHidden),
        desktopHidden: boolean(layout.desktopHidden),
        minHeight: finite(layout.minHeight, 0, 0, 50000),
      },
      design: {
        background: safeColor(design.background),
        color: safeColor(design.color, "#172033"),
        borderColor: safeColor(design.borderColor, "#e2e8f0"),
        radius: finite(design.radius, 16, 0, 100),
        padding: finite(design.padding, 28, 0, 200),
        shadow: boolean(design.shadow),
      },
    } satisfies Block;
  });
  const seen = new Set<string>();
  for (const entity of [...p.pages, ...p.blocks, ...p.assets]) {
    if (seen.has(entity.id)) throw new ValidationError("중복된 ID입니다.");
    seen.add(entity.id);
  }
  if (new Set(p.pages.map((x) => x.path)).size !== p.pages.length)
    throw new ValidationError("페이지 경로가 중복됩니다.");
  if (p.pages.filter((x) => x.home).length !== 1)
    throw new ValidationError("홈 페이지는 하나여야 합니다.");
  if (
    p.pages.find((x) => x.home)?.path !== "/" ||
    p.pages.some((x) => !x.home && x.path === "/")
  )
    throw new ValidationError("홈 페이지 경로는 /이어야 합니다.");
  if (p.pages.some((x) => /^\/(api|assets|health)(\/|$)/.test(x.path)))
    throw new ValidationError(
      "시스템 예약 경로를 페이지 주소로 사용할 수 없습니다.",
    );
  if (
    !Number.isInteger(p.revision) ||
    !Number.isFinite(Date.parse(p.updatedAt))
  )
    throw new ValidationError("프로젝트 버전과 저장 시간을 확인하세요.");
  for (const b of p.blocks)
    for (const collection of [b.props.fields, b.props.items, b.props.columns])
      if (new Set(collection.map((x) => x.id)).size !== collection.length)
        throw new ValidationError("블록 내부 ID가 중복됩니다.");
  enhanceProject(p, v);
  for (const block of p.blocks) {
    const definition = getBlockDefinition(block.type);
    const errors = definition?.validate(block, p);
    if (errors?.length) throw new ValidationError(errors.join(" "));
  }
  const issues = inspectProject(p);
  const structural = issues.find((x) =>
    ["BAD_PARENT", "CYCLE", "BAD_PAGE"].includes(x.code),
  );
  if (structural) throw new ValidationError(structural.message);
  return p;
}
export function migrateLegacy(value: unknown): Project {
  const v = record(value);
  if (v.schemaVersion !== undefined && v.schemaVersion !== 1)
    throw new ValidationError("지원하지 않는 프로젝트 버전입니다.");
  if (!Array.isArray(v.blocks) || !v.theme)
    throw new ValidationError("프로젝트 형식이 올바르지 않습니다.");
  const p = createProject(
    text(v.name || v.projectName, 200) || "가져온 프로젝트",
  );
  const canvas = record(v.canvas),
    theme = record(v.theme),
    settings = record(v.settings);
  p.settings.language = normalizeLanguage(settings.language ?? "ko");
  p.settings.customLanguageText = text(settings.customLanguageText, 20000);
  p.canvas.width = finite(canvas.width, 1440, 320, 10000);
  p.canvas.height = finite(canvas.height, 900, 320, 50000);
  p.canvas.gridSize = finite(canvas.gridSize, 8, 1, 200);
  p.canvas.background = safeColor(canvas.background, "#f7f9fc");
  p.theme.brandColor = safeColor(theme.brandColor, "#2563eb");
  p.theme.accentColor = safeColor(theme.accentColor, "#0f766e");
  p.theme.surfaceColor = safeColor(theme.surfaceColor);
  p.theme.radius = finite(theme.radius, 16, 0, 100);
  p.blocks = list(v.blocks, 1000).map((value) => {
    const b = record(value),
      props = record(b.props),
      layout = record(b.layout),
      design = record(b.design);
    const type = b.type === "shape" ? "container" : b.type;
    if (!CATALOG.some((x) => x.type === type))
      throw new ValidationError(`지원하지 않는 기존 블록: ${String(type)}`);
    const block = createBlock(type as BlockType, p, p.pages[0]!.id);
    block.id = id(b.id);
    block.name = text(b.name, 200) || block.name;
    block.props.title = text(props.title, 1000);
    block.props.body = text(props.body, 50000);
    block.props.primaryAction = text(props.primaryAction, 200);
    block.props.secondaryAction = text(props.secondaryAction, 200);
    block.props.navigationLabel =
      text(props.navigationLabel, 200) || block.props.title || block.name;
    block.props.menuMode = "blocks";
    block.props.navigationSection =
      text(props.navigationSection, 100) || "__auto";
    block.layout = {
      ...block.layout,
      x: finite(layout.x, 0, 0, 10000),
      y: finite(layout.y, 0, 0, 50000),
      width: finite(layout.width, 560, 24, 10000),
      height: finite(layout.height, 280, 24, 50000),
      zIndex: finite(layout.zIndex, 1, 0, 10000),
      mode: "absolute",
    };
    block.design.background = safeColor(design.background);
    block.design.themeMode = "custom";
    block.design.color = safeColor(design.color, "#172033");
    block.design.padding = finite(design.padding, 28, 0, 200);
    block.design.radius = finite(design.radius, 16, 0, 100);
    const items = block.props.body
      .split("|")
      .map((x) => x.trim())
      .filter(Boolean);
    if (type === "chart")
      block.props.series = items.map(Number).filter(Number.isFinite);
    if (type === "table") {
      block.props.columns = items.map((label, index) => ({
        id: `column-${index}`,
        label,
        type: "text",
      }));
      block.props.rows = [];
    }
    if (type === "tabs")
      block.props.items = items.map((title, index) => ({
        id: `tab-${index}`,
        title,
        body: "",
        action: { kind: "none" },
      }));
    if (type === "form") block.props.dataSource = "none";
    return block;
  });
  return parseProject({ ...p, schemaVersion: 2 });
}
export function inspectProject(p: Project): Issue[] {
  const issues: Issue[] = [];
  const push = (
    severity: Issue["severity"],
    code: string,
    message: string,
    b?: Block,
  ) =>
    issues.push({
      severity,
      code,
      message,
      ...(b ? { blockId: b.id, pageId: b.pageId } : {}),
    });
  if (!p.name.trim()) push("error", "NAME", "프로젝트 이름을 입력하세요.");
  if (!p.settings.description.trim())
    push("warning", "DESCRIPTION", "검색·공유용 사이트 설명을 입력하세요.");
  for (const page of p.pages) {
    if (!page.title.trim())
      issues.push({
        severity: "error",
        code: "PAGE_TITLE",
        message: "페이지 제목을 입력하세요.",
        pageId: page.id,
      });
    if (
      !p.blocks.some(
        (b) =>
          b.pageId === page.id &&
          !b.hidden &&
          b.type !== "navigation" &&
          b.type !== "footer",
      )
    )
      issues.push({
        severity: "warning",
        code: "EMPTY_PAGE",
        message: `${page.title}: 콘텐츠가 없습니다.`,
        pageId: page.id,
      });
  }
  for (const b of p.blocks) {
    if (!p.pages.some((x) => x.id === b.pageId) && b.pageId !== "*")
      push("error", "BAD_PAGE", "블록의 페이지가 존재하지 않습니다.", b);
    const parent = p.blocks.find((x) => x.id === b.parentId);
    if (
      b.parentId &&
      (!parent || parent.type !== "container" || parent.pageId !== b.pageId)
    )
      push("error", "BAD_PARENT", "컨테이너 연결이 올바르지 않습니다.", b);
    const visited = new Set([b.id]);
    let cursor = parent;
    while (cursor) {
      if (visited.has(cursor.id)) {
        push("error", "CYCLE", "컨테이너 관계가 순환합니다.", b);
        break;
      }
      visited.add(cursor.id);
      cursor = p.blocks.find((x) => x.id === cursor!.parentId);
    }
    if (b.type === "form") {
      if (!b.props.fields.length)
        push("error", "FORM_FIELDS", "폼 필드를 추가하세요.", b);
      if (b.props.dataSource === "none")
        push("error", "FORM_TARGET", "폼 저장 대상을 연결하세요.", b);
      const fieldIds = new Set<string>();
      for (const f of b.props.fields) {
        if (fieldIds.has(f.id))
          push("error", "FIELD_ID", "폼 필드 ID가 중복됩니다.", b);
        fieldIds.add(f.id);
        if (!f.label)
          push("error", "FIELD_LABEL", "폼 필드 라벨이 없습니다.", b);
        if (f.min > f.max)
          push("error", "FIELD_RANGE", "폼 검증 범위가 잘못되었습니다.", b);
      }
    }
    if (b.type === "table" && !b.props.columns.length)
      push("error", "TABLE_COLUMNS", "표의 열을 추가하세요.", b);
    if (b.type === "image") {
      if (!p.assets.some((a) => a.id === b.props.assetId))
        push("warning", "IMAGE_EMPTY", "이미지를 연결하세요.", b);
      if (
        !b.props.imageSettings?.decorative &&
        !b.props.alt.trim() &&
        !p.assets.find((a) => a.id === b.props.assetId)?.alt.trim()
      )
        push("warning", "IMAGE_ALT", "이미지 대체 텍스트를 입력하세요.", b);
    }
    if (b.type === "chart" && !getChartData(p, b).values.length)
      push("warning", "CHART_EMPTY", "차트 데이터를 입력하세요.", b);
    if (
      ["tabs", "cards", "faq", "pricing"].includes(b.type) &&
      !b.props.items.length &&
      !b.props.collectionBinding
    )
      push("warning", "ITEMS_EMPTY", "표시할 항목을 추가하세요.", b);
    if (b.layout.mode === "absolute")
      push(
        "warning",
        "ABSOLUTE",
        "자유 배치 블록입니다. 작은 화면 배치를 확인하세요.",
        b,
      );
    if (
      b.layout.mode === "absolute" &&
      b.layout.x + b.layout.width > p.canvas.width
    )
      push("warning", "OVERFLOW", "블록이 화면 오른쪽 경계를 벗어납니다.", b);
    if (b.type === "hero" && !b.props.title.trim())
      push("warning", "HEADING", "첫 화면 제목을 입력하세요.", b);
    if (
      b.props.primaryAction &&
      b.props.action.kind === "none" &&
      b.type === "hero"
    )
      push(
        "warning",
        "UNCONNECTED_ACTION",
        "주요 버튼에 실행 동작을 연결하세요.",
        b,
      );
    if (
      b.type === "form" &&
      b.props.fields.some((f) => f.type === "select" && !f.options.length)
    )
      push("error", "SELECT_OPTIONS", "선택 필드에 선택지를 추가하세요.", b);
    if (blockContrast(p, b) < 4.5)
      push("warning", "CONTRAST", "글자와 배경의 명도 대비를 확인하세요.", b);
    for (const action of [
      b.props.action,
      b.props.secondary,
      ...(b.props.formSettings ? [b.props.formSettings.successAction] : []),
      ...b.props.items.map((x) => x.action),
    ]) {
      if (
        action.kind === "navigate" &&
        !p.pages.some((x) => x.id === action.target && x.published)
      )
        push(
          "error",
          "ACTION_TARGET",
          "이동 대상 페이지가 없거나 비공개입니다.",
          b,
        );
      if (
        (action.kind === "scroll" || action.kind === "modal") &&
        !p.blocks.some(
          (x) =>
            x.id === action.target &&
            (action.kind !== "modal" || x.type === "modal"),
        )
      )
        push("error", "ACTION_TARGET", "동작의 대상 블록이 없습니다.", b);
      if (action.kind === "submit" && b.type !== "form")
        push(
          "error",
          "ACTION_TYPE",
          "폼 제출은 폼에서만 사용할 수 있습니다.",
          b,
        );
      if (action.kind === "download" && b.type !== "table")
        push(
          "error",
          "ACTION_TYPE",
          "CSV 다운로드는 표에서만 사용할 수 있습니다.",
          b,
        );
    }
  }
  const home = p.pages.find((x) => x.home);
  if (!home?.published)
    push("error", "HOME_PRIVATE", "홈 페이지는 공개 상태여야 합니다.");
  for (const b of p.blocks) {
    if (
      b.props.collectionBinding &&
      !p.collections?.some(
        (c) => c.id === b.props.collectionBinding!.collectionId,
      )
    )
      push(
        "error",
        "COLLECTION_TARGET",
        "연결할 콘텐츠 컬렉션을 선택하세요.",
        b,
      );
    if (b.props.chartBinding) {
      const binding = b.props.chartBinding;
      const table = p.blocks.find(
        (x) => x.id === binding.tableBlockId && x.type === "table",
      );
      if (
        !table ||
        !table.props.columns.some(
          (c) => c.id === binding.valueColumnId && c.type === "number",
        ) ||
        !table.props.columns.some((c) => c.id === binding.labelColumnId)
      )
        push(
          "error",
          "CHART_TARGET",
          "차트에 연결할 표와 숫자 열을 확인하세요.",
          b,
        );
    }
    if (b.type === "table")
      for (const error of validateTableRows(b.props.columns, b.props.rows))
        push("error", "TABLE_RULE", `행 ${error.row + 1}: ${error.message}`, b);
    if (
      b.props.formSettings?.consentRequired &&
      !b.props.formSettings.privacyNotice.trim()
    )
      push(
        "error",
        "CONSENT_NOTICE",
        "동의를 받을 개인정보 안내를 입력하세요.",
        b,
      );
    if (
      /실제 내용을 입력|실제 서비스 소개|연락처와 운영 정보를 입력|첫 번째 항목|두 번째 항목/.test(
        `${b.props.body} ${b.props.items.map((i) => `${i.title} ${i.body}`).join(" ")}`,
      )
    )
      push("warning", "PLACEHOLDER", "기본 안내를 실제 정보로 바꾸세요.", b);
    if (
      b.props.primaryAction &&
      ["자세히 보기", "확인"].includes(b.props.primaryAction) &&
      b.type === "hero"
    )
      push(
        "warning",
        "ACTION_LABEL",
        "버튼의 목적을 구체적인 문구로 표시하세요.",
        b,
      );
  }
  for (const page of p.pages) {
    const headings = p.blocks
      .filter((b) => !b.hidden && (b.pageId === page.id || b.pageId === "*"))
      .sort((a, b) => a.layout.zIndex - b.layout.zIndex)
      .filter(
        (b) =>
          b.props.title &&
          !["navigation", "sidebar", "footer", "divider"].includes(b.type),
      );
    if (
      headings.filter(
        (b) => (b.props.headingLevel ?? (b.type === "hero" ? 1 : 2)) === 1,
      ).length > 1
    )
      issues.push({
        severity: "warning",
        code: "HEADING_COUNT",
        message: "페이지의 대표 제목을 하나로 정리하세요.",
        pageId: page.id,
        field: "props.headingLevel",
      });
    if (page.published && !page.seo?.noIndex && !p.settings.siteUrl)
      issues.push({
        severity: "warning",
        code: "SITE_URL",
        message: "공개 배포 후 대표 HTTPS 주소를 설정하세요.",
        pageId: page.id,
        field: "settings.siteUrl",
        method: "manual",
      });
    if (
      p.settings.languages?.length &&
      p.settings.languages.some(
        (lang) =>
          lang !== p.settings.language && !page.translations?.[lang]?.title,
      )
    )
      issues.push({
        severity: "warning",
        code: "TRANSLATION",
        message: "추가 언어의 페이지 제목을 입력하세요.",
        pageId: page.id,
        field: "translations",
      });
  }
  for (const collection of p.collections ?? []) {
    const uniqueIndex = createCmsUniqueIndex(collection);
    for (const item of collection.records)
      for (const message of validateCmsRecord(
        p,
        collection,
        item,
        undefined,
        uniqueIndex,
      ))
        issues.push({
          severity:
            item.status === "published" || item.workflow?.state === "scheduled"
              ? "error"
              : "warning",
          code: "CMS_VALUE",
          message,
          field: `collections.${collection.id}.records.${item.id}.values`,
        });
    for (const field of collection.schema ?? [])
      if (
        field.type === "reference" &&
        field.public &&
        collection.access !== "members" &&
        p.collections?.find(
          (target) => target.id === field.referenceCollectionId,
        )?.access === "members"
      )
        issues.push({
          severity: "error",
          code: "CMS_PRIVATE_REFERENCE",
          message: "공개 관계 필드를 회원 콘텐츠에 연결할 수 없습니다.",
          field: `collections.${collection.id}.schema.${field.id}`,
        });
  }
  return issues.map((issue) => {
    const fields: Record<string, string> = {
      NAME: "name",
      DESCRIPTION: "settings.description",
      PAGE_TITLE: "title",
      FORM_FIELDS: "props.fields",
      FORM_TARGET: "props.dataSource",
      FIELD_LABEL: "props.fields",
      FIELD_RANGE: "props.fields",
      SELECT_OPTIONS: "props.fields",
      TABLE_COLUMNS: "props.columns",
      TABLE_RULE: "props.rows",
      IMAGE_EMPTY: "props.assetId",
      IMAGE_ALT: "props.alt",
      CHART_EMPTY: "props.series",
      CHART_TARGET: "props.chartBinding",
      COLLECTION_TARGET: "props.collectionBinding",
      ITEMS_EMPTY: "props.items",
      ABSOLUTE: "layout.mode",
      OVERFLOW: "layout.width",
      HEADING: "props.title",
      UNCONNECTED_ACTION: "props.action",
      ACTION_TARGET: "props.action",
      ACTION_TYPE: "props.action",
      CONTRAST: "design.color",
      CONSENT_NOTICE: "props.formSettings",
      PLACEHOLDER: "props.body",
      ACTION_LABEL: "props.primaryAction",
    };
    return {
      ...issue,
      field: issue.field ?? fields[issue.code],
      impact:
        issue.impact ??
        (issue.severity === "error"
          ? "생성 또는 방문자의 주요 동작이 실패할 수 있습니다."
          : "방문자가 내용을 이해하거나 사용하는 데 어려움이 생길 수 있습니다."),
      remedy: issue.remedy ?? issue.message,
      method: issue.method ?? "automatic",
    };
  });
}
export function validateForm(
  fields: Field[],
  value: unknown,
  settings?: Block["props"]["formSettings"],
): { values: Record<string, string>; errors: Record<string, string> } {
  const raw = record(value),
    values: Record<string, string> = {},
    errors: Record<string, string> = {};
  for (const f of fields) {
    const v = typeof raw[f.id] === "string" ? String(raw[f.id]).trim() : "";
    values[f.id] = v;
    if (f.required && (!v || (f.type === "checkbox" && v !== "true")))
      errors[f.id] = `${f.label}을(를) 입력해 주세요.`;
    else if (v) {
      if (f.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n) || n < f.min || n > f.max)
          errors[f.id] = "허용 범위의 숫자를 입력하세요.";
      } else if (v.length < f.min || v.length > f.max)
        errors[f.id] = `${f.min}~${f.max}자 범위로 입력하세요.`;
      if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
        errors[f.id] = "이메일 형식을 확인하세요.";
      if (f.type === "select" && !f.options.includes(v))
        errors[f.id] = "선택값을 확인하세요.";
      if (f.type === "checkbox" && v !== "true")
        errors[f.id] = "체크값을 확인하세요.";
    }
  }
  if (settings?.consentRequired) {
    if (raw.__consent !== "true")
      errors.__consent = "개인정보 안내를 확인하고 동의하세요.";
    else values.__consent = "true";
  }
  return { values, errors };
}
export const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
export function csv(columns: string[], rows: string[][]): string {
  const escape = (v: string) => {
    const s = /^[\s]*[=+@-]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return (
    "\ufeff" +
    [columns, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")
  );
}
