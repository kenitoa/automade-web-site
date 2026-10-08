import { test, expect, type Page } from "@playwright/test";
import { createProject, createBlock } from "../src/domain/catalog";
import type { Project } from "../src/domain/types";
import { randomUUID } from "node:crypto";
async function json<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (route) => {
    const response = await fetch(route);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "API failed");
    return result.data;
  }, path) as Promise<T>;
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
      name: "expansion.interface.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(p)),
    });
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
  await expect
    .poll(async () => {
      try {
        return (await json<Project>(page, `/api/projects/${p.id}`)).id;
      } catch {
        return "";
      }
    })
    .toBe(p.id);
  await expect(
    page.getByLabel("현재 사이트").locator("option:checked"),
  ).toContainText(p.name);
}
test("existing eight menus preserve registered blocks, linked component application and locale authoring", async ({
  page,
}) => {
  const p = createProject(`확장 편집 ${randomUUID().slice(0, 8)}`),
    text = createBlock("text", p, p.pages[0]!.id);
  text.props.title = "공유 원본 제목";
  p.blocks.push(text);
  await load(page, p);
  await expect(
    page.getByRole("navigation", { name: "편집 도구" }).getByRole("button"),
  ).toHaveCount(8);
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  await page
    .locator(".layer-name")
    .filter({ hasText: "공유 원본 제목" })
    .click();
  await page.getByRole("button", { name: "블록", exact: true }).click();
  const library = page
    .locator("details")
    .filter({
      has: page.locator("summary", {
        hasText: "조직 공용 브랜드·연결 컴포넌트",
      }),
    })
    .first();
  await library.locator("summary").first().click();
  await library.getByLabel("공유 자료 이름").fill(`공유 구성 ${p.id}`);
  await library
    .getByRole("button", { name: "선택 영역을 공용 컴포넌트 등록" })
    .click();
  const card = library
    .locator("article")
    .filter({ hasText: `공유 구성 ${p.id}` });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "연결 삽입 검토" }).click();
  await expect(page.getByRole("dialog")).toContainText("연결 인스턴스 삽입");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "검토한 변경 적용" })
    .click();
  await expect
    .poll(async () => {
      const source = await json<Project>(page, `/api/projects/${p.id}`);
      return source.blocks.filter((b) => b.componentLink).length;
    })
    .toBe(1);
  await page
    .getByRole("button", { name: "일정과 진행 과정", exact: true })
    .click();
  await expect(page.locator(".site-timeline")).toBeVisible();
  const stage = page.locator(".properties .editor-item").first();
  await stage.locator("summary").first().click();
  await stage.getByLabel("제목", { exact: true }).fill("검토 완료 단계");
  await stage.getByLabel("제목", { exact: true }).blur();
  await expect(page.locator(".site-timeline h3").first()).toHaveText(
    "검토 완료 단계",
  );
  await page.getByRole("button", { name: "사이트 설정", exact: true }).click();
  await page
    .locator(".properties summary")
    .filter({ hasText: "언어·지역·원문 대체" })
    .click();
  await page.getByLabel("추가 언어·지역 코드").fill("fr-CA");
  await page.getByRole("button", { name: "언어 검증·추가" }).click();
  await expect
    .poll(async () => {
      const source = await json<Project>(page, `/api/projects/${p.id}`);
      return source.settings.languages || [];
    })
    .toContain("fr-CA");
  await expect
    .poll(async () => {
      const source = await json<Project>(page, `/api/projects/${p.id}`);
      return source.blocks.some((b) => b.type === "automade:timeline");
    })
    .toBe(true);
  await page.reload();
  await expect(page.locator(".site-timeline h3").first()).toHaveText(
    "검토 완료 단계",
  );
  await page.setViewportSize({ width: 900, height: 800 });
  if (
    await page.getByRole("button", { name: "속성 열기", exact: true }).count()
  )
    await page.getByRole("button", { name: "속성 열기", exact: true }).click();
  await expect(page.locator(".properties")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(900);
  await page.screenshot({
    path: "test-results/expansion-editor-narrow.png",
    fullPage: true,
  });
});
test("typed CMS validates server cursor reads and saves one selected record with actual CAS", async ({
  page,
}) => {
  const p = createProject(`CMS 모델 ${randomUUID().slice(0, 8)}`);
  p.collections = [
    {
      id: "articles",
      name: "검증 컬렉션",
      path: "/articles",
      schemaRevision: 1,
      schema: [
        {
          id: "amount",
          label: "수량",
          type: "number",
          min: 0,
          public: true,
          localized: true,
        },
      ],
      records: Array.from({ length: 23 }, (_, i) => ({
        id: `record-${i}`,
        slug: `record-${i}`,
        title: `콘텐츠 ${String(i).padStart(2, "0")}`,
        body: "기존 본문",
        category: "",
        imageId: "",
        status: "draft",
        publishedAt: "",
        fields: {},
        values: { amount: i },
      })),
    },
  ];
  await load(page, p);
  await page.getByRole("button", { name: "페이지", exact: true }).click();
  await page.locator("summary").filter({ hasText: "콘텐츠 컬렉션" }).click();
  await page
    .locator("summary")
    .filter({ hasText: "서버 목록·개별 저장" })
    .click();
  await page.getByRole("button", { name: "서버 목록 조회" }).click();
  await expect(page.locator(".cms-server-panel")).toContainText(
    "전체 23개 · 표시 20개",
  );
  await page.getByRole("button", { name: "서버 다음 20개" }).click();
  await expect(page.locator(".cms-server-panel")).toContainText("표시 3개");
  await page
    .locator(".cms-server-panel")
    .getByRole("button", { name: "콘텐츠 20", exact: false })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("서버 자료 제목").fill("개별 저장한 제목");
  await dialog.getByRole("button", { name: "변경 내용 검토" }).click();
  await dialog.getByRole("button", { name: "검토한 한 건 저장" }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () => {
      const source = await json<Project>(page, `/api/projects/${p.id}`);
      return source.collections![0]!.records.find((r) => r.id === "record-20")!
        .title;
    })
    .toBe("개별 저장한 제목");
  const source = await json<Project>(page, `/api/projects/${p.id}`);
  expect(source.collections![0]!.records).toHaveLength(23);
  expect(
    source.collections![0]!.records.find((r) => r.id === "record-19")!.title,
  ).toBe("콘텐츠 19");
  expect(
    source.collections![0]!.records.find((r) => r.id === "record-20")!.workflow
      ?.state,
  ).toBe("draft");
});
test("real blob storage links an asset and site cloning materializes authorized bytes", async ({
  page,
}) => {
  const p = createProject(`공용 이미지 ${randomUUID().slice(0, 8)}`);
  p.blocks.push(createBlock("image", p, p.pages[0]!.id));
  await load(page, p);
  await page.getByRole("button", { name: "이미지", exact: true }).click();
  const panel = page
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "조직 공용 파일 저장소" }),
    })
    .first();
  await panel.locator("summary").first().click();
  const png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      canvas.getContext("2d")!.fillRect(0, 0, 1, 1);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }),
    "base64",
  );
  await panel.getByLabel("최적화 후 저장").uncheck();
  await panel.getByLabel("파일", { exact: true }).setInputFiles({
    name: "verified.png",
    mimeType: "image/png",
    buffer: png,
  });
  await panel.getByLabel("공용 대체 텍스트").fill("검증한 공용 이미지");
  await panel.getByLabel("공용 사용 권한").fill("테스트에서 직접 생성");
  await panel.getByRole("button", { name: "공용 저장소에 업로드" }).click();
  await expect(
    page.getByRole("dialog", { name: "공용 이미지 연결·교체 검토" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "검토한 파일 참조 적용" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  const stored = panel.locator(".asset-card").first();
  await stored.getByLabel("파일 제공 범위").selectOption("public");
  await stored
    .getByLabel("출처·사용권·검사 검토 사유")
    .fill("직접 만든 PNG의 출처·사용권과 화면 결과 확인");
  await stored
    .getByRole("button", { name: "파일 상태·범위 변경 검토" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "검토한 작업 실제 적용" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await stored.getByRole("button", { name: "연결·교체 범위 검토" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "검토한 파일 참조 적용" })
    .click();
  await expect
    .poll(async () => {
      const source = await json<Project>(page, `/api/projects/${p.id}`);
      return source.assets.length;
    })
    .toBe(1);
  const saved = await json<Project>(page, `/api/projects/${p.id}`);
  expect(saved.assets[0]!.data).toBe("");
  expect(saved.assets[0]!.blobRef?.projectId).toBe(p.id);
  await expect(page.locator(".asset-card img").first()).toHaveJSProperty(
    "naturalWidth",
    1,
  );
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  await page.getByLabel("새 사이트 이름").fill(`${p.name} 복제`);
  await page.getByLabel("제작 원본").selectOption("copy");
  await page.getByRole("button", { name: "새 사이트 범위 검토" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "검토한 사이트 생성" })
    .click();
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(`${p.name} 복제`);
  const list = await json<Project[]>(page, "/api/projects"),
    clone = list.find((item) => item.name === `${p.name} 복제`)!;
  expect(clone.id).not.toBe(p.id);
  expect(clone.assets[0]!.data).toMatch(/^data:image\/png;base64,/);
  expect(clone.assets[0]!.blobRef).toBeUndefined();
  expect(
    (await json<Project>(page, `/api/projects/${p.id}`)).assets[0]!.blobRef,
  ).toBeTruthy();
});
test("overlapping source edits require a three-way choice and environments persist isolated data keys", async ({
  page,
}) => {
  const p = createProject(`변경 비교 ${randomUUID().slice(0, 8)}`),
    block = createBlock("text", p, p.pages[0]!.id);
  block.props.title = "충돌 기준 제목";
  p.blocks.push(block);
  await load(page, p);
  await page.getByRole("button", { name: "레이어", exact: true }).click();
  await page
    .locator(".layer-name")
    .filter({ hasText: "충돌 기준 제목" })
    .click();
  const remote = await json<Project>(page, `/api/projects/${p.id}`);
  remote.blocks[0]!.props.title = "서버의 별도 변경";
  remote.revision++;
  remote.updatedAt = new Date().toISOString();
  await page.evaluate(async (project) => {
    const session = (await (await fetch("/api/session")).json()).data,
      creator = (await (await fetch("/api/expansion/session")).json()).data;
    const response = await fetch("/api/projects", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrf,
        "X-Creator-CSRF": creator.csrf,
      },
      body: JSON.stringify({ project, baseRevision: project.revision - 1 }),
    });
    if (!response.ok) throw new Error(JSON.stringify(await response.json()));
  }, remote);
  await page
    .locator(".properties")
    .getByLabel("제목", { exact: true })
    .fill("기기의 겹친 변경");
  await page.locator(".properties").getByLabel("제목", { exact: true }).blur();
  const dialog = page.getByRole("dialog", {
    name: "온라인·오프라인 변경 비교",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("서버의 별도 변경");
  await expect(
    dialog.getByRole("button", { name: "검토한 병합 적용·동기화" }),
  ).toBeDisabled();
  for (const choice of await dialog.getByLabel("이 필드 반영").all())
    await choice.selectOption("local");
  await dialog.getByRole("button", { name: "검토한 병합 적용·동기화" }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(
      async () =>
        (await json<Project>(page, `/api/projects/${p.id}`)).blocks[0]!.props
          .title,
    )
    .toBe("기기의 겹친 변경");
  await page.getByRole("button", { name: "프로젝트", exact: true }).click();
  const envName = `검수 ${p.id}`;
  await page.getByLabel("새 환경 이름").fill(envName);
  await page.getByRole("button", { name: "환경 생성", exact: true }).click();
  await expect(
    page.getByLabel("현재 환경").locator("option").filter({ hasText: envName }),
  ).toHaveCount(1);
  await page
    .getByLabel("현재 환경")
    .selectOption({ label: `${envName} · staging` });
  await expect(
    page.getByLabel("현재 환경").locator("option:checked"),
  ).toContainText(envName);
  const bootstrap = await json<{
      environments: {
        id: string;
        name: string;
        dataKey: string;
        kind: string;
      }[];
    }>(page, `/api/expansion/bootstrap?projectId=${p.id}`),
    stage = bootstrap.environments.find((env) => env.name === envName)!,
    production = bootstrap.environments.find(
      (env) => env.kind === "production",
    )!;
  expect(stage.dataKey).not.toBe(production.dataKey);
  await page.reload();
  await expect(page.getByLabel("현재 환경")).toBeVisible();
});

test("declarative pack registration, reviewed installation and paused removal preserve original content", async ({
  page,
}) => {
  const p = createProject(`업종팩 검토 ${randomUUID().slice(0, 8)}`),
    packId = `test.${p.id}`;
  await load(page, p);
  await page.getByRole("button", { name: "블록", exact: true }).click();
  const panel = page
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "버전 업종팩·블록 모듈" }),
    })
    .first();
  await panel.locator("summary").first().click();
  await panel.getByText("조직 업종팩 작성·등록", { exact: true }).click();
  await panel.getByLabel("팩 ID", { exact: true }).fill(packId);
  await panel.getByLabel("팩 이름", { exact: true }).fill(`검증 팩 ${p.id}`);
  await panel
    .getByLabel("설명", { exact: true })
    .fill("독립적인 선언형 표시 구성");
  await panel.getByLabel("검증된 표시 유형").selectOption("text");
  await panel.getByLabel("기본 제목", { exact: true }).fill("업종별 안내 문구");
  await panel.getByRole("button", { name: "계약·무결성 생성 후 등록" }).click();
  const card = panel
    .locator("article")
    .filter({ has: page.locator("strong", { hasText: `검증 팩 ${p.id}` }) });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "설치 검토", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "업종팩 변경·권한 검토" });
  await expect(dialog).toContainText("모드 install");
  expect(
    (await json<Project>(page, `/api/projects/${p.id}`)).blocks,
  ).toHaveLength(0);
  await dialog.getByRole("button", { name: "검토한 팩 변경 적용" }).click();
  await expect(dialog).not.toBeVisible();
  let source = await json<Project>(page, `/api/projects/${p.id}`);
  expect(source.blocks[0]?.props.title).toBe("업종별 안내 문구");
  const blockId = source.blocks[0]!.id;
  await card.getByRole("button", { name: "중지 영향 검토" }).click();
  await expect(dialog).toContainText("모드 pause");
  await dialog.getByRole("button", { name: "검토한 팩 변경 적용" }).click();
  await expect(dialog).not.toBeVisible();
  source = await json<Project>(page, `/api/projects/${p.id}`);
  expect(source.blocks[0]?.id).toBe(blockId);
  expect(source.blocks[0]?.props.title).toBe("업종별 안내 문구");
  await card.getByRole("button", { name: "제거 영향 검토" }).click();
  await expect(dialog).toContainText("모드 remove");
  await dialog.getByRole("button", { name: "검토한 팩 변경 적용" }).click();
  await expect(dialog).not.toBeVisible();
  source = await json<Project>(page, `/api/projects/${p.id}`);
  expect(source.blocks[0]?.id).toBe(blockId);
  expect(source.blocks[0]?.props.title).toBe("업종별 안내 문구");
  await page.reload();
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue(p.name);
});

