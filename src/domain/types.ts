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
  | "divider"
  | "automade:timeline"
  | "extension";
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
  description?: string;
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
  required?: boolean;
  unique?: boolean;
  readOnly?: boolean;
  hidden?: boolean;
  width?: number;
  order?: number;
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
  responsive?: { tablet?: ResponsiveStyle; mobile?: ResponsiveStyle };
}
export interface Design {
  background: string;
  color: string;
  borderColor: string;
  radius: number;
  padding: number;
  shadow: boolean;
  themeMode?: "theme" | "custom";
  fontSize?: number;
  headingSize?: number;
  lineHeight?: number;
  animation?: "none" | "fade" | "slide";
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
  definitionVersion?: number;
  componentLink?: {
    componentId: string;
    instanceId?: string;
    sourceBlockId?: string;
    version: number;
    overrides: string[];
  };
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
    navigationBehavior?: "section" | "scroll";
    headingLevel?: 1 | 2 | 3;
    richText?: RichParagraph[];
    imageSettings?: {
      decorative: boolean;
      fit: "cover" | "contain";
      ratio: number;
      focalX: number;
      focalY: number;
    };
    formSettings?: {
      successMessage: string;
      successAction: Action;
      privacyNotice: string;
      consentRequired: boolean;
      category: string;
    };
    collectionBinding?: {
      collectionId: string;
      category: string;
      limit: number;
      detailLinks: boolean;
    };
    chartBinding?: {
      tableBlockId: string;
      labelColumnId: string;
      valueColumnId: string;
      unit: string;
      xLabel: string;
      yLabel: string;
    };
    chartLabels?: string[];
    extensionDefinitionId?: string;
    dataBinding?: DataBinding;
    translations?: Partial<
      Record<
        SiteLanguage,
        {
          title: string;
          body: string;
          primaryAction: string;
          secondaryAction: string;
        }
      >
    >;
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
  access?: "public" | "members";
  navigation?: boolean;
  aliases?: string[];
  seo?: {
    title: string;
    description: string;
    imageAssetId: string;
    noIndex: boolean;
  };
  translations?: Partial<
    Record<SiteLanguage, { title: string; description: string }>
  >;
}
export interface Asset {
  id: string;
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  alt: string;
  width?: number;
  height?: number;
  bytes?: number;
  source?: string;
  license?: string;
  blobId?: string;
  blobRef?: { id: string; sha256: string; projectId: string };
}
export interface Project {
  schemaVersion: 2;
  id: string;
  revision: number;
  name: string;
  updatedAt: string;
  settings: {
    language: SiteLanguage;
    description: string;
    faviconAssetId: string;
    customLanguageText: string;
    brief?: {
      purpose: "business" | "portfolio" | "service" | "workspace";
      audience: string;
      primaryGoal: string;
      tone: string;
      materials: string[];
    };
    siteUrl?: string;
    languages?: SiteLanguage[];
    languageFallbacks?: Record<SiteLanguage, SiteLanguage>;
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
    typography?: {
      bodySize: number;
      headingSize: number;
      lineHeight: number;
      sectionGap: number;
      contentWidth: number;
    };
    button?: { radius: number; padding: number };
  };
  pages: Page[];
  blocks: Block[];
  assets: Asset[];
  collections?: ContentCollection[];
  featurePins?: FeaturePin[];
  blockPackages?: DeclarativeBlockPackage[];
  components?: SharedComponent[];
  componentHistory?: SharedComponent[];
  brandPacks?: BrandPack[];
  industryPacks?: IndustryPack[];
  extensions?: {
    favorites?: BlockType[];
    recentBlocks?: BlockType[];
    reusableSections?: SavedSection[];
    archived?: boolean;
    checklist?: { id: string; label: string; checked: boolean }[];
  };
}
export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  blockId?: string;
  pageId?: string;
  field?: string;
  impact?: string;
  remedy?: string;
  method?: "automatic" | "manual";
}
export type SiteLanguage = string;
export interface ResponsiveStyle {
  columns?: number;
  gap?: number;
  padding?: number;
  fontSize?: number;
  headingSize?: number;
}
export interface RichParagraph {
  kind: "paragraph" | "bullet" | "ordered";
  spans: { text: string; bold?: boolean; italic?: boolean; href?: string }[];
}
export interface ContentRecord {
  id: string;
  slug: string;
  title: string;
  body: string;
  category: string;
  imageId: string;
  status: "draft" | "published";
  publishedAt: string;
  fields: Record<string, string>;
  translations?: Partial<
    Record<
      SiteLanguage,
      { title: string; body: string; values?: Record<string, CmsValue> }
    >
  >;
  values?: Record<string, CmsValue>;
  archivedValues?: Record<string, CmsValue>;
  workflow?: ContentWorkflow;
  contentRevision?: number;
  publication?: import("./contentContracts").ContentPublication;
  fieldRevisions?: Record<string, number>;
  languageRevisions?: Record<string, number>;
  translationReviews?: Record<
    string,
    import("./contentContracts").TranslationReview
  >;
  localizedSlugs?: Partial<Record<SiteLanguage, string>>;
  addressHistory?: { path: string; language: SiteLanguage; sequence: number }[];
}
export interface ContentCollection {
  id: string;
  name: string;
  path: string;
  access?: "public" | "members";
  records: ContentRecord[];
  schema?: CmsFieldDefinition[];
  schemaRevision?: number;
  queryMode?: "snapshot" | "server";
}
export type CmsValue = string | number | boolean | null | string[];
export interface CmsFieldDefinition {
  id: string;
  label: string;
  type: "text" | "number" | "boolean" | "date" | "enum" | "image" | "reference";
  required?: boolean;
  unique?: boolean;
  public?: boolean;
  readOnly?: boolean;
  options?: string[];
  referenceCollectionId?: string;
  min?: number;
  max?: number;
  localized?: boolean;
}
export interface ContentWorkflow {
  state:
    "draft" | "review" | "approved" | "scheduled" | "published" | "archived";
  publishAt?: string;
  approvedRevision?: number;
}
export interface FeaturePin {
  packageId: string;
  version: string;
  integrity: string;
}
export interface DeclarativeBlockDefinition {
  id: string;
  name: string;
  description: string;
  template: "text" | "cards" | "faq" | "pricing" | "automade:timeline";
  defaults: Partial<
    Pick<Block["props"], "title" | "body" | "primaryAction" | "secondaryAction">
  >;
}
export interface DeclarativeBlockPackage {
  id: string;
  name: string;
  version: string;
  integrity: string;
  protocol: 1;
  definitions: DeclarativeBlockDefinition[];
  dependencies?: { packageId: string; range: string }[];
  release?: {
    authorId: string;
    reason: string;
    deprecated?: boolean;
    approved?: boolean;
  };
}
export interface SharedComponent {
  id: string;
  name: string;
  version: number;
  blocks: Block[];
}
export interface BrandPack {
  id: string;
  name: string;
  version: number;
  theme: Project["theme"];
}
export interface IndustryPack {
  id: string;
  name: string;
  version: number;
  sections: SavedSection[];
  brandPackId?: string;
}
export interface DataBinding {
  connectionId: string;
  limit: number;
  mapping: {
    title?: string;
    body?: string;
    image?: string;
    value?: string;
    label?: string;
  };
}
export interface CmsQueryResult {
  records: ContentRecord[];
  nextCursor: string | null;
  total: number;
  schemaRevision: number;
}
export interface SavedSection {
  id: string;
  name: string;
  blocks: Block[];
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
