import { BLOCK_CATALOG } from "../data/blockCatalog.js";

export const DEFAULT_PROJECT = {
  name: "나의 인터페이스 프로젝트",
  settings: {
    language: "ko",
    customLanguageText: "",
  },
  canvas: {
    width: 1440,
    height: 900,
    background: "#f7f5ef",
    gridSize: 60,
    unit: "px",
  },
  theme: {
    brandColor: "#256f6b",
    accentColor: "#b85c38",
    surfaceColor: "#f7f5ef",
    radius: 8,
    density: "comfortable",
  },
  blocks: [],
};

export function createProject() {
  return structuredClone(DEFAULT_PROJECT);
}

export function getCatalogItem(type) {
  return BLOCK_CATALOG.find((item) => item.type === type);
}

export function createBlock(type, placement = {}) {
  const catalogItem = getCatalogItem(type);
  const gridSize = placement.gridSize ?? DEFAULT_PROJECT.canvas.gridSize;

  if (!catalogItem) {
    throw new Error(`Unknown block type: ${type}`);
  }

  const width = snapSize(placement.width ?? catalogItem.size.width, gridSize);
  const height = snapSize(placement.height ?? catalogItem.size.height, gridSize);

  return {
    id: crypto.randomUUID(),
    type,
    name: catalogItem.name,
    props: structuredClone(catalogItem.defaultProps),
    layout: {
      x: snapToGrid(placement.x ?? 40, gridSize),
      y: snapToGrid(placement.y ?? 40, gridSize),
      width,
      height,
      zIndex: placement.zIndex ?? 1,
      position: "absolute",
    },
    design: structuredClone(catalogItem.design),
    logic: structuredClone(catalogItem.logic),
  };
}

export function addBlock(project, type) {
  const offset = project.blocks.length * 24;
  const block = createBlock(type, {
    x: 48 + offset,
    y: 48 + offset,
    zIndex: project.blocks.length + 1,
    gridSize: project.canvas.gridSize,
  });

  return appendBlock(project, block);
}

export function placeBlock(project, type, point) {
  const catalogItem = getCatalogItem(type);
  const size = catalogItem?.size ?? { width: 240, height: 160 };
  const block = createBlock(type, {
    x: Math.max(0, point.x - Math.round(size.width / 2)),
    y: Math.max(0, point.y - Math.round(size.height / 2)),
    zIndex: project.blocks.length + 1,
    gridSize: project.canvas.gridSize,
  });

  return appendBlock(project, clampBlockToCanvas(block, project.canvas));
}

export function addShapeBlock(project, rect) {
  const width = Math.max(24, Math.round(rect.width));
  const height = Math.max(24, Math.round(rect.height));
  const block = createBlock("hero", {
    x: rect.x,
    y: rect.y,
    width,
    height,
    zIndex: project.blocks.length + 1,
    gridSize: project.canvas.gridSize,
  });

  return appendBlock(project, {
    ...block,
    type: "shape",
    name: "위젯 영역",
    props: {
      ...block.props,
      title: "위젯 영역",
      body: `${rect.preset ?? "custom"} preset | ${width} x ${height}`,
      primaryAction: "선택",
      secondaryAction: "수정",
      alignment: "shape",
    },
    design: {
      ...block.design,
      background: "#dfe8e5",
      border: "2px solid #256f6b",
    },
    logic: {
      componentName: "PlacedWidgetArea",
      state: [],
      events: [{ name: "onSelect", trigger: "widget click", effect: "select widget area" }],
      dataInputs: ["layout", "design"],
    },
  });
}

function appendBlock(project, block) {
  return {
    project: {
      ...project,
      blocks: [...project.blocks, block],
    },
    block,
  };
}

export function duplicateBlock(project, blockId) {
  const source = project.blocks.find((block) => block.id === blockId);

  if (!source) {
    return { project, block: null };
  }

  const copy = {
    ...structuredClone(source),
    id: crypto.randomUUID(),
    props: {
      ...structuredClone(source.props),
      title: `${source.props.title} copy`,
    },
    layout: {
      ...source.layout,
      x: source.layout.x + project.canvas.gridSize,
      y: source.layout.y + project.canvas.gridSize,
      zIndex: project.blocks.length + 1,
    },
  };

  const sourceIndex = project.blocks.findIndex((block) => block.id === blockId);
  const blocks = [...project.blocks];
  blocks.splice(sourceIndex + 1, 0, clampBlockToCanvas(copy, project.canvas));

  return {
    project: {
      ...project,
      blocks,
    },
    block: copy,
  };
}

