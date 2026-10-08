import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createBlock, createProject } from "../src/domain/catalog";
import { parseProject, record } from "../src/domain/validation";

test.describe("generated runtime upgrade", () => {
  let site: { origin: string }, helper: ChildProcess;
  const project = createProject("운영 고도화 브라우저 검증");
  project.settings.description = "실제 방문자 흐름 검증";
  project.settings.siteUrl = "https://example.org";
  project.settings.languages = ["ko", "en"];
  const home = project.pages[0]!;
  home.translations = {
    en: { title: "English home", description: "English site description" },
  };
  const protectedPage = {
    id: "member-page",
    title: "회원 자료",
    path: "/members",
    description: "PRIVATE_DESCRIPTION",
    published: true,
    home: false,
    access: "members" as const,
  };
  project.pages.push(protectedPage);
  project.assets.push({
    id: "seo-share",
    name: "공유 이미지",
    mime: "image/png",
    data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf6kAAAAASUVORK5CYII=",
    alt: "공유 미리보기",
  });
  project.pages.push({
    id: "seo-page",
    title: "공유 안내",
    description: "기본 공유 설명",
    path: "/details",
    home: false,
    published: true,
    seo: {
      title: "공유 검색 제목",
      description: "공유 검색 설명",
      imageAssetId: "seo-share",
      noIndex: false,
    },
    translations: {
      en: {
        title: "Sharing information",
        description: "Translated sharing description",
      },
    },
  });
  const nav = createBlock("navigation", project, "*"),
    cards = createBlock("cards", project, home.id),
    form = createBlock("form", project, home.id),
    table = createBlock("table", project, home.id),
    member = createBlock("text", project, protectedPage.id),
    rich = createBlock("text", project, home.id);
  cards.props.title = "게시된 사례";
  cards.props.collectionBinding = {
    collectionId: "case-collection",
    category: "",
    limit: 10,
    detailLinks: true,
  };
  form.props.title = "동의 문의";
  form.props.formSettings = {
    privacyNotice: "문의 처리를 위해 입력 정보를 저장합니다.",
    consentRequired: true,
    successMessage: "동의한 문의를 접수했습니다.",
    successAction: { kind: "none" },
    category: "상담",
  };
  form.props.fields[0]!.description = "문의에 사용할 이름";
  table.props.title = "제약 있는 표";
  table.props.columns = [
    {
      id: "identity",
      label: "고유 이름",
      type: "text",
      required: true,
      unique: true,
      readOnly: true,
    },
    { id: "amount", label: "수량", type: "number", required: true },
  ];
  table.props.rows = [{ id: "row-original", values: ["원본", "3"] }];
  member.props.title = "회원 전용 실제 자료";
  member.props.body = "MEMBER_CONTENT_PRIVATE";
  rich.props.title = "읽기 쉬운 소개";
  rich.props.headingLevel = 1;
  rich.props.richText = [
    { kind: "paragraph", spans: [{ text: "실제 소개", bold: true }] },
    { kind: "bullet", spans: [{ text: "첫 항목" }] },
  ];
  rich.props.translations = {
    en: {
      title: "Readable introduction",
      body: "",
      primaryAction: "",
      secondaryAction: "",
    },
  };
  rich.layout.responsive = {
    mobile: { fontSize: 18, padding: 12, headingSize: 28 },
  };
  project.blocks.push(nav, rich, cards, form, table, member);
  project.collections = [
    {
      id: "case-collection",
      name: "사례",
      path: "/cases",
      records: [
        {
          id: "case-published",
          slug: "published",
          title: "공개된 실제 사례",
          body: "공개 사례 설명",
          category: "",
          imageId: "",
          status: "published",
          publishedAt: new Date().toISOString(),
          fields: {},
          translations: {
            en: {
              title: "Published English case",
              body: "English case description",
            },
          },
        },
        {
          id: "case-draft",
          slug: "draft",
          title: "DRAFT_PRIVATE",
          body: "DRAFT_BODY_PRIVATE",
          category: "",
          imageId: "",
          status: "draft",
          publishedAt: "",
          fields: {},
        },
      ],
    },
    {
      id: "member-collection",
      name: "회원 사례",
      path: "/private-cases",
      access: "members",
      records: [
        {
          id: "private-record",
          slug: "published",
          title: "MEMBER_CMS_SECRET_TITLE",
          body: "MEMBER_CMS_SECRET_BODY",
          category: "",
          imageId: "",
          status: "published",
          publishedAt: new Date().toISOString(),
          fields: {},
          translations: {
            en: {
              title: "Member case English",
              body: "MEMBER_CMS_ENGLISH_BODY",
            },
          },
        },
      ],
    },
  ];
  test.beforeAll(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "automade-runtime-e2e-"));
    const projectFile = path.join(root, "project.json");
    await writeFile(projectFile, JSON.stringify(parseProject(project)));
    helper = fork(
      path.resolve("tests/helpers/runtime-site.ts"),
      [projectFile],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, SITE_HOST: "127.0.0.1", SITE_PUBLIC_ORIGIN: "" },
      },
    );
    site = await new Promise<{ origin: string }>((resolve, reject) => {
      let diagnostic = "";
      helper.stderr?.on("data", (value: Buffer) => {
        diagnostic += value.toString();
      });
      helper.once("message", (value: unknown) => {
        const response = record(value);
        if (typeof response.origin === "string")
          resolve({ origin: response.origin });
        else reject(new Error("사이트 실행 주소가 없습니다."));
      });
      helper.once("exit", (code) => {
        if (code) reject(new Error(diagnostic || `사이트 시작 실패: ${code}`));
      });
      helper.once("error", reject);
    });
    const response = await fetch(`${site.origin}/api/platform/session`),
      session = record(record(await response.json()).data);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const configure = async (route: string, method: string, body: unknown) => {
      const response = await fetch(`${site.origin}/api/platform/${route}`, {
        method,
        headers: {
          Origin: site.origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-Platform-CSRF": String(session.csrf),
        },
        body: JSON.stringify(body),
      });
      expect(response.ok, await response.text()).toBeTruthy();
    };
    await configure("catalog", "PUT", {
      projectId: project.id,
      id: "product-one",
      name: "실제 구성 상품",
      priceMinor: 1500,
      currency: "KRW",
      inventory: 10,
      active: true,
    });
    await configure("booking/resources", "PUT", {
      projectId: project.id,
      id: "consultation",
      name: "상담 일정",
      capacity: 2,
      active: true,
    });
    await configure("booking/slots", "POST", {
      projectId: project.id,
      resourceId: "consultation",
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      capacity: 2,
    });
  });
  test.afterAll(async () => {
    if (helper?.connected) {
      const stopped = new Promise<void>((resolve) =>
        helper.once("exit", () => resolve()),
      );
      helper.send({ shutdown: true });
      await stopped;
    }
  });
  const register = async (page: Page) => {
    const platform = page.locator(".site-platform");
    await platform.locator("details").first().locator("summary").click();
    await platform
      .getByRole("button", { name: "회원가입", exact: true })
      .click();
    await platform
      .getByLabel("이메일", { exact: true })
      .fill(`visitor-${randomUUID()}@example.org`);
    await platform.getByLabel("표시 이름").fill("방문자");
    await platform
      .getByLabel("비밀번호", { exact: true })
      .fill("browser-password-2026");
    await platform.getByRole("button", { name: "가입", exact: true }).click();
    await expect(
      platform.getByText("가입했습니다.", { exact: true }),
    ).toBeVisible();
    return platform;
  };
  test("register, protected content authorization and logout remove private content", async ({
    page,
  }) => {
    const before = await page.request.get(`${site.origin}/members`);
    expect(await before.text()).not.toContain("MEMBER_CONTENT_PRIVATE");
    await page.goto(`${site.origin}/members`);
    await expect(
      page.getByRole("heading", { name: "회원 전용 페이지", exact: true }),
    ).toBeVisible();
    const platform = await register(page);
    await expect(
      page.getByRole("heading", { name: "회원 전용 실제 자료" }),
    ).toBeVisible();
    await expect(
      page.getByText("MEMBER_CONTENT_PRIVATE", { exact: true }),
    ).toBeVisible();
    await platform
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "회원 전용 페이지", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("MEMBER_CONTENT_PRIVATE", { exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await page.request.get(`${site.origin}/api/platform/member-project`)
      ).status(),
    ).toBe(401);
  });
  test("published CMS routes, safe prose, language switching and responsive override render", async ({
    page,
  }) => {
    await page.goto(site.origin);
    await expect(page.locator(`#block-${rich.id} strong`)).toHaveText(
      "실제 소개",
    );
    await expect(page.locator(`#block-${rich.id} ul li`)).toHaveText("첫 항목");
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(page).toHaveURL(`${site.origin}/en/`);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://example.org/en/",
    );
    await expect(
      page.getByRole("heading", { name: "Readable introduction" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "한국어", exact: true }).click();
    await expect(page).toHaveURL(`${site.origin}/`);
    await page
      .locator(`#block-${nav.id}`)
      .getByRole("button", { name: "공유 안내", exact: true })
      .click();
    await expect(page).toHaveURL(`${site.origin}/details`);
    const imageUrl = "https://example.org/assets/share-seo-share.png";
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      imageUrl,
    );
    await expect
      .poll(async () =>
        JSON.parse(
          (await page
            .locator('script[type="application/ld+json"]')
            .textContent()) || "{}",
        ),
      )
      .toMatchObject({
        name: "공유 검색 제목",
        description: "공유 검색 설명",
        url: "https://example.org/details",
        image: imageUrl,
        inLanguage: "ko",
      });
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(page).toHaveURL(`${site.origin}/en/details`);
    await expect
      .poll(async () =>
        JSON.parse(
          (await page
            .locator('script[type="application/ld+json"]')
            .textContent()) || "{}",
        ),
      )
      .toMatchObject({
        name: "Sharing information",
        description: "Translated sharing description",
        url: "https://example.org/en/details",
        image: imageUrl,
        inLanguage: "en",
      });
    const staticSource = await (
      await page.request.get(`${site.origin}/en/details`)
    ).text();
    expect(staticSource).toContain(`property="og:image" content="${imageUrl}"`);
    expect(staticSource).toContain('"name":"Sharing information"');
    await page
      .locator(`#block-${nav.id}`)
      .getByRole("button", { name: "English home", exact: true })
      .click();
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
    await expect
      .poll(async () =>
        JSON.parse(
          (await page
            .locator('script[type="application/ld+json"]')
            .textContent()) || "{}",
        ),
      )
      .toMatchObject({
        name: "English home",
        url: "https://example.org/en/",
        inLanguage: "en",
      });
    await page.getByRole("button", { name: "한국어", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(`#block-${rich.id}`)).toHaveCSS(
      "font-size",
      "18px",
    );
    await expect(page.locator(`#block-${rich.id}`)).toHaveCSS(
      "padding",
      "12px",
    );
    expect(
      await page
        .locator("body")
        .evaluate((body) => body.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.goto(`${site.origin}/cases/published`);
    await expect(
      page.getByRole("heading", { name: "공개된 실제 사례", exact: true }),
    ).toBeVisible();
    const source = await (
      await page.request.get(`${site.origin}/cases/published`)
    ).text();
    expect(source).not.toContain("DRAFT_PRIVATE");
    expect(source).not.toContain("DRAFT_BODY_PRIVATE");
    expect(
      (await page.request.get(`${site.origin}/cases/draft`)).status(),
    ).toBe(404);
    await page.goto(`${site.origin}/en/cases/published`);
    await expect(
      page.getByRole("heading", {
        name: "Published English case",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://example.org/en/cases/published",
    );
    const english = await (
      await page.request.get(`${site.origin}/en/cases/published`)
    ).text();
    expect(english).toContain('<html lang="en">');
    expect(english).toContain("<h1>Published English case</h1>");
    expect(english).toContain(
      'hreflang="ko" href="https://example.org/cases/published"',
    );
    await page.getByRole("button", { name: "한국어", exact: true }).click();
    await expect(page).toHaveURL(`${site.origin}/cases/published`);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "공개된 실제 사례", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("mobile-runtime.png"),
      fullPage: true,
    });
  });
  test("protected CMS direct URL remains a safe shell before login and reloads after login", async ({
    page,
  }) => {
    const before = await page.request.get(
      `${site.origin}/en/private-cases/published`,
    );
    expect(before.status()).toBe(200);
    const source = await before.text();
    expect(source).not.toContain("MEMBER_CMS_SECRET");
    expect(source).not.toContain("MEMBER_CMS_ENGLISH_BODY");
    expect(source).toContain('name="robots" content="noindex,follow"');
    await page.goto(`${site.origin}/en/private-cases/published`);
    await expect(
      page.getByRole("heading", { name: "회원 전용 페이지", exact: true }),
    ).toBeVisible();
    const platform = await register(page);
    await expect(
      page.getByRole("heading", { name: "Member case English", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("MEMBER_CMS_ENGLISH_BODY", { exact: true }),
    ).toBeVisible();
    await platform.locator("summary").filter({ hasText: "내 계정" }).click();
    await platform
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "회원 전용 페이지", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("MEMBER_CMS_ENGLISH_BODY", { exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await page.request.get(`${site.origin}/en/private-cases/missing`)
      ).status(),
    ).toBe(404);
  });
  test("form consent rejects missing consent and accepts saved completed submission", async ({
    page,
  }) => {
    await page.goto(site.origin);
    const block = page.locator(`#block-${form.id}`);
    await block.getByLabel("이름", { exact: false }).fill("실제 이름");
    await block
      .getByLabel("이메일", { exact: false })
      .fill("inquiry@example.org");
    await block
      .getByLabel("문의 내용", { exact: false })
      .fill("실제 문의 내용입니다.");
    await block.getByRole("button", { name: "문의 보내기" }).click();
    await expect(
      block.getByText("개인정보 안내를 확인하고 동의하세요.", { exact: true }),
    ).toBeVisible();
    const rejected = await page.request.post(
      `${site.origin}/api/forms/${form.id}`,
      {
        headers: { Origin: site.origin },
        data: {
          idempotencyKey: randomUUID(),
          values: {
            name: "입력",
            email: "test@example.org",
            message: "서버 검증 문의",
          },
        },
      },
    );
    expect(rejected.status()).toBe(400);
    await block.locator('[name="__consent"]').check();
    await block.getByRole("button", { name: "문의 보내기" }).click();
    await expect(
      block.getByText("동의한 문의를 접수했습니다.", { exact: true }),
    ).toBeVisible();
  });
  test("catalog orders and capacity bookings persist and cancel through visitor controls", async ({
    page,
  }) => {
    await page.goto(site.origin);
    const platform = await register(page);
    await platform.getByText("상품과 내 주문", { exact: true }).click();
    await expect(
      platform.getByRole("heading", { name: "실제 구성 상품" }),
    ).toBeVisible();
    await platform
      .getByRole("button", { name: "주문 만들기", exact: true })
      .click();
    await expect(
      platform.getByText(
        "주문을 만들었습니다. 내 주문에서 결제를 진행하세요.",
        { exact: true },
      ),
    ).toBeVisible();
    await platform
      .getByRole("button", { name: "주문 취소", exact: true })
      .click();
    await expect(
      platform.getByText("주문을 취소했습니다.", { exact: true }),
    ).toBeVisible();
    await platform.getByText("예약과 내 일정", { exact: true }).click();
    await platform.getByRole("button", { name: "예약", exact: true }).click();
    await expect(
      platform.getByText("예약을 접수했습니다.", { exact: true }),
    ).toBeVisible();
    await platform
      .getByRole("button", { name: "예약 취소", exact: true })
      .click();
    await expect(
      platform.getByText("예약을 취소했습니다.", { exact: true }),
    ).toBeVisible();
  });
  test("readOnly and unique table violations are rejected on the server", async ({
    page,
  }) => {
    await page.goto(site.origin);
    const data = record(
      record(
        await (
          await page.request.get(`${site.origin}/api/tables/${table.id}`)
        ).json(),
      ).data,
    );
    const altered = await page.request.put(
      `${site.origin}/api/tables/${table.id}`,
      {
        headers: { Origin: site.origin },
        data: {
          expectedVersion: data.version,
          rows: [{ id: "row-original", values: ["변경 시도", "3"] }],
        },
      },
    );
    expect(altered.status()).toBe(400);
    const duplicate = await page.request.put(
      `${site.origin}/api/tables/${table.id}`,
      {
        headers: { Origin: site.origin },
        data: {
          expectedVersion: data.version,
          rows: [
            { id: "row-original", values: ["원본", "3"] },
            { id: "row-duplicate", values: ["원본", "4"] },
          ],
        },
      },
    );
    expect(duplicate.status()).toBe(400);
    const unchanged = record(
      record(
        await (
          await page.request.get(`${site.origin}/api/tables/${table.id}`)
        ).json(),
      ).data,
    );
    expect(unchanged.rows).toEqual([
      { id: "row-original", values: ["원본", "3"] },
    ]);
  });
  test("table conflict keeps both versions and operational history shows before and after", async ({
    page,
  }) => {
    await page.goto(site.origin);
    const block = page.locator(`#block-${table.id}`);
    await expect(
      block.getByRole("button", { name: "수정", exact: true }),
    ).toBeEnabled();
    await block.getByRole("button", { name: "수정", exact: true }).click();
    await expect(
      block.getByLabel("고유 이름", { exact: true }),
    ).toHaveAttribute("readonly", "");
    await block.getByLabel("수량", { exact: true }).fill("5");
    const data = record(
      record(
        await (
          await page.request.get(`${site.origin}/api/tables/${table.id}`)
        ).json(),
      ).data,
    );
    const written = await page.request.put(
      `${site.origin}/api/tables/${table.id}`,
      {
        headers: { Origin: site.origin },
        data: {
          expectedVersion: data.version,
          rows: [{ id: "row-original", values: ["원본", "4"] }],
        },
      },
    );
    expect(written.ok()).toBeTruthy();
    await block.getByRole("button", { name: "행 저장", exact: true }).click();
    await expect(
      block.getByRole("heading", { name: "내 수정과 최신 데이터 비교" }),
    ).toBeVisible();
    const comparison = block.getByRole("region", { name: "충돌 비교" });
    await expect(
      comparison.getByRole("cell", { name: "5", exact: true }),
    ).toBeVisible();
    await expect(
      comparison.getByRole("cell", { name: "4", exact: true }),
    ).toBeVisible();
    await block
      .getByRole("button", { name: "최신 데이터 유지", exact: true })
      .click();
    await block.getByRole("button", { name: "변경 이력", exact: true }).click();
    const history = block.getByRole("region", { name: "표 변경 이력" });
    await expect(
      history.getByRole("heading", { name: "표 변경 이력" }),
    ).toBeVisible();
    await history.locator("summary").first().click();
    await expect(
      history.getByRole("cell", { name: "3", exact: true }),
    ).toBeVisible();
    await expect(
      history.getByRole("cell", { name: "4", exact: true }),
    ).toBeVisible();
  });
});
