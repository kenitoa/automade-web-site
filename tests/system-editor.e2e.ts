import { test, expect, type Page } from "@playwright/test";
import { createBlock, createProject } from "../src/domain/catalog";
import type { Project } from "../src/domain/types";
import type { BlobAsset } from "../src/domain/expansion";
import type { EditorCommand } from "../src/infrastructure/projectJournal";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem, platform, release } from "node:os";
import { parseProject } from "../src/domain/validation";

async function source(page: Page, id: string): Promise<Project> {
  return page.evaluate(async (projectId) => {
    const response = await fetch(`/api/projects/${projectId}`),
      result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "Read failed");
    return result.data;
  }, id);
}
async function journal(page: Page, id: string): Promise<EditorCommand[]> {
  return page.evaluate(
    (projectId) =>
      new Promise<EditorCommand[]>((resolve, reject) => {
        const request = indexedDB.open("automade-studio", 3);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            read = db
              .transaction("commands", "readonly")
              .objectStore("commands")
              .getAll();
          read.onsuccess = () => {
            resolve(
              (read.result as EditorCommand[]).filter(
                (command) => command.projectId === projectId,
              ),
            );
            db.close();
          };
          read.onerror = () => reject(read.error);
        };
      }),
    id,
  );
}
async function load(page: Page, p: Project) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "사이트 만들고 열기 ↗" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page
    .locator('input[type=file][accept=".json,application/json"][hidden]')
    .setInputFiles({
      name: "system.interface.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(p)),
    });
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
  await expect
    .poll(async () => {
      try {
        return (await source(page, p.id)).id;
      } catch {
        return "";
      }
    })
    .toBe(p.id);
  await expect(
    page.getByLabel("현재 사이트").locator("option:checked"),
  ).toContainText(p.name);
  await expect(page.getByLabel("현재 환경")).not.toHaveValue("");
}
async function system(page: Page) {
  await page.getByRole("button", { name: "운영", exact: true }).click();
  const panel = page.locator(".system-panel");
  await panel.locator("summary").first().click();
  return panel;
}
async function mutation<T>(
  page: Page,
  path: string,
  body: unknown,
  method = "POST",
): Promise<T> {
  return page.evaluate(
    async (input) => {
      const session = (await (await fetch("/api/session")).json()).data;
      const response = await fetch(input.path, {
          method: input.method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
          },
          body: JSON.stringify(input.body),
        }),
        result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || "Mutation failed");
      return result.data;
    },
    { path, body, method },
  );
}
async function applyReview(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "검토한 작업 실제 적용" }).click();
  await expect(dialog).toHaveCount(0);
}

test("server-applied command with a lost response resumes the same ACK after reload", async ({
  page,
}) => {
  const p = createProject(`응답 유실 ${randomUUID().slice(0, 8)}`),
    block = createBlock("text", p, p.pages[0]!.id);
  block.props.title = "응답 유실 기준";
  p.blocks.push(block);
  await load(page, p);
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  await page
    .locator(".layer-name")
    .filter({ hasText: block.props.title })
    .click();
  let commandId = "",
    appliedRevision = 0,
    dropped = false;
  await page.route(
    (url) => url.pathname === `/api/projects/${p.id}/commands`,
    async (route) => {
      if (route.request().method() === "POST" && !dropped) {
        dropped = true;
        const body = route.request().postDataJSON() as { commandId: string };
        commandId = body.commandId;
        const response = await route.fetch(),
          envelope = (await response.json()) as { data: { project: Project } };
        expect(response.ok()).toBeTruthy();
        appliedRevision = envelope.data.project.revision;
        await route.abort("failed");
        return;
      }
      await route.continue();
    },
  );
  const title = page.locator(".properties").getByLabel("제목", { exact: true });
  await title.fill("서버 적용 후 응답만 유실");
  await title.blur();
  await expect.poll(async () => dropped && appliedRevision > 0).toBe(true);
  await expect
    .poll(
      async () =>
        (await journal(page, p.id)).find(
          (command) => command.commandId === commandId,
        )?.status,
    )
    .toBe("pending");
  await page.reload();
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
  await expect(page.locator(".site-root h2")).toHaveText(
    "서버 적용 후 응답만 유실",
  );
  await expect
    .poll(
      async () =>
        (await journal(page, p.id)).find(
          (command) => command.commandId === commandId,
        )?.status,
    )
    .toBe("acknowledged");
  await expect(
    page.getByRole("dialog", { name: "온라인·오프라인 변경 비교" }),
  ).toHaveCount(0);
  expect((await source(page, p.id)).revision).toBe(appliedRevision);
  expect(
    (await journal(page, p.id)).find(
      (command) => command.commandId === commandId,
    )?.changes,
  ).toEqual([]);
});

