import type { BlockType, Block, Project } from "./types";
export interface BlockReference {
  type:
    | "block"
    | "page"
    | "asset"
    | "collection"
    | "connection"
    | "component"
    | "package";
  id: string;
  path: string;
}
export interface BlockEditorField {
  path: string;
  label: string;
  control: "text" | "items" | "image" | "fields" | "columns" | "series";
}
const metadata: ReadonlyArray<{
  type: BlockType;
  name: string;
  category: string;
  description: string;
}> = [
  {
    type: "hero",
    name: "첫 화면 안내",
    category: "콘텐츠",
    description: "제목, 소개와 주요 행동",
  },
  {
    type: "text",
    name: "텍스트",
    category: "콘텐츠",
    description: "긴 본문과 안내",
  },
  {
    type: "image",
    name: "이미지",
    category: "콘텐츠",
    description: "이미지와 대체 텍스트",
  },
  {
    type: "cards",
    name: "카드 목록",
    category: "콘텐츠",
    description: "서비스와 사례 소개",
  },
  {
    type: "faq",
    name: "자주 묻는 질문",
    category: "콘텐츠",
    description: "질문과 답변 아코디언",
  },
  {
    type: "pricing",
    name: "가격 안내",
    category: "콘텐츠",
    description: "가격과 제공 내용",
  },
  {
    type: "navigation",
    name: "상단 메뉴",
    category: "탐색",
    description: "페이지 또는 블록 자동 메뉴",
  },
  {
    type: "sidebar",
    name: "사이드 메뉴",
    category: "탐색",
    description: "접을 수 있는 탐색 메뉴",
  },
  {
    type: "footer",
    name: "푸터",
    category: "탐색",
    description: "공통 연락처와 안내",
  },
  {
    type: "form",
    name: "입력 폼",
    category: "데이터",
    description: "필드 검증과 실제 로컬 저장",
  },
  {
    type: "table",
    name: "데이터 표",
    category: "데이터",
    description: "검색, 정렬, 페이지, CSV와 행 편집",
  },
  {
    type: "chart",
    name: "차트",
    category: "데이터",
    description: "막대, 선과 통계 요약",
  },
  {
    type: "tabs",
    name: "탭",
    category: "상호작용",
    description: "독립 콘텐츠를 가진 탭",
  },
  {
    type: "modal",
    name: "확인 모달",
    category: "상호작용",
    description: "포커스 관리와 실제 확인 동작",
  },
  {
    type: "container",
    name: "컨테이너",
    category: "레이아웃",
    description: "블록을 묶는 반응형 그리드",
  },
  {
    type: "divider",
    name: "구분선",
    category: "레이아웃",
    description: "콘텐츠 사이 구분",
  },
  {
    type: "automade:timeline",
    name: "일정과 진행 과정",
    category: "콘텐츠",
    description: "등록된 확장 블록으로 단계별 진행 과정을 표시합니다.",
  },
  {
    type: "extension",
    name: "패키지 블록",
    category: "확장",
    description: "검증된 선언형 패키지의 블록을 사용합니다.",
  },
];
export interface BlockDefinition {
  type: BlockType;
  name: string;
  category: string;
  description: string;
  version: number;
  rendererKey: BlockType;
  propertyProfile:
    | "prose"
    | "items"
    | "form"
    | "table"
    | "chart"
    | "navigation"
    | "image"
    | "layout";
  environments: readonly ("static" | "node")[];
  packageId: string;
  packageVersion: string;
  initialize: (block: Block, project: Project) => void;
  validate: (block: Block, project: Project) => string[];
  references: (block: Block) => BlockReference[];
  publicProjection: (block: Block, project: Project, member: boolean) => Block;
  editorFields: readonly BlockEditorField[];
  accessibility: {
    semantic:
      "section" | "nav" | "footer" | "form" | "figure" | "table" | "separator";
    requiresName: boolean;
  };
}
export const BLOCK_REGISTRY: ReadonlyArray<BlockDefinition> = metadata.map(
  (entry) => ({
    ...entry,
    version: 1,
    rendererKey: entry.type,
    propertyProfile: ([
      "cards",
      "pricing",
      "faq",
      "tabs",
      "automade:timeline",
    ].includes(entry.type)
      ? "items"
      : ["form", "table", "chart", "image"].includes(entry.type)
        ? entry.type
        : ["navigation", "sidebar"].includes(entry.type)
          ? "navigation"
          : entry.type === "container"
            ? "layout"
            : "prose") as BlockDefinition["propertyProfile"],
    environments: ["form", "table"].includes(entry.type)
      ? ["node"]
      : ["static", "node"],
    packageId:
      entry.type === "automade:timeline"
        ? "automade.timeline"
        : "automade.core",
    packageVersion: "1.0.0",
    initialize: initializeDefaults,
    validate: validateRegisteredProperties,
    references: blockReferences,
    publicProjection: projectBlockPublic,
    editorFields: [
      { path: "props.title", label: "제목", control: "text" },
      { path: "props.body", label: "본문", control: "text" },
      ...(["cards", "faq", "pricing", "tabs", "automade:timeline"].includes(
        entry.type,
      )
        ? [{ path: "props.items", label: "항목", control: "items" as const }]
        : []),
      ...(entry.type === "image"
        ? [
            {
              path: "props.assetId",
              label: "이미지",
              control: "image" as const,
            },
          ]
        : []),
      ...(entry.type === "form"
        ? [
            {
              path: "props.fields",
              label: "입력 항목",
              control: "fields" as const,
            },
          ]
        : []),
      ...(entry.type === "table"
        ? [
            {
              path: "props.columns",
              label: "표 열",
              control: "columns" as const,
            },
          ]
        : []),
      ...(entry.type === "chart"
        ? [{ path: "props.series", label: "자료", control: "series" as const }]
        : []),
    ],
    accessibility: {
      semantic:
        entry.type === "navigation" || entry.type === "sidebar"
          ? "nav"
          : entry.type === "footer"
            ? "footer"
            : entry.type === "form"
              ? "form"
              : entry.type === "table"
                ? "table"
                : entry.type === "chart" || entry.type === "image"
                  ? "figure"
                  : entry.type === "divider"
                    ? "separator"
                    : "section",
      requiresName: !["divider", "image"].includes(entry.type),
    },
  }),
);
export function getBlockDefinition(type: string): BlockDefinition | undefined {
  return BLOCK_REGISTRY.find((entry) => entry.type === type);
}
function validateRegisteredProperties(
  block: Block,
  project: Project,
): string[] {
  const errors: string[] = [];
  if (block.type === "extension" && !projectBlockDefinition(project, block))
    errors.push("설치된 선언형 블록 정의가 없습니다.");
  for (const group of [
    block.props.items,
    block.props.columns,
    block.props.fields,
  ])
    if (new Set(group.map((item) => item.id)).size !== group.length)
      errors.push("블록 내부 항목 ID가 중복됩니다.");
  if (block.definitionVersion !== undefined && block.definitionVersion !== 1)
    errors.push("지원하지 않는 블록 정의 버전입니다.");
  return errors;
}
export function blockReferences(block: Block): BlockReference[] {
  const refs: BlockReference[] = [],
    add = (
      type: BlockReference["type"],
      id: string | undefined,
      path: string,
    ) => {
      if (id) refs.push({ type, id, path });
    },
    action = (value: Block["props"]["action"] | undefined, path: string) => {
      if (value?.kind === "navigate") add("page", value.target, path);
      if (value?.kind === "scroll" || value?.kind === "modal")
        add("block", value.target, path);
    };
  add("block", block.parentId ?? undefined, "parentId");
  if (block.pageId !== "*") add("page", block.pageId, "pageId");
  add("asset", block.props.assetId, "props.assetId");
  action(block.props.action, "props.action");
  action(block.props.secondary, "props.secondary");
  action(
    block.props.formSettings?.successAction,
    "props.formSettings.successAction",
  );
  for (const item of block.props.items) {
    add("asset", item.imageId, `props.items.${item.id}.imageId`);
    action(item.action, `props.items.${item.id}.action`);
  }
  add(
    "collection",
    block.props.collectionBinding?.collectionId,
    "props.collectionBinding.collectionId",
  );
  add(
    "block",
    block.props.chartBinding?.tableBlockId,
    "props.chartBinding.tableBlockId",
  );
  add(
    "connection",
    block.props.dataBinding?.connectionId,
    "props.dataBinding.connectionId",
  );
  add(
    "component",
    block.componentLink?.componentId,
    "componentLink.componentId",
  );
  add(
    "package",
    block.props.extensionDefinitionId?.split("/")[0],
    "props.extensionDefinitionId",
  );
  return refs;
}
function projectBlockPublic(
  block: Block,
  project: Project,
  member: boolean,
): Block {
  const result = structuredClone(block);
  delete result.componentLink;
  for (const key of ["action", "secondary"] as const) {
    const value = result.props[key];
    if (
      (value.kind === "navigate" &&
        !project.pages.some(
          (page) => page.id === value.target && page.published,
        )) ||
      ((value.kind === "modal" || value.kind === "scroll") &&
        !project.blocks.some(
          (target) => target.id === value.target && !target.hidden,
        ))
    )
      result.props[key] = { kind: "none" };
  }
  if (
    result.props.collectionBinding &&
    project.collections?.some(
      (collection) =>
        collection.id === result.props.collectionBinding?.collectionId &&
        collection.access === "members",
    ) &&
    !member
  )
    delete result.props.collectionBinding;
  return result;
}
export function projectBlockDefinition(
  project: Project,
  block: Block,
): BlockDefinition | undefined {
  const definition = getBlockDefinition(block.type);
  if (block.type !== "extension") return definition;
  const reference = block.props.extensionDefinitionId;
  for (const pack of project.blockPackages ?? []) {
    const item = pack.definitions.find(
      (candidate) => `${pack.id}/${candidate.id}` === reference,
    );
    if (item) {
      const template = getBlockDefinition(item.template);
      return template
        ? {
            ...template,
            type: "extension",
            name: item.name,
            description: item.description,
            packageId: pack.id,
            packageVersion: pack.version,
          }
        : undefined;
    }
  }
}
export function initializeRegisteredBlock(
  block: Block,
  project: Project,
): void {
  const definition = getBlockDefinition(block.type);
  if (!definition) throw new Error("등록되지 않은 블록입니다.");
  definition.initialize(block, project);
  if (block.type === "automade:timeline") {
    block.definitionVersion = definition.version;
    block.props.primaryAction = "";
    block.props.items = [
      {
        id: crypto.randomUUID(),
        title: "첫 번째 단계",
        body: "진행 내용을 입력하세요.",
        action: { kind: "none" },
      },
      {
        id: crypto.randomUUID(),
        title: "다음 단계",
        body: "다음 진행 내용을 입력하세요.",
        action: { kind: "none" },
      },
    ];
  }
}

