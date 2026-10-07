export type BlockType =
  | "hero"
  | "navigation"
  | "sidebar"
  | "form"
  | "table"
  | "chart"
  | "tabs"
  | "modal"
  | "image"
  | "text"
  | "cards"
  | "faq"
  | "pricing"
  | "footer"
  | "container"
  | "divider";
export type Action =
  | { kind: "none" }
  | { kind: "navigate"; target: string }
  | { kind: "scroll"; target: string }
  | { kind: "link"; url: string; newTab: boolean }
  | { kind: "modal"; target: string }
  | { kind: "submit" }
  | { kind: "download" };
export interface Field {
  id: string;
  label: string;
  type:
    "text" | "email" | "tel" | "number" | "textarea" | "select" | "checkbox";
  required: boolean;
  placeholder: string;
  min: number;
  max: number;
  options: string[];
}
export interface Item {
  id: string;
  title: string;
  body: string;
  imageId?: string;
  price?: string;
  action: Action;
}
export interface TableColumn {
  id: string;
  label: string;
  type: "text" | "number" | "date";
}
export interface Row {
  id: string;
  values: string[];
}
export interface Layout {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  mode: "flow" | "absolute";
  columns: number;
  gap: number;
  align: "start" | "center" | "end";
  mobileColumns: number;
  mobileHidden: boolean;
  tabletHidden: boolean;
  desktopHidden: boolean;
  minHeight: number;
}
export interface Design {
  background: string;
  color: string;
  borderColor: string;
  radius: number;
  padding: number;
  shadow: boolean;
}
export interface Block {
  id: string;
  type: BlockType;
  name: string;
  pageId: string;
  parentId: string | null;
  groupId: string | null;
  locked: boolean;
  hidden: boolean;
  props: {
    title: string;
    body: string;
    primaryAction: string;
    secondaryAction: string;
    navigationLabel: string;
    alt: string;
    assetId: string;
    chartType: "bar" | "line" | "summary";
    fields: Field[];
    items: Item[];
    columns: TableColumn[];
    rows: Row[];
    series: number[];
    dataSource: "none" | "local";
    action: Action;
    secondary: Action;
    menuMode: "pages" | "blocks";
    navigationSection: string;
  };
  layout: Layout;
  design: Design;
}
export interface Page {
  id: string;
  title: string;
  path: string;
  description: string;
  published: boolean;
  home: boolean;
}
export interface Asset {
  id: string;
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  alt: string;
}
export interface Project {
  schemaVersion: 2;
  id: string;
  revision: number;
  name: string;
  updatedAt: string;
  settings: {
    language: "ko" | "en";
    description: string;
    faviconAssetId: string;
    customLanguageText: string;
  };
  canvas: {
    width: number;
    height: number;
    gridSize: number;
    background: string;
  };
  theme: {
    brandColor: string;
    accentColor: string;
    surfaceColor: string;
    radius: number;
    density: "compact" | "comfortable" | "spacious";
    font: "system" | "serif" | "mono";
  };
  pages: Page[];
  blocks: Block[];
  assets: Asset[];
}
export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  blockId?: string;
  pageId?: string;
  field?: string;
}
export interface SiteConfig {
  project: Project;
  mode: "preview" | "site";
  apiBase: string;
}
export interface ExportResult {
  id: string;
  url: string;
  path: string;
  entry: string;
  source: string;
  issues: Issue[];
  durationMs: number;
}
export interface ApiEnvelope<T> {
  data: T | null;
  error: { code: string; message: string; requestId?: string } | null;
  meta?: Record<string, unknown>;
}
