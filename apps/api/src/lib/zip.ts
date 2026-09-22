import { inflateSync } from 'fflate'

export interface ZipEntry {
  name: string
  data: Buffer
}

export class BadZipError extends Error {}

// Minimal central-directory reader. fflate — like most JS unzip libs — decodes
// entry names as UTF-8 unconditionally, but zips written by Windows tools carry
// GBK/CP936 name bytes without the EFS flag, so Chinese chapter filenames
// arrive as mojibake and the chapter titles inherit it. Reading the directory
// ourselves yields the RAW name bytes plus the flag, and names then decode with
// the same policy as file content: strict UTF-8 first, GB18030 as the fallback
// for legacy Chinese encodings.
//
// Zip64 (>4 GB archives) and multi-disk archives are refused rather than
// mis-parsed; callers cap sizes far below that anyway.
export function unzipEntries(archive: Buffer): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const u16 = (o: number) => view.getUint16(o, true)
  const u32 = (o: number) => view.getUint32(o, true)

  const eocd = findEocd(archive, view)
  if (eocd < 0) throw new BadZipError('no end-of-central-directory record')
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0) throw new BadZipError('multi-disk archives are not supported')
  const count = u16(eocd + 10)
  const dirOffset = u32(eocd + 16)
  if (count === 0xffff || dirOffset === 0xffffffff) throw new BadZipError('zip64 archives are not supported')

  const entries: ZipEntry[] = []
  let cursor = dirOffset
  for (let i = 0; i < count; i += 1) {
    if (u32(cursor) !== 0x02014b50) throw new BadZipError('broken central directory entry')
    const flags = u16(cursor + 8)
    const method = u16(cursor + 10)
    const compressedSize = u32(cursor + 20)
    const nameLen = u16(cursor + 28)
    const extraLen = u16(cursor + 30)
    const commentLen = u16(cursor + 32)
    const localOffset = u32(cursor + 42)
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new BadZipError('zip64 archives are not supported')

    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLen)
    const name = decodeName(nameBytes, (flags & 0x800) !== 0)

    // The local header's own name/extra lengths locate the data; sizes always
    // come from the directory (streamed entries may carry zeros locally).
    if (u32(localOffset) !== 0x04034b50) throw new BadZipError('broken local header')
    const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28)
    const raw = archive.subarray(dataStart, dataStart + compressedSize)
    let data: Buffer
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      try {
        data = Buffer.from(inflateSync(new Uint8Array(raw)))
      } catch {
        throw new BadZipError(`entry "${name}" fails to inflate`)
      }
    } else {
      throw new BadZipError(`entry "${name}" uses unsupported compression method ${method}`)
    }
    entries.push({ name, data })
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function findEocd(archive: Buffer, view: DataView): number {
  const earliest = Math.max(0, archive.length - 22 - 0xffff)
  for (let i = archive.length - 22; i >= earliest; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i
  }
  return -1
}

function decodeName(bytes: Buffer, efs: boolean): string {
  if (efs) return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // No EFS flag and not valid UTF-8 — the Windows-tool case. GB18030 covers
    // GBK/GB2312; if even that cannot decode (truly foreign bytes), fall back
    // to replacement-character UTF-8 rather than dropping the chapter.
    const gb = new TextDecoder('gb18030').decode(bytes)
    return gb.includes('\uFFFD') ? new TextDecoder('utf-8').decode(bytes) : gb
  }
}