test("offline edits stay in IndexedDB and reconcile only when connectivity returns", async ({
  page,
  context,
}) => {
  const p = createProject(`오프라인 명령 ${randomUUID().slice(0, 8)}`),
    block = createBlock("text", p, p.pages[0]!.id);
  block.props.title = "오프라인 기준";
  p.blocks.push(block);
  await load(page, p);
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  await page
    .locator(".layer-name")
    .filter({ hasText: block.props.title })
    .click();
  await context.setOffline(true);
  const title = page.locator(".properties").getByLabel("제목", { exact: true });
  await title.fill("연결 전에 보관한 변경");
  await title.blur();
  await expect
    .poll(async () =>
      (await journal(page, p.id)).some(
        (command) =>
          command.status === "pending" &&
          command.changes.some(
            (change) => change.after === "연결 전에 보관한 변경",
          ),
      ),
    )
    .toBe(true);
  await expect(page.locator(".site-root h2")).toHaveText(
    "연결 전에 보관한 변경",
  );
  await context.setOffline(false);
  await expect
    .poll(async () => (await source(page, p.id)).blocks[0]!.props.title)
    .toBe("연결 전에 보관한 변경");
  await expect
    .poll(
      async () =>
        (await journal(page, p.id)).filter(
          (command) => command.status === "pending",
        ).length,
    )
    .toBe(0);
});

test("generation submits the exact canonical save ACK without waiting for autosave or a popup", async ({
  page,
}) => {
  const p = createProject(`생성 원본 확인 ${randomUUID().slice(0, 8)}`),
    block = createBlock("text", p, p.pages[0]!.id);
  p.blocks.push(block);
  await load(page, p);
  const acknowledgements: Project[] = [],
    submission: { project: Project | null } = { project: null };
  await page.route(
    (url) => url.pathname === `/api/projects/${p.id}/commands`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch(),
        envelope = (await response.json()) as {
          data: { ack: boolean; project: unknown };
        };
      expect(response.ok()).toBeTruthy();
      expect(envelope.data.ack).toBe(true);
      acknowledgements.push(parseProject(envelope.data.project));
      await route.fulfill({ response });
    },
  );
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/exports" &&
      request.method() === "POST"
    )
      submission.project = parseProject(
        (request.postDataJSON() as { project: unknown }).project,
      );
  });
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  await page.locator(".layer-name").first().click();
  await page.evaluate(() => {
    window.open = () => null;
  });
  const title = page.locator(".properties").getByLabel("제목", { exact: true });
  await title.fill("저장 확인 원본으로 바로 생성");
  await title.blur();
  await page.getByRole("button", { name: "사이트 만들고 열기 ↗" }).click();
  await expect(
    page.getByRole("link", { name: "웹사이트 바로 열기 ↗" }),
  ).toBeVisible();
  const exported = submission.project;
  if (!exported)
    throw new Error("Generation request did not contain a canonical document");
  expect(acknowledgements).not.toHaveLength(0);
  expect(acknowledgements).toContainEqual(exported);
  expect(exported.blocks[0]!.props.title).toBe("저장 확인 원본으로 바로 생성");
});

