import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceArchive } from "../server/archive";
test("source ZIP has valid central records and excludes private databases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automade-zip-"));
  await writeFile(path.join(dir, "source.txt"), "known-source");
  await writeFile(path.join(dir, ".site-data.sqlite"), "PERSONAL_DATA");
  const server = createServer((_req, res) => {
    void sourceArchive(dir, "fixture", res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const bytes = Buffer.from(
      await (await fetch("http://127.0.0.1:" + address.port)).arrayBuffer(),
    );
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
    assert.equal(bytes.readUInt16LE(bytes.length - 14), 1);
    assert.ok(bytes.includes(Buffer.from("known-source")));
    assert.ok(!bytes.includes(Buffer.from("PERSONAL_DATA")));
    const central = bytes.readUInt32LE(bytes.length - 6);
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    assert.equal(bytes.readUInt32LE(central + 16), 0x11da76b3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
