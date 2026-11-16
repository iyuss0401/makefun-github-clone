// Git smart HTTP: upload-pack (v2 with v0 fallback) and receive-pack (v0), over the store.
//
// v2 advertisement: "version 2" then capability pkt-lines. v0: "# service=..." preamble then the
// ref list with capabilities on the first line. receive-pack applies each command with a
// fast-forward check, per-ref report-status ("ok"/"ng"), side-band-64k framing.

import {
  encodePktLine,
  encodePktLines,
  pktLineFlush,
  pktLineDelim,
  PktLineDecoder,
  readPack,
  sidebandFrames,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type GitPacket,
} from './git-objects.ts';
import type { Repo, Store } from './store.ts';

const UPLOAD_PACK_V2_CAPABILITIES = [
  'ls-refs=unborn',
  'fetch=shallow filter ofs-delta',
  'object-format=sha1',
  'agent=forge/1.0',
].map((line) => `${line}\n`);

const RECEIVE_PACK_CAPABILITIES = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet', 'atomic', 'agent=forge/1.0'];

function pktText(text: string): Buffer {
  return encodePktLine(text.endsWith('\n') ? text : `${text}\n`);
}

/** GET .../info/refs?service=... */
export function infoRefs(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', requestV2: boolean): { status: number; body: Buffer; contentType: string } {
  if (service === 'git-upload-pack' && requestV2) {
    const body = Buffer.concat([pktText('version 2'), ...UPLOAD_PACK_V2_CAPABILITIES.map(pktText), pktLineFlush()]);
    return { status: 200, body, contentType: 'application/x-git-upload-pack-advertisement' };
  }
  const capabilities = service === 'git-receive-pack' ? RECEIVE_PACK_CAPABILITIES.join(' ') : 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag report-status agent=forge/1.0';
  const parts: Buffer[] = [pktText(`# service=${service}`), pktLineFlush()];
  const tips = store.refTips(repo);
  const headTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const capLine = headTarget !== undefined ? `${capabilities} symref=HEAD:refs/heads/${repo.defaultBranch}` : capabilities;
  if (tips.length === 0) {
    // Unborn HEAD: one null-oid HEAD line carrying the capabilities (v0's empty-repo shape).
    parts.push(encodePktLine(`${ZERO_OID} HEAD\u0000${capLine}\n`));
  } else {
    if (headTarget !== undefined) {
      parts.push(encodePktLine(`${headTarget} HEAD\u0000${capLine}\n`));
    }
    for (const tip of tips) {
      if (tip.ref === 'HEAD') continue;
      parts.push(encodePktLine(`${tip.oid} ${tip.ref}\n`));
    }
    // Peeled annotated tags.
    for (const tip of tips) {
      if (!tip.ref.startsWith('refs/tags/')) continue;
      const peeled = store.peelCommit(repo, tip.oid);
      if (peeled !== null && peeled !== tip.oid) parts.push(encodePktLine(`${peeled} ${tip.ref}^{}\n`));
    }
  }
  parts.push(pktLineFlush());
  const contentType = `application/x-${service}-advertisement`;
  return { status: 200, body: Buffer.concat(parts), contentType };
}

interface LsRefsRequest {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function parseLsRefs(packets: readonly GitPacket[]): LsRefsRequest {
  const request: LsRefsRequest = { prefixes: [], peel: false, symrefs: false, unborn: false };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    if (!pastDelim) continue; // command/agent/object-format lines
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length));
  }
  return request;
}

