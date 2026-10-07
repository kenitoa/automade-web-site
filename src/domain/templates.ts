import { createBlock, createProject, uid } from "./catalog";
import type { BlockType, Project } from "./types";
export const TEMPLATES = [
  { id: "company", name: "업체 소개", description: "소개·사례·문의 페이지" },
  {
    id: "portfolio",
    name: "포트폴리오",
    description: "프로필·작업·연락 페이지",
  },
  { id: "landing", name: "서비스 안내", description: "소개·가격·FAQ·문의" },
  { id: "dashboard", name: "업무 화면", description: "데이터 표·차트·요청 폼" },
  { id: "blank", name: "빈 프로젝트", description: "직접 구성하기" },
] as const;
export type TemplateId = (typeof TEMPLATES)[number]["id"];
export function fromTemplate(
  template: TemplateId,
  name: string,
  description: string,
): Project {
  const p = createProject(name);
  p.settings.description = description;
  if (template === "blank") return p;
  const home = p.pages[0]!;
  const add = (
    type: BlockType,
    pageId: string,
    title?: string,
    body?: string,
  ) => {
    const b = createBlock(type, p, pageId);
    if (title) b.props.title = title;
    if (body !== undefined) b.props.body = body;
    p.blocks.push(b);
    return b;
  };
  add("navigation", "*", name);
  add("hero", home.id, name, description);
  if (template === "dashboard") {
    add("table", home.id, "업무 데이터");
    add("chart", home.id, "수치 현황");
    add("form", home.id, "업무 요청");
  } else {
    add(
      "cards",
      home.id,
      template === "portfolio" ? "작업 소개" : "서비스 소개",
    );
    if (template === "landing") {
      add("pricing", home.id, "가격 안내");
      add("faq", home.id, "자주 묻는 질문");
    } else {
      const work = {
        id: uid(),
        title: template === "portfolio" ? "작업" : "사례",
        path: "/work",
        description: "",
        published: true,
        home: false,
      };
      p.pages.push(work);
      add("cards", work.id, work.title);
    }
    const contact = {
      id: uid(),
      title: "문의",
      path: "/contact",
      description: "상담과 문의",
      published: true,
      home: false,
    };
    p.pages.push(contact);
    add(
      "text",
      contact.id,
      "문의 안내",
      "실제 연락처와 개인정보 처리 안내를 입력해 주세요.",
    );
    add("form", contact.id);
    p.blocks.find((b) => b.type === "hero")!.props.action = {
      kind: "navigate",
      target: contact.id,
    };
  }
  add("footer", "*", name, "운영 정보와 연락처를 입력하세요.");
  return p;
}
export function suggestTemplate(prompt: string): TemplateId {
  if (/업무|데이터|표|dashboard/i.test(prompt)) return "dashboard";
  if (/포트폴리오|작업|portfolio/i.test(prompt)) return "portfolio";
  if (/가격|요금|서비스|landing/i.test(prompt)) return "landing";
  return "company";
}
