// github-core-forge — a GitHub-compatible git forge in one file.
// Node 22+ stdlib only: node:http, node:crypto, node:zlib. No git binary.
// Surfaces: smart-HTTP git (v2 + v0), REST v3 (/api/v3), GraphQL (/api/graphql),
// MCP (JSON-RPC 2.0 Streamable HTTP, 2026-07-28) — all over one in-memory store.
// Determinism: ids from counters, fixed commit timestamps, no wall-clock or
// randomness in any scored output.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Config & viewer identity
// ---------------------------------------------------------------------------
export const TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const VERSION = '1.0.0';
const ZERO_OID = '0000000000000000000000000000000000000000';
const MERGED_AT = '2026-11-19T00:00:00Z';
const AGENT = 'github-core-forge/1.0.0';

// Viewer login is derived from the published scenario PRNG (kit wire.ts):
// same FNV-1a + splitmix64 + xorshift64* chain the scenario generator uses.
// The token itself does not encode the login.
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & U64_MASK;
  }
  return h;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return z ^ (z >> 31n);
}
class Rng {
  state: bigint;
  constructor(seed: bigint) { this.state = seed & U64_MASK; }
  nextU64(): bigint {
    let x = this.state;
    x ^= x >> 12n;
    x ^= (x << 25n) & U64_MASK;
    x ^= x >> 27n;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(maxExclusive: number): number {
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    let v = this.nextU32();
    while (v >= limit) v = this.nextU32();
    return v % maxExclusive;
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)] as T; }
}
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;
function deriveViewerLogin(): string {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`;
}
export const VIEWER: string = deriveViewerLogin();
export const VIEWER_EMAIL = `${VIEWER}@example.invalid`;
export const VIEWER_ID = 1000;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
let reqSeq = 0;
let commitSeq = 0;
let commentSeq = 0;
let repoSeq = 0;
const repoById = new Map<number, Repo>();
const repos = new Map<string, Repo>();

function sha1Hex(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
function isSha(s: string): boolean { return /^[0-9a-f]{40}$/.test(s); }
function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n'); }
function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}
function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const p = s.split(':');
    if (p.length < 2) return null;
    return { kind: p[0] as string, parts: p.slice(1) };
  } catch { return null; }
}
function httpError(status: number, message: string): Error & { status: number; message: string } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e as Error & { status: number; message: string };
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'x-github-request-id': `req-${++reqSeq}`,
    ...(extra ?? {}),
  });
  res.end(data);
}
function sendBuf(res: ServerResponse, status: number, buf: Buffer, contentType: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(buf.length),
    'x-github-request-id': `req-${++reqSeq}`,
    ...(extra ?? {}),
  });
  res.end(buf);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'Problems parsing JSON'); }
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }
export function objectId(type: GitObjectType, data: Buffer): string {
  return sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}
export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const out: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0) throw new Error('malformed tree');
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}
export function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const idx = text.indexOf('\n\n');
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const message = idx >= 0 ? text.slice(idx + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}
function commitTimestamp(): number { return 1700000000 + (commitSeq++); }
export function buildCommit(tree: string, parents: string[], message: string): { oid: string; data: Buffer } {
  const ts = commitTimestamp();
  const who = `${VIEWER} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '', message);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  return { oid: objectId('commit', data), data };
}
function encodeSizeType(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}
const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export function writePack(objs: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK')];
  const v = Buffer.alloc(4); v.writeUInt32BE(2, 0); parts.push(v);
  const c = Buffer.alloc(4); c.writeUInt32BE(objs.length, 0); parts.push(c);
  const trailerSrc: Buffer[] = [];
  for (const o of objs) {
    const comp = deflateSync(o.data);
    const hdr = encodeSizeType(TYPE_NUM[o.type], o.data.length);
    parts.push(hdr, comp);
    trailerSrc.push(hdr, comp);
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = buf.readUInt32BE(8);
  const out = new Map<string, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n++) {
    let byte = buf[off++];
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6 || typeNum === 7) throw new Error('delta objects not supported');
    const type = NUM_TYPE[typeNum];
    if (!type) throw new Error(`unknown object type ${typeNum}`);
    // One inflate per object: inflateSync ignores trailing bytes, and with
    // { info: true } the engine reports exactly how many input bytes the
    // zlib stream consumed (engine.bytesWritten). That replaces the binary
    // search for the stream end below. If the fast path looks inconsistent
    // (wrong size, no byte count), fall back to the binary search.
    let data: Buffer | null = null;
    let consumed = 0;
    try {
      const out = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten?: unknown } };
      const bw = out.engine?.bytesWritten;
      if (out.buffer.length === size && typeof bw === 'number' && bw > 0 && off + bw <= buf.length) {
        data = out.buffer;
        consumed = bw;
      }
    } catch { /* fall through to the binary search */ }
    if (data === null) {
      // The zlib stream's end is the smallest offset whose inflation yields the
      // declared size: a shorter slice throws ("unexpected end of file"), a
      // longer one inflates fine (trailing bytes are ignored). Monotonic, so
      // binary-search it instead of probing byte by byte.
      let lo = off + 1;
      let hi = buf.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        try {
          const cand = inflateSync(buf.subarray(off, mid));
          if (cand.length === size) { data = cand; consumed = mid - off; hi = mid - 1; }
          else lo = mid + 1;
        } catch { lo = mid + 1; }
      }
    }
    if (data === null) throw new Error('pack entry inflate failed');
    off += consumed;
    const oid = objectId(type, data);
    out.set(oid, { type, data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------
const FLUSH_PKT = Buffer.from('0000');
const DELIM_PKT = Buffer.from('0001');
function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
function flushPkt(): Buffer { return FLUSH_PKT; }
type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };
function decodePktLines(buf: Buffer, stopAtFlush = false): { pkts: Pkt[]; rest: Buffer } {
  const pkts: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      pkts.push({ kind: 'flush' });
      off += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) { pkts.push({ kind: 'delim' }); off += 4; continue; }
    if (off + len > buf.length) throw new Error('truncated pkt-line payload');
    pkts.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return { pkts, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export interface IssueRec {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; seq: number;
  _json: Buffer | null; // cached serialized REST body for GET-one; cleared on mutation
}
function issueJsonBuf(r: Repo, i: IssueRec): Buffer {
  if (i._json) return i._json;
  const buf = Buffer.from(JSON.stringify(issueJson(r, i)), 'utf8');
  i._json = buf;
  return buf;
}
export interface CommentRec { id: number; body: string; }
export interface PullRec {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; head: string; base: string;
  headSha: string; baseSha: string; merged: boolean;
  mergeSha: string | null; mergedAt: string | null; seq: number;
}
export interface Repo {
  id: number; name: string; owner: string; description: string;
  isPrivate: boolean; defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: IssueRec[]; issueSeq: number;
  comments: Map<number, CommentRec[]>;
  pulls: PullRec[]; pullSeq: number;
  commitMsg: Map<string, string>;
  version: number;
  packCache: Map<string, { pack: Buffer; shallowOut: string[]; unshallow: string[]; objects: Map<string, GitObject> }>;
}
function newRepo(name: string, description: string, isPrivate: boolean): Repo {
  const id = ++repoSeq;
  const r: Repo = {
    id, name, owner: VIEWER, description, isPrivate,
    defaultBranch: 'main',
    objects: new Map(), refs: new Map(), labels: new Map(),
    issues: [], issueSeq: 0, comments: new Map(),
    pulls: [], pullSeq: 0, commitMsg: new Map(),
    version: 0, packCache: new Map(),
  };
  repoById.set(id, r);
  repos.set(`${VIEWER}/${name}`, r);
  return r;
}
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function findRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}
function repoByDbId(id: number): Repo | null { return repoById.get(id) ?? null; }
function repoFromIdInput(v: unknown): Repo | null {
  const s = String(v ?? '');
  const parsed = parseGid(s);
  if (parsed && parsed.kind === 'Repository') {
    const n = parseInt(parsed.parts[0] ?? '', 10);
    return Number.isNaN(n) ? null : repoByDbId(n);
  }
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : repoByDbId(n);
}
function bump(r: Repo): void { r.version++; r.packCache.clear(); }
function getCommit(r: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
  const o = r.objects.get(oid);
  if (!o || o.type !== 'commit') return null;
  return parseCommit(o.data);
}
function headSha(r: Repo, branch: string): string | null {
  return r.refs.get(`refs/heads/${branch}`) ?? null;
}
function resolveRef(r: Repo, refish: string): string | null {
  if (isSha(refish) && r.objects.has(refish)) return refish;
  if (r.refs.has(refish)) return r.refs.get(refish) as string;
  const h = headSha(r, refish);
  if (h) return h;
  return null;
}
function commitMessage(r: Repo, oid: string): string {
  const raw = r.commitMsg.get(oid);
  if (raw !== undefined) return raw;
  const c = getCommit(r, oid);
  if (!c) return '';
  return c.message.replace(/\n$/, '');
}
// Tree helpers --------------------------------------------------------------
function treeEntries(r: Repo, treeOid: string): { mode: string; name: string; oid: string }[] {
  const o = r.objects.get(treeOid);
  if (!o || o.type !== 'tree') return [];
  return parseTree(o.data);
}
function treeAtPath(r: Repo, treeOid: string, path: string): { tree: string; name: string; oid: string; mode: string } | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  let cur = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const entries = treeEntries(r, cur);
    const e = entries.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return { tree: cur, name: e.name, oid: e.oid, mode: e.mode };
    if (e.mode !== '40000') return null;
    cur = e.oid;
  }
  return null;
}
function setPathInTree(r: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
  // Returns new root tree oid. blobOid null = delete.
  const parts = path.split('/').filter(Boolean);
  function rec(tree: string | null, depth: number): string {
    const entries = tree ? treeEntries(r, tree) : [];
    const name = parts[depth] as string;
    const idx = entries.findIndex((e) => e.name === name);
    let next = [...entries];
    if (depth === parts.length - 1) {
      if (blobOid === null) {
        if (idx >= 0) next.splice(idx, 1);
      } else if (idx >= 0) {
        next[idx] = { ...next[idx] as { mode: string; name: string; oid: string }, oid: blobOid, mode: '100644' };
      } else {
        next.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const child = idx >= 0 ? (next[idx] as { mode: string; name: string; oid: string }) : null;
      const childTree = child && child.mode === '40000' ? child.oid : null;
      const newChild = rec(childTree, depth + 1);
      const childEntries = treeEntries(r, newChild);
      if (childEntries.length === 0) {
        if (idx >= 0) next.splice(idx, 1);
      } else if (idx >= 0) {
        next[idx] = { ...next[idx] as { mode: string; name: string; oid: string }, oid: newChild, mode: '40000' };
      } else {
        next.push({ mode: '40000', name, oid: newChild });
      }
    }
    const data = buildTree(next);
    const oid = objectId('tree', data);
    r.objects.set(oid, { type: 'tree', data });
    return oid;
  }
  return rec(treeOid, 0);
}
function storeCommit(r: Repo, tree: string, parents: string[], message: string): string {
  const { oid, data } = buildCommit(tree, parents, message);
  r.objects.set(oid, { type: 'commit', data });
  r.commitMsg.set(oid, message);
  return oid;
}
function listFiles(r: Repo, treeOid: string, prefix: string, out: { path: string; oid: string; mode: string }[]): void {
  for (const e of treeEntries(r, treeOid)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') listFiles(r, e.oid, p, out);
    else out.push({ path: p, oid: e.oid, mode: e.mode });
  }
}
function commitFiles(r: Repo, commitOid: string): Map<string, string> {
  const c = getCommit(r, commitOid);
  const m = new Map<string, string>();
  if (!c) return m;
  const files: { path: string; oid: string; mode: string }[] = [];
  listFiles(r, c.tree, '', files);
  for (const f of files) m.set(f.path, f.oid);
  return m;
}
function ancestors(r: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = getCommit(r, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return seen;
}
function isAncestor(r: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const stack = [desc];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = getCommit(r, cur);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return false;
}
function mergeBase(r: Repo, a: string, b: string): string | null {
  const ancA = ancestors(r, a);
  // BFS from b; first commit also in ancA is the merge base (linear histories).
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift() as string;
    if (ancA.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const c = getCommit(r, cur);
    if (c) for (const p of c.parents) queue.push(p);
  }
  return null;
}
interface FileDiff { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number; }
function diffFiles(r: Repo, baseOid: string | null, headOid: string): FileDiff[] {
  const base = baseOid ? commitFiles(r, baseOid) : new Map<string, string>();
  const head = commitFiles(r, headOid);
  const out: FileDiff[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b === h) continue;
    if (b === undefined) {
      out.push({ filename: name, status: 'added', additions: 1, deletions: 0, changes: 1 });
    } else if (h === undefined) {
      out.push({ filename: name, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    } else {
      out.push({ filename: name, status: 'modified', additions: 1, deletions: 1, changes: 2 });
    }
  }
  return out;
}
function threeWayMerge(r: Repo, baseOid: string, headOid: string, baseTipOid: string): { ok: boolean; tree: string } {
  const baseFiles = commitFiles(r, baseOid);
  const headFiles = commitFiles(r, headOid);
  const tipFiles = commitFiles(r, baseTipOid);
  const merged = new Map<string, string>(tipFiles);
  const names = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const name of names) {
    const b = baseFiles.get(name);
    const h = headFiles.get(name);
    const t = tipFiles.get(name);
    if (h === b) continue; // head unchanged -> keep tip
    if (t === b) { // tip unchanged -> take head
      if (h === undefined) merged.delete(name); else merged.set(name, h);
      continue;
    }
    if (h === t) continue; // both made same change
    return { ok: false, tree: '' };
  }
  // Build merged tree from flat file map.
  let rootTree = '';
  const sorted = [...merged.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const treeOid = (() => {
    function build(entries: [string, string][], prefix: string): string {
      const direct: { mode: string; name: string; oid: string }[] = [];
      const dirs = new Map<string, [string, string][]>();
      for (const [path, oid] of entries) {
        const rel = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rel.indexOf('/');
        if (slash < 0) direct.push({ mode: '100644', name: rel, oid });
        else {
          const d = rel.slice(0, slash);
          const arr = dirs.get(d) ?? [];
          arr.push([path, oid]);
          dirs.set(d, arr);
        }
      }
      for (const [d, arr] of [...dirs.entries()].sort()) {
        direct.push({ mode: '40000', name: d, oid: build(arr, prefix ? `${prefix}/${d}` : d) });
      }
      const data = buildTree(direct);
      const oid = objectId('tree', data);
      r.objects.set(oid, { type: 'tree', data });
      return oid;
    }
    return build(sorted, '');
  })();
  rootTree = treeOid;
  return { ok: true, tree: rootTree };
}

// ---------------------------------------------------------------------------
// Git object closure (fetch)
// ---------------------------------------------------------------------------
interface ClosureResult { objects: Map<string, GitObject>; shallowOut: string[]; commits: Set<string>; }
function collectClosure(r: Repo, roots: string[], depth?: number, shallow?: Set<string>, shallowIsBoundary = false): ClosureResult {
  const objects = new Map<string, GitObject>();
  const shallowOut = new Set<string>();
  const commits = new Set<string>();
  const shallowSet = shallow ?? new Set<string>();
  interface Item { oid: string; gen: number; }
  const queue: Item[] = roots.map((oid) => ({ oid, gen: 0 }));
  const seen = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const t = stack.pop() as string;
      if (objects.has(t)) continue;
      const o = r.objects.get(t);
      if (!o) continue;
      objects.set(t, o);
      if (o.type === 'tree') {
        for (const e of parseTree(o.data)) {
          if (e.mode === '40000') stack.push(e.oid);
          else {
            const bo = r.objects.get(e.oid);
            if (bo) objects.set(e.oid, bo);
          }
        }
      }
    }
  };
  while (queue.length) {
    const item = queue.shift() as Item;
    const { oid, gen } = item;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = r.objects.get(oid);
    if (!o) continue;
    if (o.type === 'commit') {
      objects.set(oid, o);
      commits.add(oid);
      const c = parseCommit(o.data);
      addTree(c.tree);
      // Depth limits parent traversal; a want-side shallow list never blocks
      // traversal (deepen must walk past the old boundary). Only a have-side
      // shallow list acts as a boundary (client lacks those ancestors).
      const atBoundary = (depth !== undefined && gen >= depth - 1) || (shallowIsBoundary && shallowSet.has(oid));
      if (atBoundary && depth !== undefined && gen === depth - 1) shallowOut.add(oid);
      if (!atBoundary) {
        for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
      }
    } else if (o.type === 'tag') {
      objects.set(oid, o);
      const m = /object ([0-9a-f]{40})/.exec(o.data.toString('utf8'));
      if (m) queue.push({ oid: m[1] as string, gen });
    } else {
      objects.set(oid, o);
    }
  }
  return { objects, shallowOut: [...shallowOut], commits };
}
function sidebandPack(pack: Buffer): Buffer {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pktLine(payload));
  }
  out.push(flushPkt());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------
