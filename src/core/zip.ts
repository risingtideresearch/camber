// ---------- ZIP: a tiny STORE-method archive writer ----------
//
// A dependency-free ZIP builder (no compression — entries are stored verbatim), enough to bundle a handful
// of text files into a single download. Kept minimal on purpose: the app avoids third-party bundles, and a
// stored-entry archive is a few headers plus a CRC-32 per file. Filenames are written UTF-8 (general-purpose
// bit 11). No ZIP64, so this assumes < 65535 entries and each file (and the whole archive) under 4 GiB —
// comfortably true for a library of JSON documents.

export interface ZipEntry {
  name: string; // path inside the archive
  data: Uint8Array; // file contents (stored uncompressed)
}

let crcTable: Uint32Array | null = null;
function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = (crcTable ??= makeCrcTable());
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// pack a Date into the DOS date/time fields ZIP uses (2-second resolution, years from 1980)
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date =
    ((Math.max(d.getFullYear(), 1980) - 1980) << 9) |
    ((d.getMonth() + 1) << 5) |
    d.getDate();
  return { time, date };
}

// assemble the given entries into a ZIP archive Blob
export function buildZip(entries: ZipEntry[], modified = new Date()): Blob {
  const { time, date } = dosDateTime(modified);
  const encoder = new TextEncoder();

  const localParts: BlobPart[] = []; // local headers + file data, in order
  const centralParts: BlobPart[] = []; // central-directory records
  let offset = 0; // running offset of the next local header
  let centralSize = 0; // total bytes of the central directory

  for (const entry of entries) {
    // TextEncoder / caller-supplied arrays are non-shared buffers, so they're valid BlobParts
    const nameBytes = encoder.encode(entry.name) as Uint8Array<ArrayBuffer>;
    const data = entry.data as Uint8Array<ArrayBuffer>;
    const crc = crc32(data);
    const size = data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed to extract (2.0)
    local.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    local.setUint16(8, 0, true); // compression method: store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size (== uncompressed for store)
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length
    localParts.push(local.buffer, nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central file header signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed to extract
    central.setUint16(8, 0x0800, true); // flags: UTF-8 filename
    central.setUint16(10, 0, true); // compression method: store
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true); // compressed size
    central.setUint32(24, size, true); // uncompressed size
    central.setUint16(28, nameBytes.length, true);
    // extra/comment lengths, disk number, attributes all 0
    central.setUint32(42, offset, true); // relative offset of local header
    centralParts.push(central.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
    centralSize += 46 + nameBytes.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(8, entries.length, true); // records on this disk
  end.setUint16(10, entries.length, true); // total records
  end.setUint32(12, centralSize, true); // size of central directory
  end.setUint32(16, offset, true); // offset of central directory
  // disk numbers and comment length all 0

  return new Blob([...localParts, ...centralParts, end.buffer], {
    type: "application/zip",
  });
}
