export const LANGUAGE_OPTIONS = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "custom", label: "맞춤 언어" },
];

export const STRINGS = {
  ko: {
    appKicker: "React 인터페이스 생성기",
    appTitle: "인터페이스 자동 생성기",
    blockCount: "블록",
    noSelection: "선택 없음",
    selected: "선택됨",
    paletteKicker: "블록",
    paletteTitle: "팔레트",
    canvasKicker: "조립",
    canvasTitle: "캔버스",
    drawTitle: "위젯 크기 지정 후 배치",
    drawHelp: "1x1, 2x2 같은 크기를 먼저 고른 뒤 캔버스에 올리면 윤곽이 보입니다. 누른 상태로 살짝 움직이면 기준 크기에서 늘리거나 줄일 수 있습니다.",
    sizePreset: "위젯 크기",
    emptyCanvas: "왼쪽 팔레트에서 기능 블록을 추가하거나, 위 영역에서 크기를 골라 위젯을 배치하세요.",
    moveUp: "위로",
    moveDown: "아래로",
    copy: "복제",
    delete: "삭제",
    inspectorKicker: "커스터마이징",
    inspectorTitle: "설정",
    language: "언어",
    customLabels: "맞춤 언어 JSON",
    customLabelsHelp: "예: {\"appTitle\":\"나만의 생성기\",\"saveDesktop\":\"저장\"}",
    theme: "테마",
    projectName: "프로젝트 이름",
    brandColor: "대표 색상",
    accentColor: "강조 색상",
    surfaceColor: "배경 색상",
    radius: "모서리 둥글기",
    selectedBlock: "선택한 블록",
    selectBlockHelp: "캔버스에서 블록을 선택하면 문구, 동작, 크기를 수정할 수 있습니다.",
    title: "제목",
    body: "본문",
    primaryAction: "주요 버튼",
    secondaryAction: "보조 버튼",
    tone: "분위기",
    density: "밀도",
    layout: "배치",
    shapeX: "기준 X",
    shapeY: "기준 Y",
    shapeWidth: "형태 너비",
    shapeHeight: "형태 높이",
    shapeFill: "형태 색상",
    resetProject: "프로젝트 초기화",
    previewKicker: "결과",
    previewTitle: "실시간 미리보기",
    previewEmpty: "생성된 인터페이스가 여기에 표시됩니다.",
    exportKicker: "스펙",
    exportTitle: "JSON 내보내기",
    saveKicker: "저장",
    saveTitle: "React 앱 폴더 저장",
    saveDesktop: "바탕화면에 React 앱 저장",
    saveReady: "프로젝트 이름으로 start-site.cmd와 output 폴더를 저장합니다.",
    saveSaving: "저장 중...",
    saveDone: "저장 완료",
    saveFailed: "저장 실패",
  },
  en: {
    appKicker: "React interface generator",
    appTitle: "Interface Auto Builder",
    blockCount: "blocks",
    noSelection: "No selection",
    selected: "selected",
    paletteKicker: "Blocks",
    paletteTitle: "Palette",
    canvasKicker: "Assembly",
    canvasTitle: "Canvas",
    drawTitle: "Place a preset widget",
    drawHelp: "Choose a size such as 1x1 or 2x2 first. Move over the canvas to see the outline, then drag slightly to grow or shrink from that anchor.",
    sizePreset: "Widget size",
    emptyCanvas: "Add functional blocks from the palette or choose a size above to place a widget.",
    moveUp: "Up",
    moveDown: "Down",
    copy: "Copy",
    delete: "Delete",
    inspectorKicker: "Customize",
    inspectorTitle: "Inspector",
    language: "Language",
    customLabels: "Custom language JSON",
    customLabelsHelp: "Example: {\"appTitle\":\"My Builder\",\"saveDesktop\":\"Save\"}",
    theme: "Theme",
    projectName: "Project name",
    brandColor: "Brand color",
    accentColor: "Accent color",
    surfaceColor: "Surface color",
    radius: "Radius",
    selectedBlock: "Selected block",
    selectBlockHelp: "Select a block on the canvas to edit its content, behavior, and size.",
    title: "Title",
    body: "Body",
    primaryAction: "Primary action",
    secondaryAction: "Secondary action",
    tone: "Tone",
    density: "Density",
    layout: "Layout",
    shapeX: "Anchor X",
    shapeY: "Anchor Y",
    shapeWidth: "Shape width",
    shapeHeight: "Shape height",
    shapeFill: "Shape fill",
    resetProject: "Reset project",
    previewKicker: "Output",
    previewTitle: "Live Preview",
    previewEmpty: "Your generated interface will appear here.",
    exportKicker: "Spec",
    exportTitle: "JSON Export",
    saveKicker: "Save",
    saveTitle: "React App Folder Save",
    saveDesktop: "Save React App to Desktop",
    saveReady: "Save start-site.cmd and an output folder using the project name.",
    saveSaving: "Saving...",
    saveDone: "Saved",
    saveFailed: "Save failed",
  },
};

export function parseCustomLabels(rawValue) {
  if (!rawValue || !rawValue.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createTranslator(settings) {
  const language = settings?.language ?? "ko";
  const customLabels = language === "custom" ? parseCustomLabels(settings.customLanguageText) : {};
  const base = STRINGS[language] ?? STRINGS.ko;

  return function translate(key) {
    return customLabels[key] ?? base[key] ?? STRINGS.ko[key] ?? key;
  };
}
