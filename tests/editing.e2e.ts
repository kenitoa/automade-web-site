import { test, expect } from "@playwright/test";
import { createBlock, createProject } from "../src/domain/catalog";
import type { Project } from "../src/domain/types";
async function load(page: import("@playwright/test").Page, p: Project) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page
    .locator('input[type=file][accept=".json,application/json"]')
    .setInputFiles({
      name: "project.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(p)),
    });
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
}
test("scaled canvas drag, resize and undo preserve document coordinates", async ({
  page,
}) => {
  const p = createProject("좌표 검증");
  const block = createBlock("text", p, p.pages[0]!.id);
  block.layout = {
    ...block.layout,
    mode: "absolute",
    x: 64,
    y: 64,
    width: 300,
    height: 150,
  };
  p.blocks.push(block);
  await load(page, p);
  await page.getByLabel("확대", { exact: true }).selectOption("0.5");
  const edit = page.locator('[data-edit-id="' + block.id + '"]');
  const box = await edit.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + 30, box!.y + 30);
  await page.mouse.down();
  await page.mouse.move(box!.x + 78, box!.y + 62, { steps: 5 });
  await page.mouse.up();
  await expect(edit).toHaveCSS("left", "160px");
  await expect(edit).toHaveCSS("top", "128px");
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(edit).toHaveCSS("left", "64px");
  const handle = edit.getByRole("button", { name: "텍스트 크기 조절" });
  const h = await handle.boundingBox();
  await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
  await page.mouse.down();
  await page.mouse.move(h!.x + h!.width / 2 + 40, h!.y + h!.height / 2 + 24, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(edit).toHaveCSS("width", "384px");
});
test("published routes work, private content is absent, and completed output restarts", async ({
  page,
}) => {
  const p = createProject("페이지 검증");
  p.settings.description = "실제 경로";
  const second = {
    id: "work",
    title: "작업",
    path: "/work",
    description: "작업 소개",
    home: false,
    published: true,
  };
  const hidden = {
    id: "private",
    title: "비공개 제목",
    path: "/private",
    description: "",
    home: false,
    published: false,
  };
  p.pages.push(second, hidden);
  const nav = createBlock("navigation", p, "*"),
    home = createBlock("hero", p, p.pages[0]!.id),
    work = createBlock("text", p, second.id),
    secret = createBlock("text", p, hidden.id);
  work.props.title = "작업 페이지 내용";
  secret.props.body = "PRIVATE_BROWSER_CONTENT";
  p.blocks.push(nav, home, work, secret);
  await load(page, p);
  await page.getByRole("button", { name: "사이트 만들고 열기 ↗" }).click();
  await expect(
    page.getByRole("link", { name: "웹사이트 바로 열기 ↗" }),
  ).toBeVisible();
  const url = await page
    .getByRole("link", { name: "웹사이트 바로 열기 ↗" })
    .getAttribute("href");
  const site = await page.context().newPage();
  await site.goto(url! + "/work");
  await expect(
    site.getByRole("heading", { name: "작업 페이지 내용" }),
  ).toBeVisible();
  const source = await (await page.request.get(url! + "/work")).text();
  expect(source).not.toContain("PRIVATE_BROWSER_CONTENT");
  expect(source).not.toContain("비공개 제목");
  await site.getByRole("button", { name: "홈", exact: true }).click();
  await expect(site.locator("h1")).toBeVisible();
  await page.getByRole("button", { name: "운영", exact: true }).click();
  await page
    .getByRole("button", { name: "실행 종료", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "다시 실행", exact: true })
    .last()
    .click();
  await expect(page.locator(".run-card a")).toHaveCount(1);
  const restarted = await page.locator(".run-card a").getAttribute("href");
  expect((await page.request.get(restarted! + "/health")).ok()).toBe(true);
});
