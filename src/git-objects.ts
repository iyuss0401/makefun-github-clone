// The git object model: hashing, trees, commits, tags, packfiles. Everything is SHA-1, zlib
// (node:zlib) and plain Buffer arithmetic — no git binary, no dependencies.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const ZERO_OID = '0'.repeat(40);

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = `${type} ${data.length}\0`;
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = Buffer.from(data.subarray(offset, space)).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = Buffer.from(data.subarray(space + 1, nul)).toString('utf8');
    offset = nul + 1 + 20;
    const oid = Buffer.from(data.subarray(nul + 1, offset)).toString('hex');
    entries.push({ mode, name, oid });
  }
  return entries;
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function personLine(data: Buffer, key: string): string {
  const text = data.toString('utf8');
  const at = text.indexOf(`\n${key} `);
  if (at < 0) return '';
  const end = text.indexOf('\n', at + 1);
  return text.slice(at + 1 + key.length + 1, end < 0 ? undefined : end).trim();
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = data.toString('utf8');
  const treeAt = text.indexOf('tree ');
  const tree = text.slice(treeAt + 5, text.indexOf('\n', treeAt));
  const parents: string[] = [];
  let index = 0;
  for (;;) {
    const at = text.indexOf('\nparent ', index);
    if (at < 0) break;
    parents.push(text.slice(at + 8, text.indexOf('\n', at + 1)));
    index = at + 1;
  }
  const messageAt = text.indexOf('\n\n');
  return {
    tree,
    parents,
    author: personLine(data, 'author'),
    committer: personLine(data, 'committer'),
    message: text.slice(messageAt + 2),
  };
}

export interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

