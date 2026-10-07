import type { Project } from "../domain/types";
const english: Record<string, string> = {
  "콘텐츠로 이동": "Skip to content",
  "페이지를 찾을 수 없습니다.": "Page not found.",
  "홈으로 이동": "Go home",
  검색: "Search",
  "행 추가": "Add row",
  "CSV 다운로드": "Download CSV",
  "행 저장": "Save row",
  취소: "Cancel",
  삭제: "Delete",
  이전: "Previous",
  다음: "Next",
  "데이터를 불러오는 중…": "Loading data…",
  "표시할 데이터가 없습니다.": "No data to display.",
  선택하세요: "Select an option",
  "저장 중…": "Saving…",
  "입력값을 확인하세요.": "Please check the input.",
  "문의가 저장되었습니다.": "Your message was saved.",
  "미리보기 제출을 확인했습니다. 데이터는 저장되지 않습니다.":
    "Preview submission checked. No data was saved.",
  "저장 대상이 연결되지 않았습니다.": "No storage destination is configured.",
  "변경 사항을 저장했습니다.": "Changes saved.",
  "미리보기 데이터만 변경했습니다.": "Only preview data was changed.",
  "차트 데이터가 없습니다.": "No chart data.",
  막대: "Bar",
  선: "Line",
  요약: "Summary",
  합계: "Total",
  확인: "Confirm",
  제출: "Submit",
  "이 행을 삭제하시겠습니까?": "Delete this row?",
};
export function locale(project: Project, text: string): string {
  try {
    const custom: unknown = JSON.parse(
      project.settings.customLanguageText || "{}",
    );
    if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      const value = (custom as Record<string, unknown>)[text];
      if (typeof value === "string" && value.length < 1000) return value;
    }
  } catch {
    /* Free-form legacy language notes are preserved, defaults remain usable. */
  }
  return project.settings.language === "en" ? (english[text] ?? text) : text;
}