test("generation keeps its reviewed environment when selection changes before the real request completes", async ({
  page,
}) => {
  const p = createProject(`환경 고정 ${randomUUID().slice(0, 8)}`);
  p.settings.description = "실제 환경별 생성 범위 검증";
  p.blocks.push(createBlock("text", p, p.pages[0]!.id));
  await load(page, p);
  await page.getByLabel("새 환경 이름").fill(`생성 검수 ${p.id}`);
  await page.getByRole("button", { name: "환경 생성", exact: true }).click();
  const stageOption = page
    .getByLabel("현재 환경")
    .locator("option")
    .filter({ hasText: `생성 검수 ${p.id}` });
  await expect(stageOption).toHaveCount(1);
  const stageId = await stageOption.getAttribute("value");
  await page.getByLabel("현재 환경").selectOption(stageId!);
  let requestEnvironment: string | null = null;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/exports",
    async (route) => {
      if (route.request().method() === "POST") {
        requestEnvironment = new URL(route.request().url()).searchParams.get(
          "environmentId",
        );
        await gate;
      }
      await route.continue();
    },
  );
  const completedRequest = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/exports" &&
      response.request().method() === "POST",
  );
  try {
    await page.getByRole("button", { name: "사이트 만들고 열기 ↗" }).click();
    await expect.poll(() => requestEnvironment).toBe(stageId);
    await page
      .getByLabel("현재 환경")
      .selectOption({ label: "운영 · production" });
    release();
    const envelope = (await (await completedRequest).json()) as {
      data: { id: string };
    };
    await expect(
      page.getByRole("link", { name: "웹사이트 바로 열기 ↗" }),
    ).toBeVisible();
    await expect(
      page.getByText(/결과의 원본 버전 또는 환경이 현재 선택과 다릅니다/),
    ).toBeVisible();
    const versions = await json<{ id: string }[]>(
      page,
      `/api/projects/${p.id}/releases?environmentId=${stageId}`,
    );
    expect(versions.some((version) => version.id === envelope.data.id)).toBe(
      true,
    );
    await page.reload();
    await page.getByRole("button", { name: "결과물", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "웹사이트 바로 열기 ↗" }),
    ).toBeVisible();
    await expect(
      page.getByText(/결과의 원본 버전 또는 환경이 현재 선택과 다릅니다/),
    ).toBeVisible();
  } finally {
    release();
  }
});