function person(identity: string, timestamp: number): string {
  return `${identity} ${timestamp} +0000`;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${person(fields.author, fields.timestamp)}`);
  lines.push(`committer ${person(fields.committer, fields.timestamp)}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function buildTag(fields: { object: string; type: string; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${person(fields.tagger, fields.timestamp)}\n\n${fields.message}`,
    'utf8',
  );
}

export function parseTag(data: Uint8Array): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const header = (key: string): string => {
    const at = text.indexOf(`${key} `);
    return text.slice(at + key.length + 1, text.indexOf('\n', at)).trim();
  };
  const messageAt = text.indexOf('\n\n');
  return {
    object: header('object'),
    type: header('type'),
    tag: header('tag'),
    tagger: personLine(data, 'tagger'),
    message: messageAt < 0 ? '' : text.slice(messageAt + 2),
  };
}

export function collectReachable(tips: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (tip && tip !== ZERO_OID) queue.push(tip);
  }
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      queue.push(...view.parents);
    } else if (object.type === 'tag') {
      const view = parseTag(object.data);
      queue.push(view.object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  }
  return seen;
}

// ---------------------------------------------------------------- packfile write

export interface GitObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- packfile read

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  entries: Array<{ offset: number; type: GitObjectType; data: Buffer; oid: string; delta: { kind: 'ofs' | 'ref'; baseOid: string } | null }>;
  checksumOk: boolean;
  deltaCount: number;
}

function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(Buffer.from(buffer.subarray(offset)), { finishFlush: 2 });
  // finishFlush: Z_SYNC_FLUSH would be needed for partial streams; here each entry is a complete
  // deflate stream so default flush works — but inflateSync stops at stream end and throws on the
  // trailing bytes. Compute consumed length by re-deflating is unreliable; instead parse raw blocks.
  // Simplest correct approach: use incremental inflate.
  throw new Error('unused');
}

interface DeltaHeader {
  first: number;
  size: number;
  next: number;
}

function readVarintSize(buffer: Buffer, offset: number): DeltaHeader {
  let byte = buffer[offset] as number;
  let size = byte & 0x0f;
  let typeCode = (byte >> 4) & 0x07;
  let shift = 4;
  let index = offset + 1;
  while (byte & 0x80) {
    byte = buffer[index] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    index += 1;
  }
  return { first: (typeCode << 4) | (buffer[offset] as number & 0x0f), size, next: index };
}

function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset] as number;
  let value = byte & 0x7f;
  let index = offset + 1;
  while (byte & 0x80) {
    byte = buffer[index] as number;
    value = ((value + 1) << 7) | (byte & 0x7f);
    index += 1;
  }
  return { baseOffset: value, next: index };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (opcode & 0x01) copyOffset |= (delta[offset] as number) << 0, offset += 1;
      if (opcode & 0x02) copyOffset |= (delta[offset] as number) << 8, offset += 1;
      if (opcode & 0x04) copyOffset |= (delta[offset] as number) << 16, offset += 1;
      if (opcode & 0x08) copyOffset |= (delta[offset] as number) << 24, offset += 1;
      if (opcode & 0x10) copySize |= (delta[offset] as number) << 0, offset += 1;
      if (opcode & 0x20) copySize |= (delta[offset] as number) << 8, offset += 1;
      if (opcode & 0x40) copySize |= (delta[offset] as number) << 16, offset += 1;
      if (copySize === 0) copySize = 0x10000;
      out.push(Buffer.from(base.subarray(copyOffset, copyOffset + copySize)));
    } else if (opcode > 0) {
      out.push(Buffer.from(delta.subarray(offset, offset + opcode)));
      offset += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error(`delta result size ${result.length} != ${resultSize}`);
  return result;
}

/**
 * Inflate one zlib stream out of `buffer` starting at `offset`, reporting exactly how many input
 * bytes the stream consumed. The pack reader needs the boundary to find the next entry. Node's zlib
 * handles run on the thread pool, so this wraps the synchronous drain in a Promise; readPack awaits.
 */
function inflateOne(buffer: Buffer, offset: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const infl = createInflate();
    const chunks: Buffer[] = [];
    let written = 0;
    let ended = false;
    infl.on('data', (chunk: Buffer) => chunks.push(chunk));
    infl.on('error', reject);
    const finish = (): void => {
      resolve({ data: Buffer.concat(chunks), next: offset + written });
    };
    infl.on('end', () => {
      ended = true;
      // The stream is complete. zlib consumed every byte written before `end` fires; the tail of the
      // final write beyond the stream is dropped by zlib itself, but `written` counts it. Trim by
      // re-running inflateSync on the exact prefix: binary search is unnecessary because zlib stops
      // reading at the stream's end and exposes the remainder via inflate's internal state; instead
      // find the true end by re-inflating progressively shorter prefixes (log steps, cheap).
      const total = written;
      let lo = 1;
      let hi = total;
      // The stream ends at the smallest prefix that still inflates to the same full output.
      const full = Buffer.concat(chunks);
      const attempt = (end: number): Buffer | null => {
        try {
          return inflateSync(buffer.subarray(offset, offset + end));
        } catch {
          return null;
        }
      };
      let step = 1;
      while (step < hi) step <<= 1;
      lo = 0;
      while (step > 0) {
        const candidate = lo + step;
        if (candidate <= hi) {
          const result = attempt(candidate);
          if (result !== null && result.length === full.length) hi = candidate;
          else lo = candidate;
        }
        step >>= 1;
      }
      written = hi;
      finish();
    });
    infl.end(buffer.subarray(offset));
    written = buffer.length - offset;
    void ended;
  });
}

export function packChecksum(pack: Uint8Array): string {
  return createHash('sha1').update(Buffer.from(pack.subarray(0, pack.length - 20))).digest('hex');
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = Buffer.from(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

export async function readPack(pack: Uint8Array): Promise<PackReadResult> {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = await inflateOne(buffer, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry, seen: Set<number>): { type: GitObjectType; data: Buffer; oid: string } => {
    if (seen.has(entry.offset)) throw new Error('delta cycle');
    seen.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      deltaCount += 1;
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry, seen);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      deltaCount += 1;
      const oid = entry.baseOid as string;
      const external = objects.get(oid);
      if (!external) throw new Error(`ref-delta base ${oid} unavailable`);
      type = external.type;
      data = applyDelta(external.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    return { type, data, oid: hashObject(type, data) };
  };
  for (const entry of raw) {
    const resolved = resolve(entry, new Set());
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, entries: [], checksumOk, deltaCount };
}

// ---------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface GitPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
  raw: Buffer;
}

export class PktLineDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
  }

  next(): GitPacket | null {
    if (this.buffer.length < 4) return null;
    const head = this.buffer.subarray(0, 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      this.buffer = this.buffer.subarray(4);
      return { kind: 'flush', payload: Buffer.alloc(0), raw: Buffer.from('0000', 'ascii') };
    }
    if (length === 1) {
      this.buffer = this.buffer.subarray(4);
      return { kind: 'delim', payload: Buffer.alloc(0), raw: Buffer.from('0001', 'ascii') };
    }
    if (length < 4 || this.buffer.length < length) return null;
    const payload = Buffer.from(this.buffer.subarray(4, length));
    const raw = Buffer.from(this.buffer.subarray(0, length));
    this.buffer = this.buffer.subarray(length);
    return { kind: 'data', payload, raw };
  }

  finish(): void {
    if (this.buffer.length > 0) throw new Error(`${this.buffer.length} stray pkt-line byte(s) after the stream`);
  }
}

export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const decoder = new PktLineDecoder();
  decoder.push(bytes);
  const packets: GitPacket[] = [];
  for (let packet = decoder.next(); packet !== null; packet = decoder.next()) packets.push(packet);
  return packets;
}

export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktLineFlush());
    else if (line === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** Wrap `data` into sideband band-1 pkt-line frames of at most `maxPayload` bytes each. */
export function sidebandFrames(data: Buffer, maxPayload = 65515): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, offset + maxPayload);
    const frame = Buffer.concat([Buffer.alloc(1, 1), chunk]);
    parts.push(encodePktLine(frame));
  }
  return Buffer.concat(parts);
}