test("scoped view links restore block selection and search while browser back keeps its place", async ({
  page,
}) => {
  const p = createProject(`문맥 복원 ${randomUUID().slice(0, 8)}`),
    first = createBlock("text", p, p.pages[0]!.id),
    second = createBlock("hero", p, p.pages[0]!.id);
  first.props.title = "복원할 선택 항목";
  p.blocks.push(first, second);
  await load(page, p);
  await page.getByRole("button", { name: "블록", exact: true }).click();
  await page.getByLabel("블록 검색").fill("텍스트");
  await expect(page).toHaveURL(/studioSearch=/);
  await page.reload();
  await expect(page.getByLabel("블록 검색")).toHaveValue("텍스트");
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  const layer = page
    .locator(".layer-name")
    .filter({ hasText: first.props.title });
  await layer.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-edit-id="${first.id}"]`)).toHaveClass(
    /selected/,
  );
  const editingURL = page.url();
  await page.reload();
  await expect(page.locator(`[data-edit-id="${first.id}"]`)).toHaveClass(
    /selected/,
  );
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  await expect(page).toHaveURL(/studioPanel=pages/);
  await page.goBack();
  await expect(page).toHaveURL(editingURL);
  await expect(
    page.getByRole("heading", { name: "레이어", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("작업 위치를 복원하고 권한을 확인하고 있습니다…"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "블록", exact: true }).click();
  await expect(page.getByLabel("블록 검색")).toHaveValue("텍스트");
});

test("reviewed settings and experiment observations use actual scoped server results", async ({
  page,
}) => {
  const p = createProject(`시스템 UI ${randomUUID().slice(0, 8)}`);
  await load(page, p);
  const panel = await system(page),
    environmentId = await page.getByLabel("현재 환경").inputValue();
  await expect(panel.getByLabel("일반 환경 설정")).toBeVisible();
  await panel.getByLabel("일반 환경 설정").fill('{"reviewedUi":"validated"}');
  await panel.getByRole("button", { name: "설정 영향 검토" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("reviewedUi");
  await dialog.getByRole("button", { name: "검토한 작업 실제 적용" }).click();
  await expect(dialog).toHaveCount(0);
  const settings = await page.evaluate(
    async (target) =>
      (
        await (
          await fetch(
            `/api/advancement/config?projectId=${target.projectId}&environmentId=${target.environmentId}`,
          )
        ).json()
      ).data,
    { projectId: p.id, environmentId },
  );
  expect(settings.config.reviewedUi).toBe("validated");
  await panel.getByRole("button", { name: "릴리스·실험", exact: true }).click();
  await panel.getByLabel("실험 이름").fill("실제 저장 확인 실험");
  await panel
    .getByLabel("사전 가설")
    .fill("검토 안내로 저장 성공의 근거를 확인한다");
  await panel.getByLabel("판정 지표").selectOption("save-success");
  await panel.getByLabel("최소 표본 수").fill("10");
  await panel.getByRole("button", { name: "지표·기간·보호 조건 검토" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "검토한 작업 실제 적용" })
    .click();
  await expect(
    panel.getByText("실제 저장 확인 실험 · 실행 중", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("프로젝트 이름").fill(p.name + " · 측정 변경");
  await page.getByLabel("프로젝트 이름").blur();
  await expect
    .poll(async () => (await source(page, p.id)).name)
    .toBe(p.name + " · 측정 변경");
  await panel
    .getByRole("button", { name: "실제 배정·표본·보호 지표 확인" })
    .click();
  await expect(panel.getByText("표본 부족 · 판단 보류")).toBeVisible();
  await expect(
    panel.locator("table").getByRole("cell", { name: "1", exact: true }),
  ).not.toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 800 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(900);
});

test("indexed CMS keeps edited draft separate from its immutable published record", async ({
  page,
}) => {
  const p = createProject(`CMS 개별 초안 ${randomUUID().slice(0, 8)}`);
  p.collections = [
    {
      id: "articles",
      name: "발행 자료",
      path: "/articles",
      records: [
        {
          id: "record-1",
          slug: "record-1",
          title: "보존할 공개 원본",
          body: "공개 본문",
          category: "",
          imageId: "",
          status: "published",
          publishedAt: new Date().toISOString(),
          fields: {},
        },
      ],
    },
  ];
  await load(page, p);
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  await page.locator("summary").filter({ hasText: "콘텐츠 컬렉션" }).click();
  const panel = page.locator(".cms-working-set");
  await panel.locator("summary").first().click();
  await panel
    .getByRole("button", { name: "보존할 공개 원본", exact: false })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "콘텐츠 한 건 · 독립 변경 검토",
  });
  await dialog.getByLabel("작업집합 자료 제목").fill("검토중인 새 초안");
  await dialog.getByRole("button", { name: "한 건 변경 검토" }).click();
  await dialog.getByRole("button", { name: "검토한 한 건 실제 저장" }).click();
  await expect(dialog.getByLabel("작업집합 자료 제목")).toHaveValue(
    "검토중인 새 초안",
  );
  const record = (await source(page, p.id)).collections![0]!.records[0]!;
  expect(record.title).toBe("검토중인 새 초안");
  expect(record.publication?.record.title).toBe("보존할 공개 원본");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "검토중인 새 초안", exact: false }),
  ).toBeVisible();
});

test("legacy model editor activates only the completed server migration after durable batches", async ({
  page,
}) => {
  const p = createProject(`모델 이전 ${randomUUID().slice(0, 8)}`);
  p.collections = [
    {
      id: "articles",
      name: "이전 자료",
      path: "/articles",
      schemaRevision: 1,
      schema: [{ id: "note", label: "이전 메모", type: "text", public: false }],
      records: Array.from({ length: 105 }, (_, index) => ({
        id: `record-${String(index).padStart(3, "0")}`,
        slug: `record-${index}`,
        title: `자료 ${index}`,
        body: "본문",
        category: "",
        imageId: "",
        status: "draft",
        publishedAt: "",
        fields: { note: "보존할 값" },
      })),
    },
  ];
  await load(page, p);
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  await page.locator("summary").filter({ hasText: "콘텐츠 컬렉션" }).click();
  const model = page
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "타입 콘텐츠 모델·관계" }),
    })
    .last();
  await model.locator("summary").first().click();
  await model.getByRole("button", { name: "모델 필드 추가" }).click();
  await model.getByLabel("필드 ID", { exact: true }).last().fill("review_note");
  await model
    .getByLabel("필드 이름", { exact: true })
    .last()
    .fill("새 검토 메모");
  await model.getByRole("button", { name: "기존 자료 영향 검토" }).click();
  const dialog = page.getByRole("dialog", { name: "콘텐츠 모델 변경 검토" });
  await expect(dialog).toContainText("서버 자료 105개 검토");
  await dialog.getByRole("button", { name: "검토한 모델 적용" }).click();
  await expect(dialog).toContainText("이전 상태 running · 후보 검증 100건");
  expect((await source(page, p.id)).collections![0]!.schema).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  await page.locator("summary").filter({ hasText: "콘텐츠 컬렉션" }).click();
  const resumedModel = page
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "타입 콘텐츠 모델·관계" }),
    })
    .last();
  await resumedModel.locator("summary").first().click();
  await resumedModel
    .getByRole("button", { name: "보관한 모델 이전 재개 검토" })
    .click();
  await expect(dialog).toContainText("이전 상태 running · 후보 검증 100건");
  await expect(
    dialog.getByRole("button", { name: "다음 100건 검증·이전 계속" }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "다음 100건 검증·이전 계속" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () => (await source(page, p.id)).collections![0]!.schemaRevision,
    )
    .toBe(2);
  const canonical = (await source(page, p.id)).collections![0]!;
  expect(canonical.schema).toHaveLength(2);
  expect(canonical.records).toHaveLength(105);
  expect(canonical.records[0]!.fields?.note).toBe("보존할 값");
  await page.reload();
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  await page.locator("summary").filter({ hasText: "콘텐츠 컬렉션" }).click();
  const refreshed = page
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "타입 콘텐츠 모델·관계" }),
    })
    .last();
  await refreshed.locator("summary").first().click();
  await expect(
    refreshed.getByLabel("필드 ID", { exact: true }).last(),
  ).toHaveValue("review_note");
});

test("server image variants preserve their source and require their own publication approval", async ({
  page,
}) => {
  const p = createProject(`서버 이미지 변형 ${randomUUID().slice(0, 8)}`);
  await load(page, p);
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#123456";
    context.fillRect(0, 0, 4, 4);
    return canvas.toDataURL("image/png");
  });
  const original = await mutation<BlobAsset>(page, "/api/expansion/blobs", {
    projectId: p.id,
    dataUrl,
    alt: "원본 보존",
    source: "테스트 직접 생성",
    license: "직접 제작",
  });
  await page.getByRole("button", { name: "이미지", exact: true }).click();
  const panel = page
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "조직 공용 파일 저장소" }),
    })
    .last();
  await panel.locator("summary").first().click();
  const card = panel.locator(`[data-asset-id="${original.id}"]`);
  await card.getByLabel("서버 변형 너비").fill("2");
  await card.getByLabel("서버 변형 높이").fill("2");
  await card.getByRole("button", { name: "서버 변형 생성 검토" }).click();
  const variantReview = page.getByRole("dialog").filter({
    has: page.getByRole("button", { name: "검토한 작업 실제 적용" }),
  });
  await variantReview
    .getByRole("button", { name: "검토한 작업 실제 적용" })
    .click();
  await expect(variantReview).toHaveCount(0);
  const dialog = page.getByRole("dialog", {
    name: "공용 이미지 연결·교체 검토",
  });
  await expect(
    dialog.getByRole("button", { name: "검토한 파일 참조 적용" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  const refs = await page.evaluate(
    async (id) =>
      (await (await fetch(`/api/expansion/blobs?projectId=${id}`)).json())
        .data as BlobAsset[],
    p.id,
  );
  const variant = refs.find(
    (item) => item.inspection?.sourceRef === original.id,
  )!;
  expect(variant.width).toBe(2);
  expect(variant.height).toBe(2);
  expect(variant.mime).toBe("image/webp");
  expect(variant.inspection?.state).toBe("quarantined");
  expect(variant.inspection?.visibility).toBe("private");
  expect(refs.find((item) => item.id === original.id)!.sha256).toBe(
    original.sha256,
  );
  const resized = panel.locator(`[data-asset-id="${variant.id}"]`);
  await expect(resized.locator("img")).toHaveJSProperty("naturalWidth", 2);
  await resized.getByLabel("파일 제공 범위").selectOption("public");
  await resized
    .getByLabel("출처·사용권·검사 검토 사유")
    .fill("직접 제작한 원본의 실제 변형·픽셀 확인");
  await resized
    .getByRole("button", { name: "파일 상태·범위 변경 검토" })
    .click();
  await applyReview(page);
  await resized.getByRole("button", { name: "연결·교체 범위 검토" }).click();
  await dialog.getByRole("button", { name: "검토한 파일 참조 적용" }).click();
  await expect
    .poll(async () => (await source(page, p.id)).assets[0]?.blobRef?.id)
    .toBe(variant.id);
});

test("private review uses an authenticated static artifact and revokes the issued address", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const p = createProject(`비공개 검수 ${randomUUID().slice(0, 8)}`),
    block = createBlock("text", p, p.pages[0]!.id),
    form = createBlock("form", p, p.pages[0]!.id);
  block.props.title = "인증할 실제 검수 화면";
  p.settings.description = "정적 검수";
  p.blocks.push(block, form);
  await load(page, p);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "사이트 만들고 열기 ↗" }).click();
  const published = await popupPromise;
  await expect(published.locator(".site-root")).toBeVisible();
  await expect(
    page.getByText("사이트가 준비되었습니다", { exact: false }),
  ).toBeVisible();
  await published.close();
  const panel = await system(page);
  await panel.getByRole("button", { name: "릴리스·실험", exact: true }).click();
  await expect(
    panel.getByLabel("검수할 실제 릴리스").locator("option"),
  ).not.toHaveCount(0);
  await panel.getByLabel("미리보기 유지 시간 (분)").fill("5");
  await panel.getByRole("button", { name: "선택한 범위 검수 준비" }).click();
  await applyReview(page);
  const link = panel.getByRole("link", {
    name: "이 컴퓨터에서 인증 검수 화면 열기 ↗",
  });
  await expect(link).toBeVisible();
  const url = await link.getAttribute("href");
  expect(url).toBeTruthy();
  const review = await context.newPage();
  await review.goto(url!);
  await expect(
    review.getByText("인증할 실제 검수 화면", { exact: true }),
  ).toBeVisible();
  expect(await review.locator("script").count()).toBe(0);
  await expect(review.locator("form").first()).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    await review
      .locator("form input:not(:disabled),form button:not(:disabled)")
      .count(),
  ).toBe(0);
  const anonymous = await page.context().browser()!.newContext();
  try {
    const response = await anonymous.request.get(url!);
    expect([401, 403, 404]).toContain(response.status());
  } finally {
    await anonymous.close();
  }
  await panel.getByRole("button", { name: "검수 주소 폐기 검토" }).click();
  await applyReview(page);
  await expect(panel.getByText("검수 주소를 즉시 폐기했습니다.")).toBeVisible();
  const revoked = await review.goto(url!);
  expect([401, 403, 404, 410]).toContain(revoked!.status());
  await review.close();
});

test("existing booking schedules require server impact review and keep the chosen timezone", async ({
  page,
}) => {
  const p = createProject(`예약 검토 ${randomUUID().slice(0, 8)}`);
  await load(page, p);
  const environmentId = await page.getByLabel("현재 환경").inputValue(),
    scope = `projectId=${p.id}&environmentId=${environmentId}`,
    id = randomUUID();
  await mutation(
    page,
    `/api/platform/booking/resources?${scope}`,
    {
      id,
      name: "시간대 자원",
      capacity: 4,
      active: true,
    },
    "PUT",
  );
  await mutation(page, `/api/platform/booking/slots?${scope}`, {
    resourceId: id,
    startsAt: "2031-05-01T00:00:00.000Z",
    endsAt: "2031-05-01T01:00:00.000Z",
    capacity: 4,
  });
  await page.getByRole("button", { name: "운영", exact: true }).click();
  const business = page.getByRole("region", {
    name: "예약 확장과 주문 후처리",
  });
  await expect(business.getByLabel("IANA 시간대")).toHaveValue("UTC");
  await business.getByLabel("규칙 이름").fill("서울 시간 반복");
  await business.getByLabel("시작 날짜").fill("2031-05-02");
  await business.getByLabel("종료 날짜").fill("2031-05-03");
  await business.getByLabel("IANA 시간대").fill("Asia/Seoul");
  await business.locator('input[name="weekdays"][value="5"]').check();
  await business
    .getByRole("button", { name: "저장 검토", exact: true })
    .click();
  const ruleReview = page.getByRole("dialog");
  await expect(ruleReview).toContainText("Asia/Seoul");
  await ruleReview.getByRole("button", { name: "검토한 변경 저장" }).click();
  await expect(ruleReview).toHaveCount(0);
  await expect(
    business.getByText("서울 시간 반복", { exact: false }).first(),
  ).toContainText("Asia/Seoul");
  await business.getByLabel("변경 정원").fill("3");
  await business.getByRole("button", { name: "자원 변경 영향 검토" }).click();
  const impact = page.getByRole("dialog", {
    name: "자원 정원·사용 상태 변경 영향 검토",
  });
  await expect(impact).toContainText("생성 일정 1개");
  await impact.getByRole("button", { name: "검토한 변경 저장" }).click();
  await expect(impact).toHaveCount(0);
  await expect(
    business.getByText("시간대 자원 · 정원 3", { exact: false }),
  ).toBeVisible();
});

test("alert criteria compare their revision and expose actual local trace observations", async ({
  page,
}) => {
  const p = createProject(`운영 관측 ${randomUUID().slice(0, 8)}`);
  await load(page, p);
  const panel = await system(page);
  await panel.getByRole("button", { name: "추적·알림", exact: true }).click();
  const observation = panel.getByRole("region", {
    name: "실제 운영 추적·장애 감지",
  });
  await expect(
    observation.getByText("최근 1시간 요청 집계", { exact: true }),
  ).toBeVisible();
  await observation
    .locator("summary")
    .filter({ hasText: "새 감지 기준 등록" })
    .click();
  const form = observation.locator("form").last();
  await form.getByLabel("기준 ID").fill("ui-errors");
  await form.getByLabel("초과 기준").fill("2");
  await form.getByRole("button", { name: "새 감지 기준 검토" }).click();
  await applyReview(page);
  await expect(
    observation.getByText("ui-errors · v1 · 감지 중", { exact: false }),
  ).toBeVisible();
});

test("large document preserves offscreen selection and export while recording actual input and navigation latency", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const blockCount = Number(process.env.AUTOMADE_CAPACITY_BLOCKS || 300);
  if (![100, 300, 500, 1000].includes(blockCount))
    throw new Error("AUTOMADE_CAPACITY_BLOCKS must be 100, 300, 500 or 1000");
  const p = createProject(`용량 측정 ${randomUUID().slice(0, 8)}`);
  for (let index = 0; index < blockCount; index++) {
    const block = createBlock("text", p, p.pages[0]!.id);
    block.props.title = `측정 ${String(index).padStart(3, "0")}`;
    p.blocks.push(block);
  }
  await load(page, p);
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  await expect(page.locator(".layer-name")).toHaveCount(blockCount);
  await page.evaluate(() => {
    const samples = { input: [] as number[], keyboard: [] as number[] };
    Object.defineProperty(window, "__automadeCapacity", {
      value: samples,
      configurable: true,
    });
    const measure = (event: Event, key: "input" | "keyboard") => {
      const observed = performance.now(),
        start =
          event.timeStamp > 0 && event.timeStamp <= observed
            ? event.timeStamp
            : observed;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          samples[key].push(performance.now() - start),
        ),
      );
    };
    document.addEventListener(
      "input",
      (event) => {
        if (
          event.target instanceof HTMLInputElement &&
          event.target.closest(".tool-panel") &&
          event.target.parentElement?.textContent?.includes("레이어 검색") &&
          event.target.value
        )
          measure(event, "input");
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest(".layer-name") &&
          ["Home", "End"].includes(event.key)
        )
          measure(event, "keyboard");
      },
      true,
    );
  });
  const input: number[] = [],
    navigation: number[] = [];
  const paint = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(performance.now())),
          ),
        ),
    );
  const search = page.getByLabel("레이어 검색");
  const lastDecade = String(blockCount - 10)
    .padStart(3, "0")
    .slice(0, -1);
  for (let iteration = 0; iteration < 15; iteration++) {
    const start = await page.evaluate(() => performance.now());
    await search.fill(iteration % 2 ? `측정 ${lastDecade}` : "측정 00");
    await expect(page.locator(".layer-name")).toHaveCount(10);
    input.push((await paint()) - start);
  }
  await search.fill("");
  await expect(page.locator(".layer-name")).toHaveCount(blockCount);
  const first = page.locator(".layer-name").first();
  await first.focus();
  for (let iteration = 0; iteration < 15; iteration++) {
    const start = await page.evaluate(() => performance.now());
    await page.keyboard.press(iteration % 2 ? "Home" : "End");
    await expect(
      page.locator(".layer-name").nth(iteration % 2 ? 0 : blockCount - 1),
    ).toBeFocused();
    navigation.push((await paint()) - start);
  }
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const last = p.blocks[blockCount - 1]!;
  await expect(page.locator(`[data-edit-id="${last.id}"]`)).toHaveClass(
    /selected/,
  );
  await expect(page.locator(`[data-edit-id="${last.id}"]`)).not.toHaveClass(
    /deferred-block/,
  );
  const memory = await page.evaluate(() => {
    const heap =
      "memory" in performance
        ? (performance.memory as {
            usedJSHeapSize: number;
            totalJSHeapSize: number;
            jsHeapSizeLimit: number;
          })
        : null;
    return {
      domElements: document.querySelectorAll("*").length,
      heap: heap
        ? {
            usedJSHeapSize: heap.usedJSHeapSize,
            totalJSHeapSize: heap.totalJSHeapSize,
            jsHeapSizeLimit: heap.jsHeapSizeLimit,
          }
        : null,
    };
  });
  const eventSamples = await page.evaluate(
    () =>
      (
        window as Window & {
          __automadeCapacity?: { input: number[]; keyboard: number[] };
        }
      ).__automadeCapacity,
  );
  if (!eventSamples)
    throw new Error("Capacity event collector was not initialized");
  const eventInput = eventSamples.input.slice(0, 15),
    eventKeyboard = eventSamples.keyboard.slice(0, 15);
  expect(eventInput).toHaveLength(15);
  expect(eventKeyboard).toHaveLength(15);
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "원본 내보내기", exact: true })
    .click();
  const file = await downloaded;
  const exported = JSON.parse(
    await readFile((await file.path())!, "utf8"),
  ) as Project;
  expect(exported.blocks).toHaveLength(blockCount);
  expect(exported.blocks[blockCount - 1]!.props.title).toBe(
    `측정 ${String(blockCount - 1).padStart(3, "0")}`,
  );
  const p95 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
  const evidence = {
    recordedAt: new Date().toISOString(),
    fixture: { blocks: blockCount, records: 0 },
    method:
      "Playwright action start to verified DOM result and second animation frame; automation round trips included",
    browser: page.context().browser()!.version(),
    machine: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    input: { samples: input, p95Ms: p95(input) },
    keyboardNavigation: { samples: navigation, p95Ms: p95(navigation) },
    eventToPaint: {
      method:
        "DOM input/keydown event timestamp to second requestAnimationFrame; DOM outcome also verified",
      targetMs: 100,
      input: { samples: eventInput, p95Ms: p95(eventInput) },
      keyboard: { samples: eventKeyboard, p95Ms: p95(eventKeyboard) },
      targetMet: p95(eventInput) <= 100 && p95(eventKeyboard) <= 100,
    },
    memory,
    exportPreserved: true,
    scope:
      "single local Chromium fixture; not field performance or device evidence",
  };
  await mkdir(".data", { recursive: true });
  await writeFile(
    `.data/system-editor-capacity-${blockCount}.json`,
    JSON.stringify(evidence, null, 2),
  );
  if (blockCount === 300)
    await writeFile(
      ".data/system-editor-capacity.json",
      JSON.stringify(evidence, null, 2),
    );
  await testInfo.attach("system-editor-capacity", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  expect(evidence.input.p95Ms).toBeLessThan(2000);
  expect(evidence.keyboardNavigation.p95Ms).toBeLessThan(2000);
});