function initializeDefaults(block: Block, project: Project): void {
  const type = block.type;
  const uid = (): string => crypto.randomUUID();
  if (type === "hero") {
    block.props.title = "당신의 이야기를 전하는 웹사이트";
    block.props.body =
      "실제 서비스 소개와 방문자에게 필요한 정보를 입력해 주세요.";
    block.layout.width = 1120;
    block.design.padding = 56;
  }
  if (type === "navigation" || type === "sidebar") {
    block.props.title = project.name;
    block.props.primaryAction = "";
    block.layout.height = 80;
  }
  if (type === "footer") {
    block.props.body = "연락처와 운영 정보를 입력해 주세요.";
    block.props.primaryAction = "";
  }
  if (type === "form") {
    block.props.title = "문의하기";
    block.props.primaryAction = "문의 보내기";
    block.props.secondaryAction = "초기화";
    block.props.dataSource = "local";
    block.props.action = { kind: "submit" };
    block.props.fields = [
      {
        id: "name",
        label: "이름",
        type: "text",
        required: true,
        placeholder: "이름",
        min: 1,
        max: 100,
        options: [],
      },
      {
        id: "email",
        label: "이메일",
        type: "email",
        required: true,
        placeholder: "이메일",
        min: 3,
        max: 254,
        options: [],
      },
      {
        id: "message",
        label: "문의 내용",
        type: "textarea",
        required: true,
        placeholder: "문의 내용을 입력하세요",
        min: 5,
        max: 2000,
        options: [],
      },
    ];
  }
  if (type === "table") {
    block.props.title = "데이터 목록";
    block.props.primaryAction = "행 추가";
    block.props.secondaryAction = "CSV 다운로드";
    block.props.columns = [
      { id: "name", label: "이름", type: "text" },
      { id: "status", label: "상태", type: "text" },
    ];
    block.props.dataSource = "local";
  }
  if (type === "tabs") {
    block.props.items = [
      {
        id: uid(),
        title: "안내",
        body: "첫 번째 탭 내용을 입력하세요.",
        action: { kind: "none" },
      },
      {
        id: uid(),
        title: "상세",
        body: "두 번째 탭 내용을 입력하세요.",
        action: { kind: "none" },
      },
    ];
    block.props.primaryAction = "";
  }
  if (type === "modal") {
    block.props.body = "이 작업을 진행하시겠습니까?";
    block.props.primaryAction = "확인";
    block.props.secondaryAction = "취소";
  }
  if (type === "chart") {
    block.props.title = "데이터 현황";
    block.props.primaryAction = "";
  }
  if (type === "container") {
    block.layout.columns = 2;
    block.props.primaryAction = "";
  }
  if (["cards", "pricing", "faq"].includes(type)) {
    block.props.items = [
      {
        id: uid(),
        title: "첫 번째 항목",
        body: "실제 내용을 입력하세요.",
        action: { kind: "none" },
      },
      {
        id: uid(),
        title: "두 번째 항목",
        body: "실제 내용을 입력하세요.",
        action: { kind: "none" },
      },
    ];
    block.layout.columns = 2;
    block.props.primaryAction = "";
  }
  if (["text", "image", "divider"].includes(type))
    block.props.primaryAction = "";
}
