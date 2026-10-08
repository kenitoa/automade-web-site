import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createProject, createBlock } from "../src/domain/catalog";
import {
  packageIntegrity,
  parseDeclarativePackage,
  createPackageBlock,
} from "../src/domain/packages";
import { parseProject, record } from "../src/domain/validation";
import { randomUUID } from "node:crypto";

test.describe("registered expansion standalone runtime", () => {
  test.use({ actionTimeout: 15000 });
  let helper: ChildProcess, origin: string, source: string;
  const project = createProject("Expansion verification"),
    home = project.pages[0]!;
  project.settings.description = "Real standalone expansion test";
  project.settings.languages = ["ko", "fr-CA"];
  project.settings.languageFallbacks = { "fr-CA": "fr" };
  project.settings.siteUrl = "https://example.org";
  const timeline = createBlock("automade:timeline", project, home.id),
    cards = createBlock("cards", project, home.id),
    data = createBlock("cards", project, home.id),
    dataTabs = createBlock("tabs", project, home.id);
  timeline.props.title = "Delivery steps";
  timeline.props.items[0]!.title = "Design";
  timeline.props.items[1]!.title = "Delivery";
  cards.props.title = "Paged CMS";
  cards.props.collectionBinding = {
    collectionId: "large",
    category: "",
    limit: 20,
    detailLinks: true,
  };
  data.props.title = "Connected data";
  data.props.dataBinding = {
    connectionId: "test-data",
    limit: 2,
    mapping: { title: "title", body: "body" },
  };
  dataTabs.props.title = "Connected tabs";
  dataTabs.props.dataBinding = structuredClone(data.props.dataBinding);
  project.blocks.push(timeline, cards, data, dataTabs);
  project.collections = [
    {
      id: "large",
      name: "Large",
      path: "/articles",
      queryMode: "server",
      schema: [
        { id: "price", label: "Price", type: "number", public: true },
        { id: "internal", label: "Internal", type: "text", public: false },
      ],
      records: Array.from({ length: 35 }, (_, index) => ({
        id: `article-${index}`,
        slug: `article-${index}`,
        title: `Article ${String(index).padStart(3, "0")}`,
        body: `Article body ${index}`,
        category: "",
        imageId: "",
        status: "published",
        publishedAt: new Date().toISOString(),
        fields: {},
        values: { price: index, internal: "PRIVATE_TYPED_FIELD" },
        translations: {
          fr: {
            title: `Article français ${String(index).padStart(3, "0")}`,
            body: `Corps ${index}`,
          },
        },
      })),
    },
  ];
  project.collections[0]!.records.push({
    ...project.collections[0]!.records[0]!,
    id: "draft-secret",
    slug: "draft-secret",
    status: "draft",
    publishedAt: "",
  });
  project.collections.push({
    id: "members",
    name: "Members",
    path: "/private-articles",
    access: "members",
    schema: structuredClone(project.collections[0]!.schema),
    records: [
      {
        ...project.collections[0]!.records[0]!,
        id: "private-record",
        slug: "private-secret",
      },
    ],
  });
  project.pages.push(
    {
      id: "hidden-search",
      title: "Excluded",
      path: "/excluded",
      description: "",
      published: true,
      home: false,
      seo: { title: "", description: "", imageAssetId: "", noIndex: true },
    },
    {
      id: "member-page",
      title: "Members",
      path: "/members",
      description: "",
      published: true,
      home: false,
      access: "members",
    },
  );
  const change = (operation: string) =>
    new Promise<void>((resolve) => {
      const requestId = crypto.randomUUID();
      const listener = (value: unknown) => {
        if (record(value).requestId === requestId) {
          helper.off("message", listener);
          resolve();
        }
      };
      helper.on("message", listener);
      helper.send({ operation, requestId });
    });
  test.beforeAll(async () => {
    const raw = {
        id: "browser.pack",
        name: "Browser pack",
        version: "1.0.0",
        protocol: 1,
        definitions: [
          {
            id: "intro",
            name: "Package intro",
            description: "Safe",
            template: "text",
            defaults: {
              title: "Declarative block",
              body: "Standalone package content",
            },
          },
        ],
      },
      pack = parseDeclarativePackage({
        ...raw,
        integrity: await packageIntegrity(raw),
      });
    project.blockPackages = [pack];
    project.featurePins = [
      { packageId: pack.id, version: pack.version, integrity: pack.integrity },
    ];
    project.blocks.push(createPackageBlock(project, pack.id, "intro", home.id));
    const folder = await mkdtemp(
        path.join(os.tmpdir(), "automade-expansion-e2e-"),
      ),
      file = path.join(folder, "project.json");
    await writeFile(file, JSON.stringify(parseProject(project)));
    helper = fork(
      path.resolve("tests/helpers/runtime-site.ts"),
      [file, "expansion"],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, SITE_HOST: "127.0.0.1", SITE_PUBLIC_ORIGIN: "" },
      },
    );
    const site = await new Promise<{ origin: string; source: string }>(
      (resolve, reject) => {
        let diagnostic = "";
        helper.stderr?.on("data", (value: Buffer) => {
          diagnostic += value.toString();
        });
        helper.once("message", (value: unknown) => {
          const data = record(value);
          if (
            typeof data.origin === "string" &&
            typeof data.source === "string"
          )
            resolve({ origin: data.origin, source: data.source });
          else reject(new Error("Missing standalone address"));
        });
        helper.once("error", reject);
        helper.once("exit", (code) =>
          reject(new Error(diagnostic || `Standalone exited ${code}`)),
        );
      },
    );
    origin = site.origin;
    source = site.source;
  });
  test.afterAll(async () => {
    if (helper?.connected) {
      helper.send({ operation: "stop" });
      await new Promise<void>((resolve) =>
        helper.once("exit", () => resolve()),
      );
    }
  });
  test("approved registered and declarative blocks run from copied server with pinned contract", async ({
    page,
  }) => {
    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "Delivery steps" }),
    ).toBeVisible();
    await expect(page.locator(".site-timeline li")).toHaveCount(2);
    await expect(
      page.getByRole("heading", { name: "Declarative block" }),
    ).toBeVisible();
    const contract = record(
      JSON.parse(
        await readFile(path.join(source, "artifact.contract.json"), "utf8"),
      ),
    );
    expect(contract.generatorVersion).toBe("2.1.0");
    expect(JSON.stringify(contract.packages)).toContain("automade.timeline");
    expect(JSON.stringify(contract.packages)).toContain("browser.pack");
    const output = await page.request.get(origin);
    expect(await output.text()).not.toContain("PRIVATE_TYPED_FIELD");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".site-timeline")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  });
  test("server CMS paginates and directly renders detail beyond SSR snapshot in arbitrary locale", async ({
    page,
  }) => {
    await page.goto(origin);
    const block = page.locator(`#block-${cards.id}`);
    await expect(
      block.getByRole("heading", { name: "Article 000", exact: true }),
    ).toBeVisible();
    await block.getByRole("button", { name: "다음 항목", exact: true }).click();
    await expect(
      block.getByRole("heading", { name: "Article 034", exact: true }),
    ).toBeVisible();
    await block
      .getByRole("heading", { name: "Article 034", exact: true })
      .locator("..")
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(`${origin}/articles/article-34`);
    await expect(
      page.getByRole("heading", { name: "Article 034", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Article 034", exact: true }),
    ).toBeVisible();
    await page.goto(`${origin}/fr-CA/articles/article-34`);
    await expect(
      page.getByRole("heading", { name: "Article français 034", exact: true }),
    ).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://example.org/fr-CA/articles/article-34",
    );
    const result = await page.request.get(
      `${origin}/api/content/large?slug=article-34&language=fr-CA`,
    );
    const json = JSON.stringify(await result.json());
    expect(json).toContain("Article français 034");
    expect(json).not.toContain("PRIVATE_TYPED_FIELD");
  });
  test("data binding performs real API pagination, empty and failure states without private provider fields", async ({
    page,
  }) => {
    await page.goto(origin);
    const block = page.locator(`#block-${data.id}`);
    await expect(
      block.getByRole("heading", { name: "Connected 0", exact: true }),
    ).toBeVisible();
    const tabs = page.locator(`#block-${dataTabs.id}`);
    await expect(
      tabs.getByRole("tab", { name: "Connected 1", exact: true }),
    ).toBeVisible();
    await tabs.getByRole("tab", { name: "Connected 1", exact: true }).click();
    await expect(tabs.getByRole("tabpanel")).toContainText("Body 1");
    await block.getByRole("button", { name: "다음 항목", exact: true }).click();
    await expect(
      block.getByRole("heading", { name: "Connected 2", exact: true }),
    ).toBeVisible();
    const api = await page.request.get(
      `${origin}/api/platform/data/test-data/binding?projectId=${project.id}&limit=2`,
    );
    expect(JSON.stringify(await api.json())).not.toContain(
      "PRIVATE_PROVIDER_FIELD",
    );
    await change("empty");
    await page.reload();
    await expect(
      block.getByText("표시할 데이터가 없습니다.", { exact: true }),
    ).toBeVisible();
    await change("failure");
    await page.reload();
    await expect(block.getByRole("alert")).toBeVisible();
    await expect(
      block.getByRole("button", { name: "다시 조회", exact: true }),
    ).toBeVisible();
  });
  test("dynamic and independently rebuilt sitemaps include every public CMS URL and follow canonical publishing changes", async ({
    request,
  }) => {
    const response = await request.get(`${origin}/sitemap.xml`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/xml");
    expect(response.headers()["cache-control"]).toBe("no-store");
    const output = await response.text();
    expect(output).toContain(
      "<loc>https://example.org/articles/article-34</loc>",
    );
    expect(output).toContain(
      "<loc>https://example.org/fr-CA/articles/article-34</loc>",
    );
    expect((output.match(/<url>/g) ?? []).length).toBe(72);
    for (const excluded of [
      "draft-secret",
      "private-secret",
      "/members",
      "/excluded",
      "PRIVATE_TYPED_FIELD",
    ])
      expect(output).not.toContain(excluded);
    const rebuilt = await readFile(
      path.join(source, "dist/sitemap.xml"),
      "utf8",
    );
    expect(rebuilt).toContain(
      "<loc>https://example.org/articles/article-34</loc>",
    );
    expect(rebuilt).not.toContain("private-secret");
    expect((await request.head(`${origin}/sitemap.xml`)).status()).toBe(200);
    expect(await (await request.head(`${origin}/sitemap.xml`)).text()).toBe("");
    expect((await request.get(`${origin}/sitemaps/0.xml`)).status()).toBe(404);
    expect((await request.get(`${origin}/sitemaps/999.xml`)).status()).toBe(
      404,
    );
    expect(await (await request.get(`${origin}/robots.txt`)).text()).toContain(
      "Sitemap: https://example.org/sitemap.xml",
    );
    await change("unpublish");
    const fresh = await (await request.get(`${origin}/sitemap.xml`)).text();
    expect(fresh).not.toContain("/articles/article-34</loc>");
    expect(fresh).toContain("/articles/article-33</loc>");
    expect((fresh.match(/<url>/g) ?? []).length).toBe(70);
  });
  test("visitors join sold-out waitlists, cancel and accept real offers while expired holds cannot be accepted", async ({
    page,
  }) => {
    await page.goto(origin);
    const platform = page.locator(".site-platform");
    await platform.locator("details").first().locator("summary").click();
    await platform
      .getByRole("button", { name: "회원가입", exact: true })
      .click();
    await platform
      .getByLabel("이메일", { exact: true })
      .fill(`waitlist-${randomUUID()}@example.org`);
    await platform.getByLabel("표시 이름", { exact: true }).fill("대기 방문자");
    await platform
      .getByLabel("비밀번호", { exact: true })
      .fill("visitor-password-2026");
    await platform.getByRole("button", { name: "가입", exact: true }).click();
    await expect(
      platform.getByText("가입했습니다.", { exact: true }),
    ).toBeVisible();
    await platform.getByText("예약과 내 일정", { exact: true }).click();
    const own = platform.getByRole("region", {
      name: "내 예약 대기",
      exact: true,
    });
    await expect(
      own.getByText("신청한 예약 대기가 없습니다.", { exact: true }),
    ).toBeVisible();
    for (const name of ["제안 수락 일정", "대기 취소 일정", "제안 만료 일정"]) {
      const slot = platform
        .locator("article")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect(
        slot.getByText("예약 가능: 0", { exact: true }),
      ).toBeVisible();
      await slot
        .getByRole("button", { name: "대기 신청", exact: true })
        .click();
      await expect(
        own.getByRole("heading", { name: `${name} · 1명`, exact: true }),
      ).toBeVisible();
    }
    const row = (name: string) =>
      own.locator("article").filter({
        has: page.getByRole("heading", {
          name: `${name} · 1명`,
          exact: true,
        }),
      });
    await row("대기 취소 일정")
      .getByRole("button", { name: "대기 취소", exact: true })
      .click();
    await expect(
      row("대기 취소 일정").getByText("대기 취소됨", { exact: true }),
    ).toBeVisible();
    await change("offer");
    await own
      .getByRole("button", { name: "대기 현황 새로고침", exact: true })
      .click();
    await expect(
      row("제안 수락 일정").getByText("예약 제안 도착", { exact: true }),
    ).toBeVisible();
    await expect(row("제안 수락 일정").locator("time")).toBeVisible();
    await row("제안 수락 일정")
      .getByRole("button", { name: "예약 제안 수락", exact: true })
      .click();
    await expect(
      row("제안 수락 일정").getByText("예약 확정", { exact: true }),
    ).toBeVisible();
    const accepted = record(
      await (
        await page.request.get(`${origin}/api/platform/bookings/waitlist`)
      ).json(),
    );
    const entries = accepted.data as {
      id: string;
      status: string;
      bookingId: string | null;
    }[];
    const confirmed = entries.find((entry) => entry.status === "accepted")!;
    expect(confirmed.bookingId).toBeTruthy();
    const bookings = JSON.stringify(
      await (
        await page.request.get(
          `${origin}/api/platform/bookings?projectId=${project.id}`,
        )
      ).json(),
    );
    expect(bookings).toContain(confirmed.bookingId!);
    expect(bookings).toContain("confirmed");
    await change("expire");
    await own
      .getByRole("button", { name: "대기 현황 새로고침", exact: true })
      .click();
    await expect(
      row("제안 만료 일정").getByText("예약 제안 만료", { exact: true }),
    ).toBeVisible();
    await expect(
      row("제안 만료 일정").getByRole("button", {
        name: "예약 제안 수락",
        exact: true,
      }),
    ).toHaveCount(0);
    const current = record(
      await (await page.request.get(`${origin}/api/platform/session`)).json(),
    );
    const expiry = entries.find((entry) => entry.status === "offered")!;
    const denied = await page.request.post(
      `${origin}/api/platform/bookings/waitlist/${expiry.id}/accept`,
      {
        headers: {
          Origin: origin,
          "X-Platform-CSRF": String(record(current.data).csrf),
        },
        data: {},
      },
    );
    expect(denied.status()).toBe(409);
    expect(JSON.stringify(await denied.json())).toContain("WAITLIST_EXPIRED");
    await platform
      .getByRole("button", { name: "로그아웃", exact: true })
      .click();
    await expect(own).toHaveCount(0);
    expect(
      (
        await page.request.get(`${origin}/api/platform/bookings/waitlist`)
      ).status(),
    ).toBe(401);
  });
});
