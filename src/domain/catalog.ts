import type { BlockType, Block, Project } from "./types";
export const CATALOG: ReadonlyArray<{
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
];
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
    },
  };
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
  return block;
}
