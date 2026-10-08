import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createBlock, createProject } from "../src/domain/catalog";
import type { Project } from "../src/domain/types";
async function load(page: Page, p: Project) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page
    .locator('input[type=file][accept=".json,application/json"]')
    .setInputFiles({
      name: "upgrade.interface.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(p)),
    });
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
}
async function original(page: Page): Promise<Project> {
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  const wait = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "원본 내보내기", exact: true })
    .click();
  const download = await wait;
  return JSON.parse(
    await readFile((await download.path())!, "utf8"),
  ) as Project;
}
test("guided creation previews the selected structure before preserving the real brief", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "새 프로젝트", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("사이트 이름", { exact: true }).fill("검토한 업체");
  await dialog.getByLabel("주요 방문자").fill("지역 고객");
  await dialog.getByLabel("방문자가 하길 원하는 행동").fill("상담 문의");
  await dialog
    .getByRole("button", { name: "업체 소개 소개·사례·문의 페이지" })
    .click();
  await dialog.getByRole("button", { name: "구조 미리보기" }).click();
  await expect(dialog).toContainText("3페이지");
  await expect(page.getByLabel("프로젝트 이름")).not.toHaveValue("검토한 업체");
  await dialog.getByRole("button", { name: "검토한 초안 적용" }).click();
  await expect(dialog).not.toBeVisible();
  const saved = await original(page);
  expect(saved.settings.brief?.audience).toBe("지역 고객");
  expect(saved.pages).toHaveLength(3);
});
test("batch editing, device overrides, inline text and reusable sections persist with undo", async ({
  page,
}) => {
  const p = createProject("편집 고도화 검증"),
    one = createBlock("text", p, p.pages[0]!.id),
    two = createBlock("text", p, p.pages[0]!.id);
  one.props.title = "블록 하나";
  one.props.body = "원래 본문";
  two.props.title = "블록 둘";
  p.blocks.push(one, two);
  await load(page, p);
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  await page.locator(".layer-name").filter({ hasText: "블록 하나" }).click();
  await page
    .locator(".layer-name")
    .filter({ hasText: "블록 둘" })
    .click({ modifiers: ["Shift"] });
  await expect(page.locator(".properties")).toContainText(
    "2개 선택 · 공통 속성",
  );
  await page.getByLabel("일괄 padding").fill("40");
  await page.getByLabel("일괄 padding").blur();
  await expect(
    page.locator(`[data-edit-id="${one.id}"] > .site-block`),
  ).toHaveCSS("padding", "40px");
  await expect(
    page.locator(`[data-edit-id="${two.id}"] > .site-block`),
  ).toHaveCSS("padding", "40px");
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(
    page.locator(`[data-edit-id="${one.id}"] > .site-block`),
  ).toHaveCSS("padding", "28px");
  await page.locator(".layer-name").filter({ hasText: "블록 하나" }).click();
  await page
    .locator(".properties summary")
    .filter({ hasText: "기기별 예외" })
    .click();
  const mobile = page.getByRole("group", { name: "모바일", exact: true });
  await mobile.getByLabel("본문 크기", { exact: true }).fill("22");
  await page.getByRole("button", { name: "모바일", exact: true }).click();
  await expect(
    page.locator(`[data-edit-id="${one.id}"] > .site-block`),
  ).toHaveCSS("font-size", "22px");
  await page.getByRole("button", { name: "PC", exact: true }).click();
  await page.locator(`[data-edit-id="${one.id}"] h2`).dblclick();
  await page.getByLabel("제목 바로 편집").fill("직접 고친 제목");
  await page.getByRole("button", { name: "텍스트 적용" }).click();
  await expect(page.locator(`[data-edit-id="${one.id}"] h2`)).toHaveText(
    "직접 고친 제목",
  );
  await page.getByRole("button", { name: "블록", exact: true }).click();
  await page.locator("summary").filter({ hasText: "내 재사용 섹션" }).click();
  await page.getByLabel("선택 블록 저장 이름").fill("소개 섹션");
  await page.getByRole("button", { name: "선택을 섹션으로 저장" }).click();
  await page.getByRole("button", { name: "현재 페이지에 추가" }).click();
  const saved = await original(page);
  expect(saved.blocks).toHaveLength(3);
  expect(saved.extensions?.reusableSections).toHaveLength(1);
  await page.reload();
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
  await expect(
    page.locator(".site-root h2").filter({ hasText: "직접 고친 제목" }),
  ).toHaveCount(2);
});
test("CMS draft privacy, page aliases and image replacement preserve connected IDs", async ({
  page,
}) => {
  const p = createProject("콘텐츠와 이미지 검증");
  p.blocks.push(createBlock("cards", p, p.pages[0]!.id));
  await load(page, p);
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  await page.getByLabel("이전 주소 (한 줄에 하나)").fill("/old-home");
  await page.locator("summary").filter({ hasText: "콘텐츠 컬렉션" }).click();
  await page.getByRole("button", { name: "컬렉션 추가" }).click();
  await page.getByLabel("컬렉션 이름").fill("소식");
  await page.getByRole("button", { name: "콘텐츠 추가" }).click();
  const record = page
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "콘텐츠 편집" }) });
  await record.getByLabel("제목", { exact: true }).fill("검토할 초안");
  await record
    .getByLabel("본문", { exact: true })
    .fill("아직 공개하지 않은 소식");
  await record.getByText("콘텐츠 번역", { exact: true }).click();
  await record.getByLabel("영어 제목", { exact: true }).fill("Reviewed draft");
  await record
    .getByLabel("영어 본문", { exact: true })
    .fill("News not published yet");
  const first = await original(page);
  expect(first.collections?.[0]?.records[0]?.status).toBe("draft");
  expect(first.collections?.[0]?.records[0]?.translations?.en).toEqual({
    title: "Reviewed draft",
    body: "News not published yet",
  });
  expect(first.pages[0]?.aliases).toEqual(["/old-home"]);
  await page.getByRole("button", { name: "이미지", exact: true }).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2563eb";
    context.fillRect(0, 0, 8, 8);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page
    .locator(
      'input[type=file][accept="image/png,image/jpeg,image/gif,image/webp"]',
    )
    .setInputFiles({
      name: "first.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
  await expect(page.locator(".asset-card")).toHaveCount(1);
  await page.getByLabel("대체 텍스트", { exact: true }).fill("확인한 이미지");
  const before = await original(page);
  await page.getByRole("button", { name: "이미지", exact: true }).click();
  const replace = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "이미지 교체" }).click();
  await (
    await replace
  ).setFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(page.locator(".asset-card strong")).toHaveText(
    "replacement.png",
  );
  const after = await original(page);
  expect(after.assets[0]?.id).toBe(before.assets[0]?.id);
  expect(after.assets[0]?.alt).toBe("확인한 이미지");
  expect(after.assets[0]?.width).toBe(8);
});
test("catalog empty state, field-focused quality and explicit narrow inspector work", async ({
  page,
}) => {
  const p = createProject("접근성 고도화");
  const hero = createBlock("hero", p, p.pages[0]!.id);
  hero.props.title = "";
  p.blocks.push(hero);
  await load(page, p);
  await page.getByRole("button", { name: "블록", exact: true }).click();
  await page.getByLabel("블록 검색").fill("검색결과없는단어");
  await expect(page.getByText("조건에 맞는 블록이 없습니다.")).toBeVisible();
  await page.getByRole("button", { name: "검색 초기화" }).click();
  await page.getByRole("button", { name: "품질 검사", exact: true }).click();
  await page
    .getByRole("button")
    .filter({ hasText: "첫 화면 제목을 입력하세요." })
    .click();
  await expect(
    page.locator(".properties").getByLabel("제목", { exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 900, height: 800 });
  await page.getByRole("button", { name: "속성 닫기" }).click();
  await expect(page.locator(".properties")).not.toBeVisible();
  await page.getByRole("button", { name: "속성 열기" }).click();
  await expect(page.locator(".properties")).toBeVisible();
  const narrowBounds = await page.locator(".properties").boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(900);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(900);
  await page.screenshot({
    path: "test-results/editor-upgrade-narrow.png",
    fullPage: true,
  });
});
