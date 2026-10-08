import { test, expect } from "@playwright/test";
import { createProject } from "../src/domain/catalog";
import { randomUUID } from "node:crypto";

test("a delayed real CMS transition response preserves edits made while its request was pending", async ({
  page,
}) => {
  const project = createProject(`발행 응답 비교 ${randomUUID().slice(0, 8)}`);
  project.collections = [
    {
      id: "articles",
      name: "대기 중 편집",
      path: "/articles",
      records: [
        {
          id: "article",
          title: "검토 요청할 제목",
          slug: "article",
          body: "검토할 내용",
          category: "",
          imageId: "",
          status: "draft",
          publishedAt: "",
          fields: {},
        },
      ],
    },
  ];
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page
    .locator('input[type=file][accept=".json,application/json"][hidden]')
    .setInputFiles({
      name: "pending-cms.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
  await expect(
    page.getByLabel("현재 사이트").locator("option:checked"),
  ).toContainText(project.name);
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  const content = page.locator(".content-management");
  await content.locator("summary").filter({ hasText: "콘텐츠 컬렉션" }).click();
  await content
    .getByRole("button", { name: "검토 요청할 제목", exact: false })
    .click();
  await content
    .locator("summary")
    .filter({ hasText: "자료 검토·발행 상태" })
    .click();
  let serverResponded = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/expansion/cms/transitions",
    async (route) => {
      const response = await route.fetch();
      if (response.status() !== 200) throw new Error(await response.text());
      serverResponded = true;
      await gate;
      await route.fulfill({ response });
    },
  );
  try {
    await content
      .getByRole("button", { name: "검토 요청", exact: true })
      .click();
    await expect.poll(() => serverResponded).toBe(true);
    const title = content.getByLabel("제목", { exact: true });
    await title.fill("응답을 기다리며 추가한 변경");
    await title.blur();
    await expect(title).toHaveValue("응답을 기다리며 추가한 변경");
    release();
    const dialog = page.getByRole("dialog", {
      name: "온라인·오프라인 변경 비교",
    });
    await expect(dialog).toBeVisible();
    await expect(title).toHaveValue("응답을 기다리며 추가한 변경");
    for (const choice of await dialog.getByLabel("이 필드 반영").all())
      await choice.selectOption("local");
    await dialog
      .getByRole("button", { name: "검토한 병합 적용·동기화" })
      .click();
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/projects/${project.id}`);
        const envelope = (await response.json()) as {
          data: { collections: { records: { title: string }[] }[] };
        };
        return envelope.data.collections[0]!.records[0]!.title;
      })
      .toBe("응답을 기다리며 추가한 변경");
  } finally {
    release();
  }
});
