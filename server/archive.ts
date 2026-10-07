import type { ServerResponse } from "node:http";
import { readdir, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { contained, HttpError } from "./http";
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export async function sourceArchive(
  root: string,
  id: string,
  res: ServerResponse,
): Promise<void> {
  const base = await realpath(root);
  const files: Array<{ file: string; name: Buffer; size: number }> = [];
  let total = 0;
  async function collect(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.isSymbolicLink()
      )
        continue;
      const file = path.join(folder, entry.name);
      if (!contained(base, await realpath(file)))
        throw new HttpError(403, "PATH", "Archive path rejected");
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) {
        const size = (await stat(file)).size;
        total += size;
        files.push({
          file,
          name: Buffer.from(
            path.relative(base, file).replaceAll("\\", "/"),
            "utf8",
          ),
          size,
        });
      }
    }
  }
  await collect(base);
  if (total > 256_000_000 || files.length > 500)
    throw new HttpError(413, "ARCHIVE_LIMIT", "Source archive exceeds limit");
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="automade-' + id + '.zip"',
    "Cache-Control": "no-store",
  });
  let offset = 0;
  const records: Buffer[] = [];
  async function send(chunk: Buffer) {
    offset += chunk.length;
    if (res.destroyed) throw new Error("Download closed");
    if (!res.write(chunk))
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          res.off("drain", drain);
          res.off("close", closed);
          res.off("error", failed);
        };
        const drain = () => {
          cleanup();
          resolve();
        };
        const closed = () => {
          cleanup();
          reject(new Error("Download closed"));
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        res.once("drain", drain);
        res.once("close", closed);
        res.once("error", failed);
      });
  }
  for (const f of files) {
    const begin = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(33, 12);
    local.writeUInt16LE(f.name.length, 26);
    await send(local);
    await send(f.name);
    let crc = 0xffffffff;
    let actual = 0;
    for await (const chunk of createReadStream(f.file)) {
      const data = chunk as Buffer;
      actual += data.length;
      for (const value of data)
        crc = crcTable[(crc ^ value) & 255]! ^ (crc >>> 8);
      await send(data);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(actual, 8);
    descriptor.writeUInt32LE(actual, 12);
    await send(descriptor);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x808, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(actual, 20);
    central.writeUInt32LE(actual, 24);
    central.writeUInt16LE(f.name.length, 28);
    central.writeUInt32LE(begin, 42);
    records.push(central, f.name);
  }
  const directoryOffset = offset;
  for (const r of records) await send(r);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset - directoryOffset, 12);
  end.writeUInt32LE(directoryOffset, 16);
  await send(end);
  res.end();
}