export function updateBlock(project, blockId, updates) {
  return {
    ...project,
    blocks: project.blocks.map((block) => {
      if (block.id !== blockId) {
        return block;
      }

      const { layout, design, logic, shape, props, ...propUpdates } = updates;
      const nextBlock = {
        ...block,
        props: {
          ...block.props,
          ...(props ?? propUpdates),
        },
        layout: {
          ...block.layout,
          ...(layout ?? {}),
        },
        design: {
          ...block.design,
          ...(design ?? {}),
        },
        logic: {
          ...block.logic,
          ...(logic ?? {}),
        },
      };

      if (shape) {
        nextBlock.layout = {
          ...nextBlock.layout,
          x: Math.max(0, Number(shape.x ?? nextBlock.layout.x)),
          y: Math.max(0, Number(shape.y ?? nextBlock.layout.y)),
          width: Math.max(24, Number(shape.width ?? nextBlock.layout.width)),
          height: Math.max(24, Number(shape.height ?? nextBlock.layout.height)),
        };
        nextBlock.design = {
          ...nextBlock.design,
          background: shape.fill ?? nextBlock.design.background,
        };
      }

      return clampBlockToCanvas(nextBlock, project.canvas);
    }),
  };
}

export function removeBlock(project, blockId) {
  return {
    ...project,
    blocks: project.blocks.filter((block) => block.id !== blockId),
  };
}

export function moveBlock(project, blockId, direction) {
  const index = project.blocks.findIndex((block) => block.id === blockId);
  const nextIndex = direction === "up" ? index - 1 : index + 1;

  if (index < 0 || nextIndex < 0 || nextIndex >= project.blocks.length) {
    return project;
  }

  const blocks = [...project.blocks];
  const [block] = blocks.splice(index, 1);
  blocks.splice(nextIndex, 0, block);

  return {
    ...project,
    blocks: blocks.map((item, itemIndex) => ({
      ...item,
      layout: {
        ...item.layout,
        zIndex: itemIndex + 1,
      },
    })),
  };
}

export function updateTheme(project, updates) {
  return {
    ...project,
    theme: {
      ...project.theme,
      ...updates,
    },
  };
}

export function updateCanvas(project, updates) {
  const canvas = {
    ...project.canvas,
    ...updates,
  };
  canvas.gridSize = normalizeGridSize(canvas.gridSize);

  return {
    ...project,
    canvas,
    blocks: project.blocks.map((block) => clampBlockToCanvas(block, canvas)),
  };
}

export function updateSettings(project, updates) {
  return {
    ...project,
    settings: {
      ...DEFAULT_PROJECT.settings,
      ...project.settings,
      ...updates,
    },
  };
}

function clampBlockToCanvas(block, canvas) {
  const gridSize = canvas.gridSize ?? DEFAULT_PROJECT.canvas.gridSize;
  const width = Math.max(gridSize, Math.min(snapSize(block.layout?.width ?? 240, gridSize), canvas.width));
  const height = Math.max(gridSize, Math.min(snapSize(block.layout?.height ?? 160, gridSize), canvas.height));

  return {
    ...block,
    layout: {
      ...block.layout,
      width,
      height,
      x: Math.max(0, Math.min(snapToGrid(block.layout?.x ?? 0, gridSize), canvas.width - width)),
      y: Math.max(0, Math.min(snapToGrid(block.layout?.y ?? 0, gridSize), canvas.height - height)),
    },
  };
}

function snapToGrid(value, gridSize) {
  const safeGridSize = normalizeGridSize(gridSize);
  return Math.round(Number(value ?? 0) / safeGridSize) * safeGridSize;
}

function snapSize(value, gridSize) {
  const safeGridSize = normalizeGridSize(gridSize);
  return Math.max(
    safeGridSize,
    Math.round(Number(value ?? safeGridSize) / safeGridSize) * safeGridSize,
  );
}

function normalizeGridSize(value) {
  const gridSize = Number(value);
  return Number.isFinite(gridSize) && gridSize >= 10
    ? Math.round(gridSize)
    : DEFAULT_PROJECT.canvas.gridSize;
}

function normalizeBlock(block, index, canvas) {
  const catalogItem = getCatalogItem(block.type);
  const base = catalogItem ? createBlock(block.type, block.layout) : createBlock("hero", block.layout);

  return clampBlockToCanvas(
    {
      ...base,
      ...block,
      props: {
        ...base.props,
        ...block.props,
      },
      layout: {
        ...base.layout,
        ...block.layout,
        zIndex: block.layout?.zIndex ?? index + 1,
      },
      design: {
        ...base.design,
        ...block.design,
      },
      logic: {
        ...base.logic,
        ...block.logic,
      },
    },
    canvas,
  );
}

export function sanitizeProject(value) {
  if (!value || !Array.isArray(value.blocks) || !value.theme) {
    return createProject();
  }

  const canvas = {
    ...DEFAULT_PROJECT.canvas,
    ...value.canvas,
  };
  canvas.gridSize = normalizeGridSize(canvas.gridSize);

  return {
    ...createProject(),
    ...value,
    canvas,
    theme: {
      ...DEFAULT_PROJECT.theme,
      ...value.theme,
    },
    settings: {
      ...DEFAULT_PROJECT.settings,
      ...value.settings,
    },
    blocks: value.blocks
      .filter((block) => block && block.id && block.type && block.props)
      .map((block, index) => normalizeBlock(block, index, canvas)),
  };
}
