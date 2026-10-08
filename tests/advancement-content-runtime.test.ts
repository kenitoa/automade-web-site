import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProject } from "../src/domain/catalog";
import { startSite } from "../server/siteServer";
import type { ContentRecord } from "../src/domain/types";
test("visitor SQL CMS pages, localized metadata and environment binding keep artifact bytes intact", async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), "automade-content-runtime-"),
    ),
    project = createProject("service");
  project.settings.siteUrl = "https://review.example";
  project.settings.languages = ["ko", "en"];
  project.collections = [
    {
      id: "news",
      name: "News",
      path: "/news",
      queryMode: "server",
      schema: [{ id: "secret", label: "private", type: "text", public: false }],
      records: Array.from({ length: 35 }, (_, i): ContentRecord => ({
        id: `r${i}`,
        slug: `story-${i}`,
        localizedSlugs: { en: `english-${i}` },
        title: `Public ${i}`,
        body: `Published body ${i}`,
        category: "",
        imageId: "",
        fields: {},
        values: { secret: `private ${i}` },
        status: "published",
        publishedAt: "2026-01-01T00:00:00Z",
        translations: {
          en: { title: `English ${i}`, body: `English body ${i}` },
        },
      })),
    },
    {
      id: "private",
      name: "Private",
      path: "/private",
      access: "members",
      records: [
        {
          id: "member",
          slug: "secret",
          title: "Secret title",
          body: "Secret body",
          category: "",
          imageId: "",
          fields: {},
          status: "published",
          publishedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  ];
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await writeFile(
    path.join(directory, "dist", "index.html"),
    "original artifact bytes",
  );
  const site = await startSite(directory, project, 0, {
    environmentBinding: { publicOrigin: "https://live.example" },
  });
  try {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const response: Response = await fetch(
        `${site.origin}/api/content/news?limit=8${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      assert.equal(response.status, 200);
      const page = (await response.json()).data;
      ids.push(...page.records.map((r: ContentRecord) => r.id));
      cursor = page.nextCursor;
      assert.ok(
        page.records.every(
          (r: ContentRecord) => r.values?.secret === undefined,
        ),
      );
    } while (cursor);
    assert.equal(new Set(ids).size, 35);
    const detail = await (
      await fetch(`${site.origin}/en/news/english-34`)
    ).text();
    assert.match(detail, /English 34/);
    assert.match(detail, /https:\/\/live.example\/en\/news\/english-34/);
    assert.doesNotMatch(detail, /private 34/);
    const base = await (await fetch(`${site.origin}/`)).text();
    assert.match(base, /https:\/\/live.example\//);
    const sitemap = await (await fetch(`${site.origin}/sitemap.xml`)).text();
    assert.match(sitemap, /english-34/);
    assert.doesNotMatch(sitemap, /private\/secret/);
    assert.equal(
      await readFile(path.join(directory, "dist", "index.html"), "utf8"),
      "original artifact bytes",
    );
    const protectedPage = await (
      await fetch(`${site.origin}/private/secret`)
    ).text();
    assert.doesNotMatch(protectedPage, /Secret body|Secret title/);
  } finally {
    await site.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep),"Invalid temporary path");
    await rm(directory, { recursive: true, force: true });
  }
});