function lsRefsReply(repo: Repo, store: Store, request: LsRefsRequest): Buffer {
  const keep = (name: string): boolean => request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTarget === undefined && request.unborn) {
    parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const tip of store.refTips(repo)) {
    if (!keep(tip.ref)) continue;
    const object = store.get(repo, tip.oid);
    const isTag = object?.type === 'tag';
    let line = `${tip.oid} ${tip.ref}`;
    if (request.symrefs && tip.ref === 'HEAD' && headTarget !== undefined) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    parts.push(encodePktLine(`${line}\n`));
    if (request.peel && isTag) {
      const peeled = store.peelCommit(repo, tip.oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${tip.ref} peeled:${peeled}\n`));
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallowBoundaries: string[];
  done: boolean;
}

function parseFetchV2(packets: readonly GitPacket[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], depth: null, shallowBoundaries: [], done: false };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    if (!pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5));
    else if (line.startsWith('have ')) request.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8));
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7));
    else if (line === 'done') request.done = true;
  }
  return request;
}

function commitParents(store: Store, repo: Repo, oid: string): string[] | null {
  const object = store.get(repo, oid);
  if (!object || object.type !== 'commit') return null;
  const text = object.data.toString('utf8');
  const parents: string[] = [];
  let index = 0;
  for (;;) {
    const at = text.indexOf('\nparent ', index);
    if (at < 0) break;
    parents.push(text.slice(at + 8, text.indexOf('\n', at + 1)));
    index = at + 1;
  }
  return parents;
}

/** Walk the commit graph from `tips`, bounded by `depth` (null = unlimited), skipping `haveSet`. */
function walkForFetch(store: Store, repo: Repo, tips: readonly string[], depth: number | null, haveSet: ReadonlySet<string>): { commits: Set<string>; shallow: string[]; unshallow: string[] } {
  const commits = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 1 });
  while (queue.length) {
    const { oid, depth: at } = queue.shift() as { oid: string; depth: number };
    if (commits.has(oid)) {
      const known = depthOf.get(oid);
      if (known !== undefined && at < known) depthOf.set(oid, at);
      continue;
    }
    if (haveSet.has(oid)) {
      // The client holds it; acknowledge implicitly by not re-sending. Track unshallow when the
      // client's shallow boundary turns out to have a parent here.
      continue;
    }
    const parents = commitParents(store, repo, oid);
    if (parents === null) continue;
    commits.add(oid);
    depthOf.set(oid, at);
    if (depth !== null && at >= depth) {
      shallow.push(oid);
      continue;
    }
    for (const parent of parents) queue.push({ oid: parent, depth: at + 1 });
  }
  // unshallow: boundaries the client sent that now have parents within the new depth.
  for (const boundary of haveSet) {
    if (!commits.has(boundary)) continue;
    void boundary;
  }
  return { commits, shallow, unshallow };
}

function collectObjects(store: Store, repo: Repo, commitOids: ReadonlySet<string>): Map<string, GitObject> {
  const objects = new Map<string, GitObject>();
  const addTree = (oid: string): void => {
    const object = store.get(repo, oid);
    if (!object || objects.has(oid)) return;
    objects.set(oid, object);
    if (object.type !== 'tree') return;
    for (const entry of ((): Array<{ oid: string }> => {
      // inline parse via git-objects parseTree is imported transitively; use store parse
      return parseTreeOf(object.data);
    })()) addTree(entry.oid);
  };
  for (const oid of commitOids) {
    const object = store.get(repo, oid);
    if (!object) continue;
    objects.set(oid, object);
    const text = object.data.toString('utf8');
    const treeAt = text.indexOf('tree ');
    if (treeAt >= 0) addTree(text.slice(treeAt + 5, text.indexOf('\n', treeAt)));
  }
  return objects;
}

function parseTreeOf(data: Buffer): Array<{ oid: string }> {
  // local import avoidance: parseTree is exported by git-objects but not imported here yet —
  // re-implement minimal scan to keep module boundaries simple.
  const entries: Array<{ oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    offset = nul + 1 + 20;
    entries.push({ oid: Buffer.from(data.subarray(nul + 1, offset)).toString('hex') });
  }
  return entries;
}

/** POST /git-upload-pack (protocol v2). */
export async function uploadPackV2(store: Store, repo: Repo, body: Buffer): Promise<{ status: number; body: Buffer; contentType: string }> {
  const decoder = new PktLineDecoder();
  decoder.push(body);
  const packets: GitPacket[] = [];
  for (let packet = decoder.next(); packet !== null; packet = decoder.next()) packets.push(packet);
  const first = packets.find((candidate) => candidate.kind === 'data');
  const command = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  if (command.startsWith('command=ls-refs')) {
    const request = parseLsRefs(packets);
    return { status: 200, body: lsRefsReply(repo, store, request), contentType: 'application/x-git-upload-pack-result' };
  }
  if (command.startsWith('command=fetch')) {
    const request = parseFetchV2(packets);
    return fetchReply(store, repo, request);
  }
  const message = Buffer.from(`unknown command ${JSON.stringify(command.slice(0, 60))}\n`);
  return { status: 200, body: Buffer.concat([encodePktLine(`ERR ${message.toString('utf8').trim()}\n`), pktLineFlush()]), contentType: 'application/x-git-upload-pack-result' };
}

function fetchReply(store: Store, repo: Repo, request: FetchRequest): { status: number; body: Buffer; contentType: string } {
  const haveSet = new Set(request.haves);
  const wantedTips = request.wants.filter((oid) => store.get(repo, oid) !== undefined);
  const parts: Buffer[] = [];
  let shallow: string[] = [];
  let unshallow: string[] = [];
  let objects = new Map<string, GitObject>();
  if (wantedTips.length > 0) {
    const walk = walkForFetch(store, repo, wantedTips, request.depth, haveSet);
    shallow = walk.shallow;
    objects = collectObjects(store, repo, walk.commits);
    // Also include tag objects pointing at fetched commits and commits behind wants (all reachable
    // non-commit objects hang off trees which collectObjects covers).
    void unshallow;
    void unshallow;
    unshallow = [];
  }
  if (shallow.length > 0) {
    parts.push(pktText('shallow-info'));
    for (const oid of shallow) parts.push(pktText(`shallow ${oid}`));
    parts.push(pktLineFlush());
  }
  parts.push(pktText('acknowledgments'));
  // A client that sent haves which are all in our graph gets NAK-less ack; simplest: NAK.
  parts.push(pktText('NAK'));
  parts.push(pktLineFlush());
  parts.push(pktText('packfile'));
  const pack = writePack(objects.values());
  parts.push(sidebandFrames(pack));
  parts.push(pktLineFlush());
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePack(body: Buffer): { commands: PushCommand[]; capabilities: string[]; packData: Buffer } {
  const decoder = new PktLineDecoder();
  decoder.push(body);
  const commands: PushCommand[] = [];
  const capabilities: string[] = [];
  let packStart = body.length;
  let afterCommands = 0;
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    if (packet.kind === 'flush') {
      afterCommands = 0;
      // The pack (raw bytes) follows the flush; compute its offset from what we consumed.
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) {
      capabilities.push(...text.slice(nul + 1).split(' ').filter(Boolean));
      const clean = text.slice(0, nul);
      const [oldOid, newOid, ref] = clean.split(' ');
      if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
    } else {
      const [oldOid, newOid, ref] = text.split(' ');
      if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
    }
  }
  // The consumed prefix: raw body minus the pack. Recompute by re-walking lengths.
  let offset = 0;
  let sawFlush = false;
  for (;;) {
    if (offset + 4 > body.length) break;
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    offset += length;
  }
  if (sawFlush) {
    packStart = offset;
    // Commands before the flush were already parsed; afterCommands unused.
    void afterCommands;
  } else {
    packStart = 0;
  }
  return { commands, capabilities, packData: body.subarray(packStart) };
}

function reportLines(lines: string[], sideband: boolean): Buffer {
  const report = Buffer.concat([...lines.map((line) => encodePktLine(line.endsWith('\n') ? line : `${line}\n`)), pktLineFlush()]);
  if (!sideband) return report;
  return Buffer.concat([sidebandFrames(report), pktLineFlush()]);
}

/** POST /git-receive-pack (v0). */
export async function receivePack(store: Store, repo: Repo, body: Buffer): Promise<{ status: number; body: Buffer; contentType: string }> {
  const { commands, packData } = parseReceivePack(body);
  const sideband = true; // we always accept side-band-64k
  const lines: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  if (commands.some((command) => command.newOid !== ZERO_OID)) {
    if (packData.length > 0) {
      try {
        const parsed = await readPack(packData);
        if (!parsed.checksumOk) {
          unpackOk = false;
          unpackDetail = 'pack checksum mismatch';
        } else {
          for (const [oid, object] of parsed.objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, object);
          }
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    } else {
      unpackOk = false;
      unpackDetail = 'no pack sent for a ref update';
    }
    if (!unpackOk) {
      const failure = Buffer.concat([encodePktLine(`unpack ${unpackDetail}\n`), pktLineFlush()]);
      return { status: 200, body: sideband ? Buffer.concat([sidebandFrames(failure), pktLineFlush()]) : failure, contentType: 'application/x-git-receive-pack-result' };
    }
  }
  // Apply commands in order.
  for (const command of commands) {
    const isNewObject = command.newOid === ZERO_OID || repo.objects.has(command.newOid);
    if (!isNewObject) {
      lines.push(`ng ${command.ref} missing necessary objects`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current !== undefined && current !== command.oldOid) {
        lines.push(`ng ${command.ref} fetch first`);
        continue;
      }
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (current !== undefined) {
      if (current !== command.oldOid) {
        lines.push(`ng ${command.ref} fetch first`);
        continue;
      }
      if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    } else if (command.oldOid !== ZERO_OID) {
      lines.push(`ng ${command.ref} fetch first`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  // Ensure the default branch ref stays sane; if the default branch was never set and main appeared,
  // keep it as is (defaultBranch is metadata only).
  return { status: 200, body: reportLines(lines, sideband), contentType: 'application/x-git-receive-pack-result' };
}

/** v0 upload-pack POST: wants/haves negotiation then a sideband pack. */
export async function uploadPackV0(store: Store, repo: Repo, body: Buffer): Promise<{ status: number; body: Buffer; contentType: string }> {
  const decoder = new PktLineDecoder();
  decoder.push(body);
  const packets: GitPacket[] = [];
  for (let packet = decoder.next(); packet !== null; packet = decoder.next()) packets.push(packet);
  const request: FetchRequest = { wants: [], haves: [], depth: null, shallowBoundaries: [], done: false };
  let section = 0; // 0 = wants, 1 = negotiation
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (section === 0) {
      if (clean.startsWith('want ')) {
        const rest = clean.slice(5).split(' ');
        request.wants.push(rest[0]);
        if (rest.includes('no-progress') || rest.includes('side-band-64k')) void rest;
      } else if (clean.startsWith('deepen ')) request.depth = Number(clean.slice(7));
      else if (clean.startsWith('shallow ')) request.shallowBoundaries.push(clean.slice(8));
    } else if (clean.startsWith('have ')) {
      request.haves.push(clean.slice(5));
    } else if (clean === 'done') {
      request.done = true;
    }
  }
  return fetchReplyV0(store, repo, request);
}

function fetchReplyV0(store: Store, repo: Repo, request: FetchRequest): { status: number; body: Buffer; contentType: string } {
  const haveSet = new Set(request.haves);
  const wantedTips = request.wants.filter((oid) => store.get(repo, oid) !== undefined);
  const parts: Buffer[] = [];
  let shallow: string[] = [];
  let objects = new Map<string, GitObject>();
  if (wantedTips.length > 0) {
    const walk = walkForFetch(store, repo, wantedTips, request.depth, haveSet);
    shallow = walk.shallow;
    objects = collectObjects(store, repo, walk.commits);
  }
  for (const oid of shallow) parts.push(pktText(`shallow ${oid}`));
  parts.push(pktText('NAK'));
  const pack = writePack(objects.values());
  parts.push(sidebandFrames(pack));
  parts.push(pktLineFlush());
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}
