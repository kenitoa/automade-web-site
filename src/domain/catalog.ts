import type { BlockType, Block, Project } from "./types";
import { BLOCK_REGISTRY, initializeRegisteredBlock } from "./blockRegistry";
export const CATALOG = BLOCK_REGISTRY;
export const uid = (): string => crypto.randomUUID();
export function createProject(name = "새 웹사이트"): Project {
  const pageId = uid();
  return {
    schemaVersion: 2,
    id: uid(),
    revision: 0,
    name,
    updatedAt: new Date().toISOString(),
    settings: {
      language: "ko",
      description: "",
      faviconAssetId: "",
      customLanguageText: "",
    },
    canvas: { width: 1440, height: 900, gridSize: 8, background: "#f7f9fc" },
    theme: {
      brandColor: "#2563eb",
      accentColor: "#0f766e",
      surfaceColor: "#ffffff",
      radius: 16,
      density: "comfortable",
      font: "system",
    },
    pages: [
      {
        id: pageId,
        title: "홈",
        path: "/",
        description: "",
        published: true,
        home: true,
      },
    ],
    blocks: [],
    assets: [],
  };
}
export function createBlock(
  type: BlockType,
  project: Project,
  pageId: string,
): Block {
  const name = CATALOG.find((item) => item.type === type)?.name ?? type;
  const block: Block = {
    id: uid(),
    type,
    name,
    pageId,
    parentId: null,
    groupId: null,
    locked: false,
    hidden: false,
    props: {
      title: name,
      body: "",
      primaryAction: "자세히 보기",
      secondaryAction: "",
      navigationLabel: name,
      alt: "",
      assetId: "",
      chartType: "bar",
      fields: [],
      items: [],
      columns: [],
      rows: [],
      series: [],
      dataSource: "none",
      action: { kind: "none" },
      secondary: { kind: "none" },
      menuMode: "pages",
      navigationSection: "__auto",
    },
    layout: {
      x: 32,
      y: 32,
      width: 560,
      height: 280,
      zIndex: project.blocks.length + 1,
      mode: "flow",
      columns: 1,
      gap: 20,
      align: "start",
      mobileColumns: 1,
      mobileHidden: false,
      tabletHidden: false,
      desktopHidden: false,
      minHeight: 0,
    },
    design: {
      background: project.theme.surfaceColor,
      color: "#172033",
      borderColor: "#e2e8f0",
      radius: project.theme.radius,
      padding: 28,
      shadow: false,
      themeMode: "theme",
    },
  };
  initializeRegisteredBlock(block, project);
  return block;
}
