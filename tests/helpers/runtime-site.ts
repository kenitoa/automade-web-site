import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseProject } from "../../src/domain/validation";
import { generate } from "../../server/generator";
import { startSite } from "../../server/siteServer";
import { createAccount } from "../../server/platform/auth";
import {
  saveResource,
  saveSlot,
  createBooking,
  cancelBooking,
} from "../../server/platform/business";
import { BookingExpansion } from "../../server/expansion/bookings";

// A separate Node process keeps Playwright's component JSX transform out of the SSR renderer.
const project = parseProject(
  JSON.parse(await readFile(process.argv[2]!, "utf8")) as unknown,
);
const root = await mkdtemp(path.join(os.tmpdir(), "automade-runtime-e2e-"));
const result = await generate(project, {
  root,
  sourceRoot: process.cwd(),
  id: randomUUID(),
});
const standalone = process.argv[3] === "expansion";
if (standalone) {
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: result.source,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let diagnostic = "";
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostic += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(diagnostic || `Standalone build exited ${code}`)),
      );
    });
  const npmCli =
    process.env.npm_execpath ??
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    );
  await run([npmCli, "ci", "--ignore-scripts", "--offline"]);
  await run(["build.mjs"]);
}
const runtime = standalone
  ? ((await import(
      pathToFileURL(path.join(result.source, "site-server.mjs")).href
    )) as { startSite: typeof startSite })
  : { startSite };
const site = await runtime.startSite(result.source, project);
const waitlistSlots: Record<string, string> = {},
  heldBookings: Record<string, string> = {};
if (standalone) {
  const holder = await createAccount(site.store.db, {
    email: "slot-holder@example.org",
    password: "fixture-password-2026",
    displayName: "Existing reservation",
  });
  for (const [index, [key, name]] of Object.entries({
    accept: "제안 수락 일정",
    cancel: "대기 취소 일정",
    expire: "제안 만료 일정",
  }).entries()) {
    const resourceId = `waitlist-${key}`;
    saveResource(site.store.db, project.id, {
      id: resourceId,
      name,
      capacity: 1,
      active: true,
    });
    const startsAt = Date.now() + (index + 3) * 3_600_000;
    const slot = saveSlot(site.store.db, project.id, {
      resourceId,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(startsAt + 1_800_000).toISOString(),
      capacity: 1,
    });
    waitlistSlots[key] = String(slot.id);
    heldBookings[key] = String(
      createBooking(site.store.db, project.id, String(holder.id), {
        slotId: slot.id,
        quantity: 1,
        idempotencyKey: `hold-${key}`,
      }).id,
    );
  }
  site.store.db
    .prepare(
      "INSERT INTO platform_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)",
    )
    .run(
      "test-data",
      project.id,
      "Fixture data",
      "data",
      "https://example.org/data",
      "example.org",
      "",
      "",
      JSON.stringify({ title: "name", body: "description", value: "amount" }),
      0,
      "reachable",
    );
  site.store.db.prepare("INSERT INTO platform_data_cache VALUES(?,?,?,?)").run(
    "test-data",
    JSON.stringify(
      Array.from({ length: 5 }, (_, index) => ({
        title: `Connected ${index}`,
        body: `Body ${index}`,
        value: index + 1,
        private: "PRIVATE_PROVIDER_FIELD",
      })),
    ),
    Date.now() + 3600000,
    new Date().toISOString(),
  );
}
process.send?.({ origin: site.origin, source: result.source });
let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await site.close();
  process.exit(0);
};
process.on("message", (message: unknown) => {
  if (
    standalone &&
    message &&
    typeof message === "object" &&
    "operation" in message
  ) {
    const input = message as { operation: string; requestId?: string };
    if (input.operation === "empty")
      site.store.db
        .prepare(
          "UPDATE platform_data_cache SET body='[]' WHERE connection_id='test-data'",
        )
        .run();
    else if (input.operation === "failure") {
      site.store.db
        .prepare(
          "DELETE FROM platform_data_cache WHERE connection_id='test-data'",
        )
        .run();
      site.store.db
        .prepare(
          "UPDATE platform_connections SET paused=1 WHERE id='test-data'",
        )
        .run();
    } else if (input.operation === "unpublish") {
      const collections = structuredClone(project.collections!);
      const item = collections
        .find((collection) => collection.id === "large")!
        .records.find((item) => item.id === "article-34")!;
      item.status = "draft";
      item.workflow = { state: "draft" };
      item.contentRevision = (item.contentRevision ?? 0) + 1;
      site.store.operations.setState("project:cms", {
        revision: 1,
        collections,
      });
    } else if (input.operation === "offer") {
      cancelBooking(site.store.db, heldBookings.accept!);
      cancelBooking(site.store.db, heldBookings.expire!);
      new BookingExpansion(site.store.db).offer(project.id);
    } else if (input.operation === "expire") {
      site.store.db
        .prepare(
          "UPDATE expansion_booking_waitlist SET offer_expires_at=? WHERE slot_id=? AND status='offered'",
        )
        .run(Date.now() - 1, waitlistSlots.expire!);
    } else {
      void close();
      return;
    }
    process.send?.({ requestId: input.requestId, ok: true });
  } else void close();
});
process.once("SIGTERM", () => void close());
process.once("disconnect", () => void close());
