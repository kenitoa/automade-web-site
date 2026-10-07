import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createBlock, createProject } from "../src/domain/catalog";
import type { Project } from "../src/domain/types";
async function fresh(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "새 프로젝트", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "빈 프로젝트 직접 구성하기" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("사이트 이름", { exact: true })
    .fill("브라우저 검증");
  await page
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
async function importProject(
  page: import("@playwright/test").Page,
  p: Project,
) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page
    .locator('input[type=file][accept=".json,application/json"]')
    .setInputFiles({
      name: "fixture.interface.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(p)),
    });
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
}
test("organized editor supports content, undo, recovery and responsive view", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fresh(page);
  await page
    .getByRole("button", { name: "첫 화면 안내", exact: false })
    .click();
  await expect(page.locator(".site-root h1")).toBeVisible();
  await page
    .locator(".properties")
    .getByLabel("제목", { exact: true })
    .fill("검증한 홈페이지");
  await expect(page.locator(".site-root h1")).toHaveText("검증한 홈페이지");
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(page.locator(".site-root h1")).not.toHaveText("검증한 홈페이지");
  await page.getByRole("button", { name: "다시 실행", exact: true }).click();
  await expect(page.locator(".site-root h1")).toHaveText("검증한 홈페이지");
  await page.getByRole("button", { name: "모바일", exact: true }).click();
  await expect(page.locator(".canvas-surface")).toHaveCSS("width", "390px");
  await expect(page.getByText("자동 저장 완료", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".site-root h1")).toHaveText("검증한 홈페이지");
  await page.screenshot({
    path: "test-results/studio-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("one click opens a real generated site with working form, table, tabs, modal and CSV", async ({
  page,
}) => {
  const p = createProject("원클릭 사이트");
  p.settings.description = "소개";
  const pageId = p.pages[0]!.id;
  const hero = createBlock("hero", p, pageId),
    form = createBlock("form", p, pageId),
    table = createBlock("table", p, pageId),
    tabs = createBlock("tabs", p, pageId),
    chart = createBlock("chart", p, pageId),
    modal = createBlock("modal", p, pageId);
  hero.props.action = { kind: "modal", target: modal.id };
  chart.props.series = [10, -4, 30];
  table.props.rows = [{ id: "first", values: ["최초 행", "대기"] }];
  p.blocks.push(hero, form, table, tabs, chart, modal);
  await importProject(page, p);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "사이트 만들고 열기 ↗" }).click();
  const site = await popupPromise;
  await expect(site.locator(".site-root")).toBeVisible();
  await expect(
    page.getByText("사이트가 준비되었습니다", { exact: false }),
  ).toBeVisible();
  const errors: string[] = [];
  site.on("pageerror", (e) => errors.push(e.message));
  await site.getByRole("button", { name: "자세히 보기", exact: true }).click();
  await expect(site.getByRole("dialog")).toBeVisible();
  await site.keyboard.press("Escape");
  await expect(site.getByRole("dialog")).not.toBeVisible();
  await site.getByLabel("이름", { exact: false }).fill("테스트 사용자");
  await site.getByLabel("이메일", { exact: false }).fill("user@example.org");
  await site
    .getByLabel("문의 내용", { exact: false })
    .fill("실제 저장 확인입니다.");
  await site.getByRole("button", { name: "문의 보내기" }).click();
  await expect(site.getByText("문의가 저장되었습니다.")).toBeVisible();
  await site.getByRole("button", { name: "행 추가", exact: true }).click();
  await site.locator(".site-row-editor").getByLabel("이름").fill("추가 행");
  await site.locator(".site-row-editor").getByLabel("상태").fill("완료");
  await site.getByRole("button", { name: "행 저장", exact: true }).click();
  await expect(
    site.getByRole("cell", { name: "추가 행", exact: true }),
  ).toBeVisible();
  await site.reload();
  await expect(
    site.getByRole("cell", { name: "추가 행", exact: true }),
  ).toBeVisible();
  const downloadPromise = site.waitForEvent("download");
  await site.getByRole("button", { name: "CSV 다운로드" }).click();
  const download = await downloadPromise;
  const file = await download.path();
  expect((await readFile(file!, "utf8")).includes("추가 행")).toBe(true);
  await site.getByRole("tab", { name: "상세" }).click();
  await expect(site.getByRole("tabpanel")).toContainText("두 번째 탭");
  await site.getByRole("button", { name: "선", exact: true }).click();
  await expect(site.locator("polyline")).toBeVisible();
  await site.setViewportSize({ width: 390, height: 844 });
  await site.screenshot({
    path: "test-results/generated-mobile.png",
    fullPage: true,
  });
  const overflow = await site.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "운영", exact: true }).click();
  await page.getByRole("button", { name: "문의 조회" }).first().click();
  await expect(
    page.getByText("실제 저장 확인입니다.", { exact: false }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("popup blocking preserves a clickable generated URL", async ({ page }) => {
  await fresh(page);
  await page.getByRole("button", { name: "텍스트", exact: true }).click();
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole("button", { name: "사이트 만들고 열기 ↗" }).click();
  await expect(
    page.getByRole("link", { name: "웹사이트 바로 열기 ↗" }),
  ).toBeVisible();
  const url = await page
    .getByRole("link", { name: "웹사이트 바로 열기 ↗" })
    .getAttribute("href");
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});
test("service rejects cross-origin writes and missing CSRF tokens", async ({
  request,
}) => {
  const session = await request.get("/api/session");
  expect(session.ok()).toBe(true);
  const project = createProject("권한 검사");
  const foreign = await request.put("/api/projects", {
    headers: {
      Origin: "https://evil.test",
      "Content-Type": "application/json",
    },
    data: project,
  });
  expect(foreign.status()).toBe(403);
  const missing = await request.put("/api/projects", {
    headers: {
      Origin: "http://127.0.0.1:5188",
      "Content-Type": "application/json",
    },
    data: project,
  });
  expect(missing.status()).toBe(403);
  const traversal = await request.get("/%2e%2e%5cpackage.json");
  expect(traversal.status()).not.toBe(200);
});