function sortedRefs(r: Repo): { ref: string; oid: string }[] {
  return [...r.refs.entries()].map(([ref, oid]) => ({ ref, oid })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
}
function isAnnotatedTag(r: Repo, oid: string): { target: string } | null {
  const o = r.objects.get(oid);
  if (!o || o.type !== 'tag') return null;
  const m = /object ([0-9a-f]{40})/.exec(o.data.toString('utf8'));
  return m ? { target: m[1] as string } : null;
}
function handleInfoRefs(r: Repo, service: string, res: ServerResponse): void {
  const refs = sortedRefs(r);
  const head = r.refs.get('HEAD') ?? headSha(r, r.defaultBranch) ?? null;
  if (service === 'git-upload-pack') {
    const isV2 = false; // v2 advertisement is decided by Git-Protocol header, handled by caller
    void isV2;
    const parts: Buffer[] = [pktLine(`# service=git-upload-pack\n`), flushPkt()];
    // v0 advertisement (caller routes v2 separately)
    if (head) {
      const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 agent=github-core-forge/1.0.0';
      parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 agent=github-core-forge/1.0.0\n`));
    }
    for (const { ref, oid } of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = isAnnotatedTag(r, oid);
      if (peeled) parts.push(pktLine(`${peeled.target} ${ref}^{}\n`));
    }
    parts.push(flushPkt());
    sendBuf(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
  } else {
    const parts: Buffer[] = [pktLine(`# service=git-receive-pack\n`), flushPkt()];
    if (head) {
      const caps = `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=github-core-forge/1.0.0 object-format=sha1 symref=HEAD:refs/heads/${r.defaultBranch}`;
      parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=github-core-forge/1.0.0 object-format=sha1\n`));
    }
    for (const { ref, oid } of refs) parts.push(pktLine(`${oid} ${ref}\n`));
    parts.push(flushPkt());
    sendBuf(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-advertisement');
  }
}
function handleInfoRefsV2(r: Repo, service: string, res: ServerResponse): void {
  const head = headSha(r, r.defaultBranch);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  parts.push(pktLine('version 2\n'));
  if (service === 'git-upload-pack') {
    parts.push(pktLine('agent=github-core-forge/1.0.0\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
  } else {
    parts.push(pktLine('agent=github-core-forge/1.0.0\n'));
    parts.push(pktLine('object-format=sha1\n'));
  }
  parts.push(flushPkt());
  void head;
  sendBuf(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}
function computeFetchPack(r: Repo, wants: string[], haves: string[], depth: number | undefined, shallow: string[]): { pack: Buffer; shallowOut: string[]; unshallow: string[]; objects: Map<string, GitObject> } {
  const shallowSet = new Set(shallow);
  const cacheKey = `${r.version}|${r.objects.size}|${wants.join(',')}|${haves.join(',')}|${depth ?? ''}|${shallow.join(',')}`;
  // The key names the exact fetch: same repo version (bump() clears this
  // cache on every mutation, so a hit can only come from the same state),
  // same wants/haves/depth/shallow. A hit returns the same pack and the
  // same shallow/unshallow lists; callers only read them, never mutate.
  const cached = r.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const wantC = collectClosure(r, wants, depth, shallowSet, false);
  const haveC = haves.length ? collectClosure(r, haves, undefined, shallowSet, true) : { objects: new Map<string, GitObject>(), shallowOut: [], commits: new Set<string>() };
  const send = new Map<string, GitObject>();
  for (const [oid, o] of wantC.objects) if (!haveC.objects.has(oid)) send.set(oid, o);
  const shallowOut = depth !== undefined ? wantC.shallowOut : [];
  const unshallow = [...shallowSet].filter((s) => wantC.commits.has(s) && !shallowOut.includes(s));
  const pack = writePack([...send.values()]);
  const result = { pack, shallowOut, unshallow, objects: send };
  r.packCache.set(cacheKey, result);
  return result;
}
function handleUploadPackV2(r: Repo, body: Buffer, res: ServerResponse): void {
  const { pkts } = decodePktLines(body);
  const lines = pkts.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8').trim());
  const rawCmd = (lines[0] ?? '').trim();
  const cmd = rawCmd.startsWith('command=') ? rawCmd.slice('command='.length) : rawCmd;
  if (cmd === 'ls-refs') {
    const args = lines.slice(1);
    let peel = false, symrefs = false, unborn = false;
    const prefixes: string[] = [];
    for (const a of args) {
      if (a === 'peel') peel = true;
      else if (a === 'symrefs') symrefs = true;
      else if (a === 'unborn') unborn = true;
      else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const head = headSha(r, r.defaultBranch);
    // HEAD is listed when no prefix filter is given, or when a prefix
    // matches it (real git clones ask for `ref-prefix HEAD`).
    const includeHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
    if (includeHead) {
      if (head) {
        let line = `${head} HEAD`;
        if (symrefs) line += ` symref-target:refs/heads/${r.defaultBranch}`;
        out.push(pktLine(`${line}\n`));
      } else if (unborn) {
        out.push(pktLine(`unborn HEAD symref-target:refs/heads/${r.defaultBranch}\n`));
      }
    }
    for (const { ref, oid } of sortedRefs(r)) {
      if (prefixes.length && !prefixes.some((p) => ref.startsWith(p))) continue;
      let line = `${oid} ${ref}`;
      if (peel) {
        const peeled = isAnnotatedTag(r, oid);
        if (peeled) line += ` peeled:${peeled.target}`;
      }
      out.push(pktLine(`${line}\n`));
    }
    out.push(flushPkt());
    sendBuf(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return;
  }
  if (cmd !== 'fetch') throw httpError(400, `unknown v2 command ${cmd}`);
  const args = lines.slice(1);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  const shallow: string[] = [];
  let thinPack = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('depth ')) depth = parseInt(a.slice(6), 10);
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
    else if (a === 'deepen-relative') deepenRelative = true;
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a === 'thin-pack') thinPack = true;
    // filter / include-tag / no-progress / sideband-all ignored: we always send a full pack
  }
  void thinPack;
  // `deepen-relative N` deepens by N beyond the client's current depth:
  // the current depth is 1 + the deepest shallow boundary's generation
  // from the wants. (Real git sends this for --deepen; the kit uses an
  // absolute deepen.)
  if (depth !== undefined && deepenRelative) {
    let maxGen = 0;
    const shallowSet = new Set(shallow);
    const queue: { oid: string; gen: number }[] = wants.map((oid) => ({ oid, gen: 0 }));
    const seen = new Set<string>();
    while (queue.length) {
      const item = queue.shift() as { oid: string; gen: number };
      if (seen.has(item.oid)) continue;
      seen.add(item.oid);
      if (shallowSet.has(item.oid) && item.gen > maxGen) maxGen = item.gen;
      const c = getCommit(r, item.oid);
      if (c) for (const p of c.parents) queue.push({ oid: p, gen: item.gen + 1 });
    }
    depth = 1 + maxGen + depth;
  }
  const hasDone = args.includes('done');
  const { pack, shallowOut, unshallow } = computeFetchPack(r, wants, haves, depth, shallow);
  const out: Buffer[] = [];
  // Smart-HTTP fetch is a single request/response: the client sends its
  // haves without `done` (fixed Content-Length), and expects the whole
  // answer — acknowledgments, shallow-info, packfile — in that one
  // response. (`ready` says the server would take a `done` on a stateful
  // transport; over HTTP the client never sends one.)
  if (haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const h of haves) {
      if (r.objects.has(h)) { out.push(pktLine(`ACK ${h}\n`)); acked = true; }
    }
    if (!acked) out.push(pktLine('NAK\n'));
    if (!hasDone) {
      out.push(pktLine('ready\n'));
    }
    // Sections are separated by DELIM (0001), not flush: real git stops
    // reading at a flush here and dies "expected 'packfile'".
    out.push(DELIM_PKT);
  }
  if (depth !== undefined) {
    out.push(pktLine('shallow-info\n'));
    for (const s of shallowOut) out.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) out.push(pktLine(`unshallow ${u}\n`));
    out.push(DELIM_PKT);
  }
  out.push(pktLine('packfile\n'));
  out.push(sidebandPack(pack));
  sendBuf(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}
function handleUploadPackV0(r: Repo, body: Buffer, res: ServerResponse): void {
  const { pkts } = decodePktLines(body);
  const lines = pkts.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | undefined;
  const shallow: string[] = [];
  let done = false;
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('want ')) wants.push(l.slice(5).split(' ')[0] as string);
    else if (l.startsWith('have ')) haves.push(l.slice(5).split(' ')[0] as string);
    else if (l.startsWith('depth ')) depth = parseInt(l.slice(6), 10);
    else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7), 10);
    else if (l.startsWith('shallow ')) shallow.push(l.slice(8).trim());
    else if (l === 'done') done = true;
  }
  void done;
  const { pack, shallowOut, unshallow } = computeFetchPack(r, wants, haves, depth, shallow);
  const out: Buffer[] = [];
  for (const s of shallowOut) out.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) out.push(pktLine(`unshallow ${u}\n`));
  out.push(pktLine('NAK\n'));
  out.push(sidebandPack(pack));
  sendBuf(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}
function handleReceivePack(r: Repo, body: Buffer, res: ServerResponse): void {
  const { pkts, rest } = decodePktLines(body, true);
  interface Cmd { oldOid: string; newOid: string; ref: string; }
  const cmds: Cmd[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(clean);
    if (!m) throw httpError(400, 'malformed receive-pack command');
    cmds.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  let incoming = new Map<string, GitObject>();
  if (rest.length > 0) {
    try { incoming = readPack(rest); }
    catch (e) {
      const inner = Buffer.concat([
        pktLine(`unpack ${(e as Error).message}\n`),
        ...cmds.map((c) => pktLine(`ng ${c.ref} unpack error\n`)),
        flushPkt(),
      ]);
      sendBuf(res, 200, sidebandPack(inner), 'application/x-git-receive-pack-result');
      return;
    }
  }
  // Unpack first: ref validation (fast-forward checks) must see the new objects.
  for (const [oid, o] of incoming) r.objects.set(oid, o);
  // Validate + apply per ref, independently.
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const c of cmds) {
    const current = r.refs.get(c.ref);
    if (c.newOid === ZERO_OID) {
      if (current === undefined) { results.push({ ref: c.ref, ok: false, reason: 'remote ref does not exist' }); continue; }
      if (c.oldOid !== ZERO_OID && c.oldOid !== current) { results.push({ ref: c.ref, ok: false, reason: 'old value does not match' }); continue; }
      r.refs.delete(c.ref);
      results.push({ ref: c.ref, ok: true, reason: '' });
      continue;
    }
    const obj = r.objects.get(c.newOid) ?? incoming.get(c.newOid);
    if (!obj) { results.push({ ref: c.ref, ok: false, reason: 'missing object' }); continue; }
    if (c.oldOid === ZERO_OID) {
      if (current !== undefined) { results.push({ ref: c.ref, ok: false, reason: 'already exists' }); continue; }
    } else {
      if (current === undefined) { results.push({ ref: c.ref, ok: false, reason: 'remote ref does not exist' }); continue; }
      if (c.oldOid !== current) { results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      if (c.newOid !== current && obj.type === 'commit' && !isAncestor(r, current, c.newOid)) {
        results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' }); continue;
      }
      if (c.newOid !== current && obj.type !== 'commit' && c.ref.startsWith('refs/heads/')) {
        results.push({ ref: c.ref, ok: false, reason: 'not a commit' }); continue;
      }
    }
    r.refs.set(c.ref, c.newOid);
    results.push({ ref: c.ref, ok: true, reason: '' });
  }
  bump(r);
  const out: Buffer[] = [];
  // The report-status stream is itself pkt-lined (one pkt-line per line) and
  // rides inside sideband band 1; real git parses the band-1 bytes as
  // pkt-lines, it does not accept raw report text in one sideband packet.
  const inner = Buffer.concat(
    [...[`unpack ok\n`, ...results.map((x) => (x.ok ? `ok ${x.ref}\n` : `ng ${x.ref} ${x.reason}\n`))].map((l) => pktLine(l)), flushPkt()],
  );
  out.push(sidebandPack(inner));
  sendBuf(res, 200, Buffer.concat(out), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// REST v3 (/api/v3)
// ---------------------------------------------------------------------------
function authed(req: IncomingMessage): boolean {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return false;
  const tok = h.slice(7);
  if (TOKEN === '') return tok.length > 0;
  return tok === TOKEN;
}
function userJson(): Record<string, unknown> {
  return { login: VIEWER, id: VIEWER_ID, node_id: gid('User', VIEWER_ID), type: 'User', site_admin: false };
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: gid('Repository', r.id), name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    private: r.isPrivate, description: r.description,
    default_branch: r.defaultBranch, has_issues: true, fork: false,
    html_url: `https://github.com/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function issueJson(r: Repo, i: IssueRec): Record<string, unknown> {
  return {
    id: i.id, node_id: gid('Issue', r.id, i.number), number: i.number,
    title: i.title, body: i.body, state: i.state,
    labels: i.labels.map((n) => ({ name: n })),
    user: { login: VIEWER, id: VIEWER_ID },
    comments: (r.comments.get(i.number) ?? []).length,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
  };
}
function pullJson(r: Repo, p: PullRec): Record<string, unknown> {
  return {
    id: p.id, node_id: gid('PullRequest', r.id, p.number), number: p.number,
    title: p.title, body: p.body, state: p.state,
    head: { ref: p.head, sha: p.headSha, label: `${VIEWER}:${p.head}` },
    base: { ref: p.base, sha: p.baseSha, label: `${VIEWER}:${p.base}` },
    merged: p.merged, merged_at: p.mergedAt, merge_commit_sha: p.mergeSha,
    mergeable: p.merged ? true : null,
    user: { login: VIEWER, id: VIEWER_ID },
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
function paginate<T>(items: T[], url: URL, req: IncomingMessage): { page: T[]; link: string | null } {
  const perPage = Math.min(Math.max(parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30, 1), 100);
  const pageNum = Math.max(parseInt(url.searchParams.get('page') ?? '1', 10) || 1, 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const q = new URLSearchParams(url.searchParams);
    q.set('page', String(pageNum + 1));
    q.set('per_page', String(perPage));
    const host = req.headers.host ?? '127.0.0.1';
    link = `<http://${host}${url.pathname}?${q.toString()}>; rel="next"`;
  }
  return { page, link };
}
function getRepoOr404(owner: string, name: string): Repo {
  if (owner !== VIEWER) throw httpError(404, 'Not Found');
  const r = findRepo(owner, name);
  if (!r) throw httpError(404, 'Not Found');
  return r;
}
function parseIssueNumber(seg: string): number {
  const n = parseInt(seg, 10);
  if (Number.isNaN(n)) throw httpError(404, 'Not Found');
  return n;
}
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const segs = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  // segs[0] === 'api', segs[1] === 'v3'
  if (segs.length === 2) {
    if (method !== 'GET') throw httpError(404, 'Not Found');
    sendJson(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo' });
    return;
  }
  if (segs[2] === 'meta' && segs.length === 3) {
    if (method !== 'GET') throw httpError(404, 'Not Found');
    sendJson(res, 200, { installed_version: VERSION, verifiable_password_authentication: true });
    return;
  }
  if (segs[2] === 'user') {
    if (segs.length === 3) {
      if (method !== 'GET') throw httpError(404, 'Not Found');
      sendJson(res, 200, userJson());
      return;
    }
    if (segs[3] === 'repos') {
      if (method === 'GET') {
        const all = [...repos.values()].filter((r) => r.owner === VIEWER);
        const { page, link } = paginate(all.map(repoJson), url, req);
        sendJson(res, 200, page, link ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const name = String(body.name ?? '');
        if (!name) throw httpError(422, 'name is required');
        if (findRepo(VIEWER, name)) throw httpError(422, 'Repository already exists');
        const r = newRepo(name, String(body.description ?? ''), body.private === true);
        sendJson(res, 201, repoJson(r));
        return;
      }
      throw httpError(404, 'Not Found');
    }
    throw httpError(404, 'Not Found');
  }
  if (segs[2] === 'repos' && segs.length >= 4) {
    const owner = segs[3] as string;
    const name = segs[4] as string;
    const r = getRepoOr404(owner, name);
    const rest = segs.slice(5);
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(r)); return; }
      if (method === 'PATCH') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        if (typeof body.description === 'string') r.description = body.description;
        if (typeof body.default_branch === 'string') r.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(r));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        repoById.delete(r.id);
        res.writeHead(204, { 'x-github-request-id': `req-${++reqSeq}` });
        res.end();
        return;
      }
      throw httpError(404, 'Not Found');
    }
    const sub = rest[0] as string;
    if (sub === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') throw httpError(404, 'Not Found');
        const list = [...r.refs.keys()].filter((k) => k.startsWith('refs/heads/')).sort().map((k) => {
          const branch = k.slice('refs/heads/'.length);
          return { name: branch, commit: { sha: r.refs.get(k) } };
        });
        sendJson(res, 200, list);
        return;
      }
      const branch = rest.slice(1).join('/');
      const sha = headSha(r, branch);
      if (!sha) throw httpError(404, 'Not Found');
      if (method !== 'GET') throw httpError(404, 'Not Found');
      sendJson(res, 200, { name: branch, commit: { sha } });
      return;
    }
    if (sub === 'commits') {
      if (method !== 'GET') throw httpError(404, 'Not Found');
      const shaParam = url.searchParams.get('sha');
      const tip = shaParam ? resolveRef(r, shaParam) : headSha(r, r.defaultBranch);
      if (!tip) { sendJson(res, 200, []); return; }
      const walk: string[] = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length) {
        const cur = stack.shift() as string;
        if (seen.has(cur)) continue;
        seen.add(cur);
        walk.push(cur);
        const c = getCommit(r, cur);
        if (c) for (const p of c.parents) stack.push(p);
      }
      sendJson(res, 200, walk.map((oid) => {
        const c = getCommit(r, oid) as { tree: string; parents: string[]; message: string };
        return {
          sha: oid,
          commit: {
            message: commitMessage(r, oid),
            author: { name: VIEWER, email: VIEWER_EMAIL },
            committer: { name: VIEWER, email: VIEWER_EMAIL },
          },
          parents: c.parents.map((p) => ({ sha: p })),
        };
      }));
      return;
    }
    if (sub === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const ref = String(body.ref ?? '');
        const sha = String(body.sha ?? '');
        if (!ref.startsWith('refs/') || !isSha(sha) || !r.objects.has(sha)) throw httpError(422, 'Invalid ref or sha');
        if (r.refs.has(ref)) throw httpError(422, 'Reference already exists');
        r.refs.set(ref, sha);
        bump(r);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return;
      }
      if (method === 'GET') {
        const branch = rest.slice(3).join('/');
        if (rest[2] === 'heads' && branch) {
          const sha = headSha(r, branch);
          if (!sha) throw httpError(404, 'Not Found');
          sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
          return;
        }
        const all = sortedRefs(r).map(({ ref, oid }) => ({ ref, object: { sha: oid, type: 'commit' } }));
        sendJson(res, 200, all);
        return;
      }
      throw httpError(404, 'Not Found');
    }
    if (sub === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const refParam = url.searchParams.get('ref');
        const tip = refParam ? resolveRef(r, refParam) : headSha(r, r.defaultBranch);
        if (!tip) throw httpError(404, 'Not Found');
        const c = getCommit(r, tip);
        if (!c) throw httpError(404, 'Not Found');
        if (!path) throw httpError(404, 'Not Found');
        const node = treeAtPath(r, c.tree, path);
        if (!node) throw httpError(404, 'Not Found');
        if (node.mode === '40000') {
          const entries = treeEntries(r, node.oid).map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name, path: `${path}/${e.name}`, sha: e.oid,
            size: e.mode === '40000' ? 0 : (r.objects.get(e.oid)?.data.length ?? 0),
          }));
          sendJson(res, 200, entries);
          return;
        }
        const blob = r.objects.get(node.oid);
        if (!blob) throw httpError(404, 'Not Found');
        sendJson(res, 200, {
          type: 'file', encoding: 'base64', name: node.name, path,
          content: blob.data.toString('base64'), sha: node.oid, size: blob.data.length,
        });
        return;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const message = String(body.message ?? (method === 'PUT' ? `Update ${path}` : `Delete ${path}`));
        const branch = String(body.branch ?? r.defaultBranch);
        const tip = headSha(r, branch);
        const parentTree = tip ? (getCommit(r, tip)?.tree ?? null) : null;
        if (method === 'PUT') {
          const contentB64 = String(body.content ?? '');
          let content: Buffer;
          try { content = Buffer.from(contentB64, 'base64'); } catch { throw httpError(400, 'Invalid content'); }
          const cur = parentTree ? treeAtPath(r, parentTree, path) : null;
          if (body.sha !== undefined) {
            if (!cur || cur.oid !== String(body.sha)) throw httpError(409, 'sha does not match');
          }
          const blobOid = objectId('blob', content);
          r.objects.set(blobOid, { type: 'blob', data: content });
          const newTree = setPathInTree(r, parentTree, path, blobOid);
          const commitOid = storeCommit(r, newTree, tip ? [tip] : [], message);
          r.refs.set(`refs/heads/${branch}`, commitOid);
          bump(r);
          sendJson(res, cur ? 200 : 201, {
            content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: commitOid, message },
          });
          return;
        }
        // DELETE
        const cur = parentTree ? treeAtPath(r, parentTree, path) : null;
        if (!cur) throw httpError(404, 'Not Found');
        if (body.sha !== undefined && cur.oid !== String(body.sha)) throw httpError(409, 'sha does not match');
        if (!tip) throw httpError(404, 'Not Found');
        const newTree = setPathInTree(r, parentTree, path, null);
        const commitOid = storeCommit(r, newTree, [tip], message);
        r.refs.set(`refs/heads/${branch}`, commitOid);
        bump(r);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return;
      }
      throw httpError(404, 'Not Found');
    }
    if (sub === 'labels') {
      if (method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const name = String(body.name ?? '');
        if (!name) throw httpError(422, 'name is required');
        const color = String(body.color ?? 'ededed');
        r.labels.set(name, { name, color });
        sendJson(res, 201, { name, color });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...r.labels.values()]);
        return;
      }
      throw httpError(404, 'Not Found');
    }
    if (sub === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const title = String(body.title ?? '');
          if (!title) throw httpError(422, 'title is required');
          const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
          for (const l of labels) if (!r.labels.has(l)) throw httpError(422, `Label does not exist: ${l}`);
          const number = ++r.issueSeq;
          const rec: IssueRec = {
            id: r.id * 100000 + number, number, title,
            body: String(body.body ?? ''), state: 'open', labels, seq: number, _json: null,
          };
          r.issues.push(rec);
          sendJson(res, 201, issueJson(r, rec));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const dir = url.searchParams.get('direction') ?? 'desc';
          let list = [...r.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page, link } = paginate(list.map((i) => issueJson(r, i)), url, req);
          sendJson(res, 200, page, link ? { link } : {});
          return;
        }
        throw httpError(404, 'Not Found');
      }
      const num = parseIssueNumber(rest[1] as string);
      const issue = r.issues.find((i) => i.number === num);
      if (!issue) throw httpError(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') { sendBuf(res, 200, issueJsonBuf(r, issue), 'application/json; charset=utf-8'); return; }
        if (method === 'PATCH') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue._json = null;
          sendJson(res, 200, issueJson(r, issue));
          return;
        }
        throw httpError(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          const list = r.comments.get(num) ?? [];
          sendJson(res, 200, list.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER, id: VIEWER_ID } })));
          return;
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const rec: CommentRec = { id: ++commentSeq, body: String(body.body ?? '') };
          const arr = r.comments.get(num) ?? [];
          arr.push(rec);
          r.comments.set(num, arr);
          issue._json = null; // the comments count in the issue body changed
          sendJson(res, 201, { id: rec.id, node_id: gid('IssueComment', r.id, num, rec.id), body: rec.body, user: { login: VIEWER, id: VIEWER_ID } });
          return;
        }
        throw httpError(404, 'Not Found');
      }
      throw httpError(404, 'Not Found');
    }
    if (sub === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const title = String(body.title ?? '');
          const head = String(body.head ?? '');
          const base = String(body.base ?? '');
          if (!title || !head || !base) throw httpError(422, 'title, head and base are required');
          const headShaVal = headSha(r, head);
          const baseShaVal = headSha(r, base);
          if (!headShaVal || !baseShaVal) throw httpError(422, 'head or base branch not found');
          const number = ++r.pullSeq;
          const rec: PullRec = {
            id: r.id * 100000 + 50000 + number, number, title,
            body: String(body.body ?? ''), state: 'open', head, base,
            headSha: headShaVal, baseSha: baseShaVal, merged: false,
            mergeSha: null, mergedAt: null, seq: number,
          };
          r.pulls.push(rec);
          sendJson(res, 201, pullJson(r, rec));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = [...r.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { page, link } = paginate(list.map((p) => pullJson(r, p)), url, req);
          sendJson(res, 200, page, link ? { link } : {});
          return;
        }
        throw httpError(404, 'Not Found');
      }
      const num = parseIssueNumber(rest[1] as string);
      const pr = r.pulls.find((p) => p.number === num);
      if (!pr) throw httpError(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') { sendJson(res, 200, pullJson(r, pr)); return; }
        throw httpError(404, 'Not Found');
      }
      if (rest[2] === 'files') {
        if (method !== 'GET') throw httpError(404, 'Not Found');
        const base = mergeBase(r, pr.baseSha, pr.headSha) ?? pr.baseSha;
        sendJson(res, 200, diffFiles(r, base, pr.headSha));
        return;
      }
      if (rest[2] === 'merge') {
        if (method !== 'PUT') throw httpError(404, 'Not Found');
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const mergeMethod = String(body.merge_method ?? 'merge');
        if (pr.state !== 'open') throw httpError(405, 'Pull request is not open');
        const baseTip = headSha(r, pr.base);
        if (!baseTip) throw httpError(404, 'Not Found');
        const base = mergeBase(r, pr.baseSha, pr.headSha);
        if (!base) throw httpError(409, 'No merge base');
        const merged = threeWayMerge(r, base, pr.headSha, baseTip);
        if (!merged.ok) throw httpError(405, 'Merge conflict');
        const message = mergeMethod === 'squash'
          ? `${pr.title} (#${pr.number})`
          : `Merge pull request #${pr.number} from ${VIEWER}/${pr.head}`;
        const commitOid = storeCommit(r, merged.tree, [baseTip], message);
        r.refs.set(`refs/heads/${pr.base}`, commitOid);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergeSha = commitOid;
        pr.mergedAt = MERGED_AT;
        bump(r);
        sendJson(res, 200, { sha: commitOid, merged: true, message });
        return;
      }
      throw httpError(404, 'Not Found');
    }
    throw httpError(404, 'Not Found');
  }
  throw httpError(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL (/api/graphql) — hand-written parser + executor
// ---------------------------------------------------------------------------
type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue } | { __var: string };
interface GqlField {
  kind: 'field'; alias: string | null; name: string;
  args: { [k: string]: GqlValue }; selections: GqlSelection[] | null;
}
interface GqlFragment { kind: 'fragment'; typeCondition: string | null; selections: GqlSelection[]; }
type GqlSelection = GqlField | GqlFragment;
interface GqlOp {
  type: 'query' | 'mutation'; name: string | null;
  variables: { name: string; type: string; defaultValue?: GqlValue }[];
  selections: GqlSelection[];
}
class GqlTokenizer {
  s: string; i = 0;
  constructor(s: string) { this.s = s; }
  skipWs(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { this.i++; continue; }
      if (c === '#') { while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++; continue; }
      break;
    }
  }
  peek(): string { this.skipWs(); return this.s[this.i] ?? ''; }
  nextName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`expected name at ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  nextNumber(): number {
    this.skipWs();
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`expected number at ${this.i}`);
    this.i += m[0].length;
    return Number(m[0]);
  }
  nextString(): string {
    this.skipWs();
    if (this.s[this.i] !== '"') throw new Error(`expected string at ${this.i}`);
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      if (c === '"') { this.i++; return out; }
      if (c === '\\') {
        const n = this.s[this.i + 1] as string;
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (n === 'u') { out += String.fromCharCode(parseInt(this.s.slice(this.i + 2, this.i + 6), 16)); this.i += 6; continue; }
        out += map[n] ?? n;
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
    throw new Error('unterminated string');
  }
  expect(ch: string): void {
    this.skipWs();
    if (this.s[this.i] !== ch) throw new Error(`expected '${ch}' at ${this.i}, got '${this.s[this.i] ?? ''}'`);
    this.i++;
  }
  try(ch: string): boolean {
    this.skipWs();
    if (this.s[this.i] === ch) { this.i++; return true; }
    return false;
  }
  trySpread(): boolean {
    this.skipWs();
    if (this.s.startsWith('...', this.i)) { this.i += 3; return true; }
    return false;
  }
}
function parseValue(t: GqlTokenizer): GqlValue {
  const c = t.peek();
  if (c === '"') return t.nextString();
  if (c === '$') { t.i++; return { __var: t.nextName() }; }
  if (c === '[') {
    t.expect('[');
    const arr: GqlValue[] = [];
    while (!t.try(']')) arr.push(parseValue(t));
    return arr;
  }
  if (c === '{') {
    t.expect('{');
    const obj: { [k: string]: GqlValue } = {};
    while (!t.try('}')) {
      const k = t.nextName();
      t.expect(':');
      obj[k] = parseValue(t);
    }
    return obj;
  }
  if (c === '-' || (c >= '0' && c <= '9')) return t.nextNumber();
  const name = t.nextName();
  if (name === 'true') return true;
  if (name === 'false') return false;
  if (name === 'null') return null;
  return name; // enum
}
function parseType(t: GqlTokenizer): string {
  let ty = '';
  if (t.try('[')) { ty = `[${parseType(t)}]`; t.expect(']'); }
  else ty = t.nextName();
  if (t.try('!')) ty += '!';
  return ty;
}
function parseSelections(t: GqlTokenizer): GqlSelection[] {
  t.expect('{');
  const out: GqlSelection[] = [];
  while (!t.try('}')) {
    if (t.trySpread()) {
      let typeCondition: string | null = null;
      if (t.peek() !== '{') {
        const kw = t.nextName();
        if (kw === 'on') typeCondition = t.nextName();
        else throw new Error(`unsupported fragment spread ${kw}`);
      }
      out.push({ kind: 'fragment', typeCondition, selections: parseSelections(t) });
      continue;
    }
    const first = t.nextName();
    let alias: string | null = null;
    let name = first;
    if (t.try(':')) { alias = first; name = t.nextName(); }
    const args: { [k: string]: GqlValue } = {};
    if (t.try('(')) {
      while (!t.try(')')) {
        const k = t.nextName();
        t.expect(':');
        args[k] = parseValue(t);
      }
    }
    let selections: GqlSelection[] | null = null;
    if (t.peek() === '{') selections = parseSelections(t);
    out.push({ kind: 'field', alias, name, args, selections });
  }
  return out;
}
function parseDocument(src: string): GqlOp[] {
  const t = new GqlTokenizer(src);
  const ops: GqlOp[] = [];
  while (true) {
    t.skipWs();
    if (t.i >= t.s.length) break;
    let type: 'query' | 'mutation' = 'query';
    const c = t.peek();
    if (c === '{') {
      ops.push({ type, name: null, variables: [], selections: parseSelections(t) });
      continue;
    }
    const kw = t.nextName();
    if (kw === 'query' || kw === 'mutation') type = kw as 'query' | 'mutation';
    else throw new Error(`unsupported operation ${kw}`);
    let name: string | null = null;
    if (t.peek() !== '(' && t.peek() !== '{') name = t.nextName();
    const variables: GqlOp['variables'] = [];
    if (t.try('(')) {
      while (!t.try(')')) {
        t.expect('$');
        const vname = t.nextName();
        t.expect(':');
        const vtype = parseType(t);
        let defaultValue: GqlValue | undefined;
        if (t.try('=')) defaultValue = parseValue(t);
        variables.push({ name: vname, type: vtype, defaultValue });
      }
    }
    ops.push({ type, name, variables, selections: parseSelections(t) });
  }
  return ops;
}
function resolveValue(v: GqlValue, vars: { [k: string]: unknown }): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if ('__var' in v) {
      const name = (v as { __var: string }).__var;
      return vars[name];
    }
    const out: { [k: string]: unknown } = {};
    for (const [k, val] of Object.entries(v as { [k: string]: GqlValue })) out[k] = resolveValue(val, vars);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, vars));
  return v;
}
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};
const TYPE_ENUMS: Record<string, string[]> = { SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'] };
interface GqlCtx { errors: { message: string }[]; }
function fieldError(ctx: GqlCtx, parentType: string, name: string): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
  return null;
}
function issueNode(r: Repo, i: IssueRec): Record<string, unknown> {
  return { __type: 'Issue', __repo: r, __issue: i };
}
function pullNode(r: Repo, p: PullRec): Record<string, unknown> {
  return { __type: 'PullRequest', __repo: r, __pull: p };
}
function repoNode(r: Repo): Record<string, unknown> {
  return { __type: 'Repository', __repo: r };
}
function cursorFor(n: number): string { return Buffer.from(`issue-cursor:${n}`, 'utf8').toString('base64'); }
function cursorNum(c: string | undefined): number {
  if (!c) return 0;
  try {
    const s = Buffer.from(c, 'base64').toString('utf8');
    const m = /^issue-cursor:(\d+)$/.exec(s);
    return m ? parseInt(m[1] as string, 10) : 0;
  } catch { return 0; }
}
function executeSelections(parentType: string, parent: Record<string, unknown> | null, sels: GqlSelection[], vars: { [k: string]: unknown }, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(parentType, parent, sel.selections, vars, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = executeField(parentType, parent, sel, vars, ctx);
  }
  return out;
}
function executeField(parentType: string, parent: Record<string, unknown> | null, field: GqlField, vars: { [k: string]: unknown }, ctx: GqlCtx): unknown {
  const args: { [k: string]: unknown } = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, vars);
  const sub = field.selections;
  if (parentType === 'Query') {
    switch (field.name) {
      case 'viewer': {
        const v = { __type: 'User', login: VIEWER };
        return sub ? executeSelections('User', v, sub, vars, ctx) : v;
      }
      case 'repository': {
        const r = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!r) return null;
        const node = repoNode(r);
        return sub ? executeSelections('Repository', node, sub, vars, ctx) : node;
      }
      case 'node': {
        const parsed = parseGid(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const r = repoByDbId(parseInt(parsed.parts[0] as string, 10));
          if (!r) return null;
          const node = repoNode(r);
          return sub ? executeSelections('Repository', node, sub, vars, ctx) : node;
        }
        if (parsed.kind === 'Issue') {
          const r = repoByDbId(parseInt(parsed.parts[0] as string, 10));
          const n = parseInt(parsed.parts[1] as string, 10);
          const i = r?.issues.find((x) => x.number === n);
          if (!r || !i) return null;
          const node = issueNode(r, i);
          return sub ? executeSelections('Issue', node, sub, vars, ctx) : node;
        }
        if (parsed.kind === 'PullRequest') {
          const r = repoByDbId(parseInt(parsed.parts[0] as string, 10));
          const n = parseInt(parsed.parts[1] as string, 10);
          const p = r?.pulls.find((x) => x.number === n);
          if (!r || !p) return null;
          const node = pullNode(r, p);
          return sub ? executeSelections('PullRequest', node, sub, vars, ctx) : node;
        }
        return null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        const fields = TYPE_FIELDS[name] ?? [];
        const enums = TYPE_ENUMS[name];
        const v: Record<string, unknown> = { __type: '__Type', name };
        if (!sub) return v;
        const out: Record<string, unknown> = {};
        for (const s of sub) {
          if (s.kind === 'fragment') { Object.assign(out, executeSelections('__Type', v, s.selections, vars, ctx)); continue; }
          if (s.name === 'name') out[s.alias ?? 'name'] = name;
          else if (s.name === 'fields') out[s.alias ?? 'fields'] = fields.map((f) => ({ name: f }));
          else if (s.name === 'enumValues') out[s.alias ?? 'enumValues'] = enums ? enums.map((e) => ({ name: e })) : null;
          else fieldError(ctx, '__Type', s.name);
        }
        return out;
      }
      case '__schema': return sub ? executeSelections('__Schema', { __type: '__Schema' }, sub, vars, ctx) : { __type: '__Schema' };
      default: return fieldError(ctx, 'Query', field.name);
    }
  }
  if (parentType === 'Mutation') {
    switch (field.name) {
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const r = repoFromIdInput(input.repositoryId);
        if (!r) throw httpError(404, 'Not Found');
        const number = ++r.issueSeq;
        const rec: IssueRec = {
          id: r.id * 100000 + number, number, title: String(input.title ?? ''),
          body: String(input.body ?? ''), state: 'open', labels: [], seq: number, _json: null,
        };
        r.issues.push(rec);
        const v = { __type: 'CreateIssuePayload', __repo: r, __issue: rec };
        return sub ? executeSelections('CreateIssuePayload', v, sub, vars, ctx) : v;
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.issueId ?? ''));
        if (!parsed || parsed.kind !== 'Issue') throw httpError(404, 'Not Found');
        const r = repoByDbId(parseInt(parsed.parts[0] as string, 10));
        const i = r?.issues.find((x) => x.number === parseInt(parsed.parts[1] as string, 10));
        if (!r || !i) throw httpError(404, 'Not Found');
        i.state = 'closed';
        i._json = null;
        const v = { __type: 'CloseIssuePayload', __repo: r, __issue: i };
        return sub ? executeSelections('CloseIssuePayload', v, sub, vars, ctx) : v;
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const r = repoFromIdInput(input.repositoryId);
        if (!r) throw httpError(404, 'Not Found');
        const headShaVal = headSha(r, String(input.headRefName ?? ''));
        const baseShaVal = headSha(r, String(input.baseRefName ?? ''));
        if (!headShaVal || !baseShaVal) throw httpError(422, 'head or base branch not found');
        const number = ++r.pullSeq;
        const rec: PullRec = {
          id: r.id * 100000 + 50000 + number, number, title: String(input.title ?? ''),
          body: '', state: 'open', head: String(input.headRefName ?? ''), base: String(input.baseRefName ?? ''),
          headSha: headShaVal, baseSha: baseShaVal, merged: false, mergeSha: null, mergedAt: null, seq: number,
        };
        r.pulls.push(rec);
        const v = { __type: 'CreatePullRequestPayload', __repo: r, __pull: rec };
        return sub ? executeSelections('CreatePullRequestPayload', v, sub, vars, ctx) : v;
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.pullRequestId ?? ''));
        if (!parsed || parsed.kind !== 'PullRequest') throw httpError(404, 'Not Found');
        const r = repoByDbId(parseInt(parsed.parts[0] as string, 10));
        const p = r?.pulls.find((x) => x.number === parseInt(parsed.parts[1] as string, 10));
        if (!r || !p) throw httpError(404, 'Not Found');
        const baseTip = headSha(r, p.base);
        if (!baseTip) throw httpError(404, 'Not Found');
        const base = mergeBase(r, p.baseSha, p.headSha);
        if (!base) throw httpError(409, 'No merge base');
        const merged = threeWayMerge(r, base, p.headSha, baseTip);
        if (!merged.ok) throw httpError(405, 'Merge conflict');
        const commitOid = storeCommit(r, merged.tree, [baseTip], `${p.title} (#${p.number})`);
        r.refs.set(`refs/heads/${p.base}`, commitOid);
        p.state = 'closed';
        p.merged = true;
        p.mergeSha = commitOid;
        p.mergedAt = MERGED_AT;
        bump(r);
        const v = { __type: 'MergePullRequestPayload', __repo: r, __pull: p };
        return sub ? executeSelections('MergePullRequestPayload', v, sub, vars, ctx) : v;
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGid(String(input.subjectId ?? ''));
        if (!parsed) throw httpError(404, 'Not Found');
        let r: Repo | null = null;
        let issueNum = 0;
        if (parsed.kind === 'Issue') {
          r = repoByDbId(parseInt(parsed.parts[0] as string, 10));
          issueNum = parseInt(parsed.parts[1] as string, 10);
        } else if (parsed.kind === 'PullRequest') {
          r = repoByDbId(parseInt(parsed.parts[0] as string, 10));
          issueNum = parseInt(parsed.parts[1] as string, 10);
        }
        if (!r) throw httpError(404, 'Not Found');
        const rec: CommentRec = { id: ++commentSeq, body: String(input.body ?? '') };
        const arr = r.comments.get(issueNum) ?? [];
        arr.push(rec);
        r.comments.set(issueNum, arr);
        const v = { __type: 'AddCommentPayload', __repo: r, __comment: rec, __issueNum: issueNum };
        return sub ? executeSelections('AddCommentPayload', v, sub, vars, ctx) : v;
      }
      default: return fieldError(ctx, 'Mutation', field.name);
    }
  }
  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    const i = (parent as Record<string, unknown>).__issue as IssueRec;
    const r = (parent as Record<string, unknown>).__repo as Repo;
    if (field.name === 'issue') {
      const node = issueNode(r, i);
      return sub ? executeSelections('Issue', node, sub, vars, ctx) : node;
    }
    return fieldError(ctx, parentType, field.name);
  }
  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    const p = (parent as Record<string, unknown>).__pull as PullRec;
    const r = (parent as Record<string, unknown>).__repo as Repo;
    if (field.name === 'pullRequest') {
      const node = pullNode(r, p);
      return sub ? executeSelections('PullRequest', node, sub, vars, ctx) : node;
    }
    return fieldError(ctx, parentType, field.name);
  }
  if (parentType === 'AddCommentPayload') {
    const c = (parent as Record<string, unknown>).__comment as CommentRec;
    const r = (parent as Record<string, unknown>).__repo as Repo;
    const n = (parent as Record<string, unknown>).__issueNum as number;
    if (field.name === 'commentEdge') {
      const node = { __type: 'IssueComment', __repo: r, __comment: c, __issueNum: n };
      const edge = { __type: 'IssueCommentEdge', __node: node };
      return sub ? executeSelections('IssueCommentEdge', edge, sub, vars, ctx) : edge;
    }
    return fieldError(ctx, parentType, field.name);
  }
  if (parentType === 'Repository') {
    const r = (parent as Record<string, unknown>).__repo as Repo;
    switch (field.name) {
      case 'id': return gid('Repository', r.id);
      case 'databaseId': return r.id;
      case 'name': return r.name;
      case 'nameWithOwner': return `${r.owner}/${r.name}`;
      case 'owner': {
        const v = { __type: 'User', login: r.owner };
        return sub ? executeSelections('User', v, sub, vars, ctx) : v;
      }
      case 'defaultBranchRef': {
        const tip = headSha(r, r.defaultBranch);
        if (!tip) return null;
        const v = { __type: 'Ref', name: r.defaultBranch };
        return sub ? executeSelections('Ref', v, sub, vars, ctx) : v;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'issue': {
        const i = r.issues.find((x) => x.number === Number(args.number));
        if (!i) return null;
        const node = issueNode(r, i);
        return sub ? executeSelections('Issue', node, sub, vars, ctx) : node;
      }
      case 'issues': {
        let list = [...r.issues];
        const states = args.states as string[] | undefined;
        if (states && states.length) {
          const want = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => want.has(i.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT') {
          list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        } else list.sort((a, b) => a.seq - b.seq);
        const after = cursorNum(args.after as string | undefined);
        if (orderBy?.direction === 'DESC') list = list.filter((i) => i.number < after || after === 0);
        else list = list.filter((i) => i.number > after);
        const first = args.first !== undefined ? Number(args.first) : 30;
        const page = list.slice(0, first);
        const hasNext = list.length > first;
        const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
        const conn = { __type: 'IssueConnection', __nodes: page.map((i) => issueNode(r, i)), __pageInfo: { hasNextPage: hasNext, endCursor } };
        if (!sub) return conn;
        const out: Record<string, unknown> = {};
        for (const s of sub) {
          if (s.kind === 'fragment') { Object.assign(out, executeSelections('IssueConnection', conn, s.selections, vars, ctx)); continue; }
          if (s.name === 'nodes') {
            out[s.alias ?? 'nodes'] = (conn.__nodes as Record<string, unknown>[]).map((n) => (s.selections ? executeSelections('Issue', n, s.selections, vars, ctx) : n));
          } else if (s.name === 'edges') {
            out[s.alias ?? 'edges'] = (conn.__nodes as Record<string, unknown>[]).map((n) => {
              const e = { __type: 'IssueEdge', __node: n };
              return s.selections ? executeSelections('IssueEdge', e, s.selections, vars, ctx) : e;
            });
          } else if (s.name === 'pageInfo') {
            out[s.alias ?? 'pageInfo'] = s.selections ? executeSelections('PageInfo', conn.__pageInfo as unknown as Record<string, unknown>, s.selections, vars, ctx) : conn.__pageInfo;
          } else if (s.name === 'totalCount') out[s.alias ?? 'totalCount'] = list.length;
          else fieldError(ctx, 'IssueConnection', s.name);
        }
        return out;
      }
      case 'pullRequests': {
        const first = args.first !== undefined ? Number(args.first) : 30;
        const page = r.pulls.slice(0, first);
        const conn = { __type: 'PullRequestConnection', __nodes: page.map((p) => pullNode(r, p)), __pageInfo: { hasNextPage: r.pulls.length > first, endCursor: null } };
        if (!sub) return conn;
        const out: Record<string, unknown> = {};
        for (const s of sub) {
          if (s.kind === 'fragment') { Object.assign(out, executeSelections('PullRequestConnection', conn, s.selections, vars, ctx)); continue; }
          if (s.name === 'nodes') {
            out[s.alias ?? 'nodes'] = (conn.__nodes as Record<string, unknown>[]).map((n) => (s.selections ? executeSelections('PullRequest', n, s.selections, vars, ctx) : n));
          } else if (s.name === 'pageInfo') {
            out[s.alias ?? 'pageInfo'] = s.selections ? executeSelections('PageInfo', conn.__pageInfo as unknown as Record<string, unknown>, s.selections, vars, ctx) : conn.__pageInfo;
          } else if (s.name === 'totalCount') out[s.alias ?? 'totalCount'] = r.pulls.length;
          else fieldError(ctx, 'PullRequestConnection', s.name);
        }
        return out;
      }
      case 'pullRequest': {
        const p = r.pulls.find((x) => x.number === Number(args.number));
        if (!p) return null;
        const node = pullNode(r, p);
        return sub ? executeSelections('PullRequest', node, sub, vars, ctx) : node;
      }
      default: return fieldError(ctx, 'Repository', field.name);
    }
  }
  if (parentType === 'Issue') {
    const i = (parent as Record<string, unknown>).__issue as IssueRec;
    const r = (parent as Record<string, unknown>).__repo as Repo;
    switch (field.name) {
      case 'id': return gid('Issue', r.id, i.number);
      case 'number': return i.number;
      case 'title': return i.title;
      case 'state': return i.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return i.body;
      default: return fieldError(ctx, 'Issue', field.name);
    }
  }
  if (parentType === 'PullRequest') {
    const p = (parent as Record<string, unknown>).__pull as PullRec;
    const r = (parent as Record<string, unknown>).__repo as Repo;
    switch (field.name) {
      case 'id': return gid('PullRequest', r.id, p.number);
      case 'number': return p.number;
      case 'title': return p.title;
      case 'state': return p.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return p.merged;
      case 'headRefName': return p.head;
      case 'baseRefName': return p.base;
      case 'mergeable': {
        if (p.merged) return 'MERGED';
        const base = mergeBase(r, p.baseSha, p.headSha);
        if (!base) return 'UNKNOWN';
        const tip = headSha(r, p.base);
        if (!tip) return 'UNKNOWN';
        return threeWayMerge(r, base, p.headSha, tip).ok ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'files': {
        const base = mergeBase(r, p.baseSha, p.headSha) ?? p.baseSha;
        const diffs = diffFiles(r, base, p.headSha);
        const conn = { __type: 'FileConnection', __nodes: diffs.map((d) => ({ __type: 'PullRequestChangedFile', path: d.filename })) };
        if (!sub) return conn;
        const out: Record<string, unknown> = {};
        for (const s of sub) {
          if (s.kind === 'fragment') { Object.assign(out, executeSelections('FileConnection', conn, s.selections, vars, ctx)); continue; }
          if (s.name === 'nodes') {
            out[s.alias ?? 'nodes'] = (conn.__nodes as Record<string, unknown>[]).map((n) => (s.selections ? executeSelections('PullRequestChangedFile', n, s.selections, vars, ctx) : n));
          } else fieldError(ctx, 'FileConnection', s.name);
        }
        return out;
      }
      default: return fieldError(ctx, 'PullRequest', field.name);
    }
  }
  if (parentType === 'User') {
    if (field.name === 'login') return (parent as Record<string, unknown>).login ?? VIEWER;
    return fieldError(ctx, 'User', field.name);
  }
  if (parentType === 'Ref') {
    if (field.name === 'name') return (parent as Record<string, unknown>).name ?? rName(parent);
    return fieldError(ctx, 'Ref', field.name);
  }
  if (parentType === 'PageInfo') {
    const pi = parent as unknown as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return pi.hasNextPage;
    if (field.name === 'endCursor') return pi.endCursor;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return pi.endCursor;
    return fieldError(ctx, 'PageInfo', field.name);
  }
  if (parentType === 'IssueEdge' || parentType === 'PullRequestEdge') {
    const node = (parent as Record<string, unknown>).__node as Record<string, unknown>;
    if (field.name === 'node') {
      const t = parentType === 'IssueEdge' ? 'Issue' : 'PullRequest';
      return sub ? executeSelections(t, node, sub, vars, ctx) : node;
    }
    if (field.name === 'cursor') return '';
    return fieldError(ctx, parentType, field.name);
  }
  if (parentType === 'IssueCommentEdge') {
    const node = (parent as Record<string, unknown>).__node as Record<string, unknown>;
    if (field.name === 'node') {
      return sub ? executeSelections('IssueComment', node, sub, vars, ctx) : node;
    }
    return fieldError(ctx, 'IssueCommentEdge', field.name);
  }
  if (parentType === 'IssueComment') {
    const c = (parent as Record<string, unknown>).__comment as CommentRec;
    const r = (parent as Record<string, unknown>).__repo as Repo;
    const n = (parent as Record<string, unknown>).__issueNum as number;
    if (field.name === 'id') return gid('IssueComment', r.id, n, c.id);
    if (field.name === 'body') return c.body;
    return fieldError(ctx, 'IssueComment', field.name);
  }
  if (parentType === 'PullRequestChangedFile') {
    if (field.name === 'path') return (parent as Record<string, unknown>).path ?? '';
    return fieldError(ctx, 'PullRequestChangedFile', field.name);
  }
  if (parentType === '__Type') {
    if (field.name === 'name') return (parent as Record<string, unknown>).name ?? '';
    if (field.name === 'fields') {
      const fields = TYPE_FIELDS[String((parent as Record<string, unknown>).name ?? '')] ?? [];
      return fields.map((f) => ({ name: f }));
    }
    if (field.name === 'enumValues') {
      const enums = TYPE_ENUMS[String((parent as Record<string, unknown>).name ?? '')];
      return enums ? enums.map((e) => ({ name: e })) : null;
    }
    return fieldError(ctx, '__Type', field.name);
  }
  return fieldError(ctx, parentType, field.name);
}
function rName(parent: Record<string, unknown>): string {
  return String((parent as Record<string, unknown>).name ?? '');
}
function executeOperation(op: GqlOp, variables: { [k: string]: unknown }): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: GqlCtx = { errors: [] };
  const vars: { [k: string]: unknown } = { ...variables };
  for (const v of op.variables) if (vars[v.name] === undefined && v.defaultValue !== undefined) vars[v.name] = resolveValue(v.defaultValue, vars);
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, null, op.selections, vars, ctx);
  const out: { data: Record<string, unknown>; errors?: { message: string }[] } = { data };
  if (ctx.errors.length) out.errors = ctx.errors;
  return out;
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  let requests: { query?: string; variables?: { [k: string]: unknown }; operationName?: string }[];
  const isBatch = Array.isArray(body);
  if (isBatch) requests = body as typeof requests;
  else if (body && typeof body === 'object') requests = [body as (typeof requests)[0]];
  else throw httpError(400, 'Invalid GraphQL request');
  const results = requests.map((r) => {
    if (!r || typeof r.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    let ops: GqlOp[];
    try { ops = parseDocument(r.query); } catch (e) { return { data: null, errors: [{ message: `GraphQL parse error: ${(e as Error).message}` }] }; }
    let op = ops[0] as GqlOp | undefined;
    if (r.operationName) op = ops.find((o) => o.name === r.operationName) ?? op;
    if (!op) return { data: null, errors: [{ message: 'no operation' }] };
    try { return executeOperation(op, (r.variables ?? {}) as { [k: string]: unknown }); }
    catch (e) {
      if ((e as { status?: number }).status === 404) return { data: null, errors: [{ message: (e as Error).message }] };
      throw e;
    }
  });
  sendJson(res, 200, isBatch ? results : results[0]);
}

// ---------------------------------------------------------------------------
// MCP (/mcp) — JSON-RPC 2.0 Streamable HTTP, protocol 2026-07-28
// ---------------------------------------------------------------------------
const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'github-core-forge', version: VERSION };
interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; }
const MCP_TOOLS: McpTool[] = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'], additionalProperties: false } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'], additionalProperties: false } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'], additionalProperties: false } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'], additionalProperties: false } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'], additionalProperties: false } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash merge.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'], additionalProperties: false } },
];
function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function mcpToolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}
function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function missingArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = args[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.length === 0)) return k;
  }
  return null;
}
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const miss = missingArg(args, ['name']);
      if (miss) throw { code: -32602, message: `Missing required argument: ${miss}` };
      const rname = String(args.name);
      if (findRepo(VIEWER, rname)) return mcpToolError(`Repository ${VIEWER}/${rname} already exists`);
      const r = newRepo(rname, String(args.description ?? ''), args.private === true);
      return mcpToolResult(repoJson(r));
    }
    case 'get_repo': {
      const miss = missingArg(args, ['owner', 'repo']);
      if (miss) throw { code: -32602, message: `Missing required argument: ${miss}` };
      const r = findRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolError(`Repository ${args.owner}/${args.repo} not found`);
      return mcpToolResult(repoJson(r));
    }
    case 'create_issue': {
      const miss = missingArg(args, ['owner', 'repo', 'title']);
      if (miss) throw { code: -32602, message: `Missing required argument: ${miss}` };
      const r = findRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolError(`Repository ${args.owner}/${args.repo} not found`);
      const number = ++r.issueSeq;
      const rec: IssueRec = {
        id: r.id * 100000 + number, number, title: String(args.title),
        body: String(args.body ?? ''), state: 'open', labels: [], seq: number, _json: null,
      };
      r.issues.push(rec);
      return mcpToolResult(issueJson(r, rec));
    }
    case 'list_issues': {
      const miss = missingArg(args, ['owner', 'repo']);
      if (miss) throw { code: -32602, message: `Missing required argument: ${miss}` };
      const r = findRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolError(`Repository ${args.owner}/${args.repo} not found`);
      const state = String(args.state ?? 'open');
      const list = state === 'all' ? r.issues : r.issues.filter((i) => i.state === state);
      return mcpToolResult({ issues: list.map((i) => issueJson(r, i)) });
    }
    case 'create_pull_request': {
      const miss = missingArg(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (miss) throw { code: -32602, message: `Missing required argument: ${miss}` };
      const r = findRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolError(`Repository ${args.owner}/${args.repo} not found`);
      const headShaVal = headSha(r, String(args.head));
      const baseShaVal = headSha(r, String(args.base));
      if (!headShaVal || !baseShaVal) return mcpToolError('head or base branch not found');
      const number = ++r.pullSeq;
      const rec: PullRec = {
        id: r.id * 100000 + 50000 + number, number, title: String(args.title),
        body: '', state: 'open', head: String(args.head), base: String(args.base),
        headSha: headShaVal, baseSha: baseShaVal, merged: false, mergeSha: null, mergedAt: null, seq: number,
      };
      r.pulls.push(rec);
      return mcpToolResult(pullJson(r, rec));
    }
    case 'merge_pull_request': {
      const miss = missingArg(args, ['owner', 'repo', 'pull_number']);
      if (miss) throw { code: -32602, message: `Missing required argument: ${miss}` };
      const r = findRepo(String(args.owner), String(args.repo));
      if (!r) return mcpToolError(`Repository ${args.owner}/${args.repo} not found`);
      const p = r.pulls.find((x) => x.number === Number(args.pull_number));
      if (!p) return mcpToolError(`Pull request #${args.pull_number} not found`);
      if (p.state !== 'open') return mcpToolError('Pull request is not open');
      const baseTip = headSha(r, p.base);
      if (!baseTip) return mcpToolError('Base branch not found');
      const base = mergeBase(r, p.baseSha, p.headSha);
      if (!base) return mcpToolError('No merge base');
      const merged = threeWayMerge(r, base, p.headSha, baseTip);
      if (!merged.ok) return mcpToolError('Merge conflict');
      const commitOid = storeCommit(r, merged.tree, [baseTip], `${p.title} (#${p.number})`);
      r.refs.set(`refs/heads/${p.base}`, commitOid);
      p.state = 'closed';
      p.merged = true;
      p.mergeSha = commitOid;
      p.mergedAt = MERGED_AT;
      bump(r);
      return mcpToolResult({ merged: true, sha: commitOid, number: p.number, state: 'closed' });
    }
    default:
      throw { code: -32601, message: `Method not found: ${name}` };
  }
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') { res.writeHead(200); res.end(); return; }
  if (method !== 'POST') throw httpError(405, 'Method not allowed');
  const raw = await readBody(req);
  let rpc: Record<string, unknown>;
  try { rpc = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
  catch { sendJson(res, 400, mcpError(null, -32700, 'Parse error')); return; }
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) {
    sendJson(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return;
  }
  const id = rpc.id ?? null;
  const rpcMethod = String(rpc.method ?? '');
  if (rpcMethod.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
  const params = (rpc.params ?? {}) as Record<string, unknown>;
  try {
    switch (rpcMethod) {
      case 'server/discover': {
        sendJson(res, 200, mcpResult(id, {
          supportedVersions: MCP_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          instructions: 'A GitHub-compatible git forge. Tools create repos, issues and pull requests over the shared store.',
        }));
        return;
      }
      case 'initialize': {
        const requested = String((params.protocolVersion as string | undefined) ?? '');
        const protocolVersion = MCP_VERSIONS.includes(requested) ? requested : '2025-11-25';
        sendJson(res, 200, mcpResult(id, {
          protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO,
        }));
        return;
      }
      case 'ping': {
        sendJson(res, 200, mcpResult(id, {}));
        return;
      }
      case 'tools/list': {
        sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
        return;
      }
      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = mcpCallTool(name, args);
        sendJson(res, 200, mcpResult(id, result));
        return;
      }
      default:
        sendJson(res, 200, mcpError(id, -32601, `Method not found: ${rpcMethod}`));
        return;
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e) {
      const err = e as { code: number; message: string };
      sendJson(res, 200, mcpError(id, err.code, err.message));
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Router / app
// ---------------------------------------------------------------------------
export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const path = url.pathname;
      if (path === '/healthz') {
        if ((req.method ?? 'GET') !== 'GET') throw httpError(404, 'Not Found');
        sendJson(res, 200, { ok: true, version: VERSION });
        return;
      }
      const segs = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segs.length >= 3 && (segs[2] === 'info' || segs[2] === 'git-upload-pack' || segs[2] === 'git-receive-pack')) {
        const owner = segs[0] as string;
        const repoSeg = segs[1] as string;
        if (!repoSeg.endsWith('.git')) throw httpError(404, 'Not Found');
        const repoName = repoSeg.slice(0, -4);
        const r = findRepo(owner, repoName);
        if (!r) throw httpError(404, 'Not Found');
        if (segs[2] === 'info' && segs[3] === 'refs') {
          const service = url.searchParams.get('service') ?? '';
          if (service === 'git-upload-pack' || service === 'git-receive-pack') {
            if ((req.headers['git-protocol'] ?? '') === 'version=2') handleInfoRefsV2(r, service, res);
            else handleInfoRefs(r, service, res);
          } else throw httpError(400, 'service required');
          return;
        }
        if (segs[2] === 'git-upload-pack') {
          const body = await readBody(req);
          if ((req.headers['git-protocol'] ?? '') === 'version=2') handleUploadPackV2(r, body, res);
          else handleUploadPackV0(r, body, res);
          return;
        }
        if (segs[2] === 'git-receive-pack') {
          const body = await readBody(req);
          handleReceivePack(r, body, res);
          return;
        }
        throw httpError(404, 'Not Found');
      }
      // Authenticated surfaces
      if (path === '/api/graphql' || path.startsWith('/api/v3') || path === '/mcp') {
        if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        if (path === '/api/graphql') { await handleGraphQL(req, res); return; }
        if (path === '/mcp') { await handleMcp(req, res); return; }
        await handleRest(req, res, url);
        return;
      }
      throw httpError(404, 'Not Found');
    } catch (e) {
      if (!res.headersSent) {
        const status = (e as { status?: number }).status ?? 500;
        const message = (e as Error).message ?? 'Internal server error';
        sendJson(res, status, { message });
      } else {
        res.end();
      }
    }
  });
  return server;
}
