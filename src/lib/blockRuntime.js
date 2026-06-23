export function splitItems(value) {
  return String(value ?? "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getBlockNavigationLabel(block) {
  return String(block.props?.navigationLabel || block.props?.title || block.name || block.type || "").trim();
}

export function getNavigationItems(project) {
  return project.blocks
    .filter((block) => block.type !== "navigation")
    .map((block) => getBlockNavigationLabel(block))
    .filter(Boolean);
}

export function getDefaultNavigationItem(project) {
  return getNavigationItems(project)[0] ?? null;
}

export function getBlockSection(block, navigationItems) {
  if (!navigationItems.length || block.type === "navigation") {
    return null;
  }

  const explicitSection = block.props?.navigationSection;

  if (explicitSection && explicitSection !== "__auto" && explicitSection !== "__all") {
    return explicitSection;
  }

  const label = getBlockNavigationLabel(block);
  const matched = navigationItems.find((item) => item === label);
  return matched ?? label;
}

export function isBlockVisibleForSection(block, activeSection, navigationItems) {
  if (!activeSection || block.type === "navigation") {
    return true;
  }

  if (block.props?.navigationSection === "__all") {
    return true;
  }

  return getBlockSection(block, navigationItems) === activeSection;
}

export function getTableColumns(block) {
  const columns = splitItems(block.props.body);
  return columns.length ? columns.slice(0, 4) : ["이름", "담당자", "상태"];
}

export function createDefaultTableRows(block) {
  const columns = getTableColumns(block);
  const baseRows = [
    ["랜딩 페이지", "디자인 팀", "완료", "오늘"],
    ["회원 가입", "프론트엔드", "진행중", "내일"],
    ["관리자 화면", "운영팀", "검토", "이번 주"],
  ];

  return baseRows.map((row) => columns.map((_, index) => row[index] ?? ""));
}

export function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sanitizeFileName(value) {
  return (
    String(value ?? "table")
      .replace(/[<>:"/\\|?*]+/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "table"
  );
}
