/**
 * A streaming zip writer (PKWARE APPNOTE 6.3), enough for a folder artifact's download: each
 * file deflated as it streams, its CRC-32 and sizes in a data descriptor after it (general
 * purpose bit 3) and again in the central directory, names in UTF-8 (bit 11). Nothing is
 * buffered beyond one chunk. No ZIP64: a folder this serves stays under 4 GiB and 65,535 files
 * (the export's limits), and `zipTooLarge` says when one would not.
 */
import { constants, crc32, createDeflateRaw } from "node:zlib";

export interface ZipEntry {
  /** The path in the archive, `/`-separated. */
  readonly name: string;
  /** The file's bytes, opened only when the writer reaches it. */
  readonly open: () => Promise<AsyncIterable<Uint8Array>>;
}

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const FLAGS = 0x0808; // bit 3: sizes in a data descriptor; bit 11: UTF-8 names
const DEFLATE = 8;
const VERSION = 20;
/** Made by Unix (3), so the external attributes below are a Unix mode. */
const MADE_BY_UNIX = (3 << 8) | VERSION;
/** A regular file, `rw-r--r--`, in the high 16 bits. */
const REGULAR_FILE = (0o100644 << 16) >>> 0;
const MAX_32 = 0xffffffff;

/** Why a folder cannot be zipped without ZIP64, or undefined when it can. */
export function zipTooLarge(files: number, bytes: number): string | undefined {
  if (files > 0xffff) return `A zip holds at most 65535 files; this folder has ${files}`;
  // Deflate adds at most 5 bytes per 16 KiB block; keep well clear of 4 GiB.
  if (bytes > 3.5 * 1024 * 1024 * 1024) return `A zip holds at most 3.5 GiB; this folder has ${bytes} bytes`;
  return undefined;
}

/** MS-DOS date and time, as zip headers store them (local time is not known: UTC). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** The archive's bytes, as the writer produces them. */
export async function* zipStream(
  entries: readonly ZipEntry[],
  modified: Date = new Date(),
): AsyncGenerator<Uint8Array> {
  const stamp = dosDateTime(modified);
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    // CRC and sizes (14–25) are zero: they follow in the data descriptor.
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const headerAt = offset;
    yield local;
    yield name;
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw({ level: constants.Z_DEFAULT_COMPRESSION });
    const source = await entry.open();
    const feed = (async () => {
      try {
        for await (const chunk of source) {
          // The reader went away (a cancelled download): stop reading the file.
          if (deflate.destroyed) break;
          crc = crc32(chunk, crc);
          size += chunk.length;
          if (!deflate.write(chunk))
            await new Promise((resolve) => {
              deflate.once("drain", resolve);
              deflate.once("close", resolve);
            });
        }
        if (!deflate.destroyed) deflate.end();
      } catch (error) {
        deflate.destroy(error as Error);
      }
    })();
    for await (const chunk of deflate as AsyncIterable<Buffer>) {
      compressed += chunk.length;
      yield chunk;
    }
    await feed;
    offset += compressed;
    if (offset > MAX_32 || size > MAX_32) throw new Error("The folder is too large to zip without ZIP64");

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += descriptor.length;

    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL, 0);
    record.writeUInt16LE(MADE_BY_UNIX, 4);
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(FLAGS, 8);
    record.writeUInt16LE(DEFLATE, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(crc >>> 0, 16);
    record.writeUInt32LE(compressed, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    // Extra, comment, disk and internal attributes (30–37) stay zero.
    record.writeUInt32LE(REGULAR_FILE, 38);
    record.writeUInt32LE(headerAt, 42);
    central.push(record, name);
  }
  const directory = Buffer.concat(central);
  yield directory;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
