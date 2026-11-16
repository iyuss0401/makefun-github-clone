// The forge's in-memory store: repositories as git object databases plus refs, and the GitHub-style
// metadata (issues, pulls, labels, comments) layered on top. All persistence is process memory — the
// trial pod runs one process for one suite run, and the rules require no outside service.

import {
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  TYPE_CODE,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git-objects.ts';

export const DEFAULT_BRANCH = 'main';

export interface IssueLabel {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
  comments: Array<{ id: number; body: string; user: string; createdAt: string }>;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  createdAt: string;
  user: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, IssueLabel>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface Identity {
  login: string;
  name: string;
  email: string;
}

let nextRepoId = 5000;
let nextGlobalIssueId = 10_000;
let nextGlobalPullId = 20_000;
let nextGlobalCommentId = 1;
let nextCommentId = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

function commitTimestamp(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly identity: Identity;
  readonly scenarioLabels: readonly string[];

  constructor(identity: Identity, scenarioLabels: readonly string[]) {
    this.identity = identity;
    this.scenarioLabels = scenarioLabels;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo {
    const owner = this.identity.login;
    const existing = this.getRepo(owner, name);
    if (existing) return existing;
    const repo: Repo = {
      id: nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? DEFAULT_BRANCH,
      createdAt: nowIso(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // ---------------------------------------------------------------- objects

  put(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  get(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Ref tips: only refs that point at objects the store holds. */
  refTips(repo: Repo): Array<{ ref: string; oid: string }> {
    const tips: Array<{ ref: string; oid: string }> = [];
    for (const [ref, oid] of repo.refs) {
      if (repo.objects.has(oid)) tips.push({ ref, oid });
    }
    return tips.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  /** Peel a ref tip through annotated tags down to a commit. */
  peelCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let hop = 0; hop < 10; hop += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') current = parseTag(object.data).object;
      else return null;
    }
    return null;
  }

  /** Fast-forward test: does `ancestor` reach `tip` through commits? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const start = this.peelCommit(repo, tip);
    const goal = this.peelCommit(repo, ancestor);
    if (!start || !goal) return false;
    try {
      const reachable = collectReachable([start], (oid) => repo.objects.get(oid));
      return reachable.has(goal);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- contents API support

  /**
   * Resolve a revision expression (branch name, tag, or raw oid) to a commit oid; null when unknown.
   */
  resolveRevision(repo: Repo, revision: string): string | null {
    if (/^[0-9a-f]{40}$/.test(revision.toLowerCase())) {
      const oid = revision.toLowerCase();
      return repo.objects.has(oid) ? oid : null;
    }
    const direct = repo.refs.get(`refs/heads/${revision}`) ?? repo.refs.get(`refs/tags/${revision}`) ?? repo.refs.get(revision);
    if (direct !== undefined) return this.peelCommit(repo, direct);
    if (revision === repo.defaultBranch) {
      const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (head !== undefined) return this.peelCommit(repo, head);
    }
    return null;
  }

  /**
   * Resolve `path` (like `src/lib/a.ts`) at a commit to its blob oid; null when absent, 'dir' when a
   * directory prefix. Answer { kind, oid }.
   */
  resolvePath(repo: Repo, commitOid: string, path: string): { kind: 'file' | 'dir'; oid: string } | null {
    const commitObject = repo.objects.get(commitOid);
    if (!commitObject || commitObject.type !== 'commit') return null;
    let treeOid = parseCommit(commitObject.data).tree;
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
    for (let index = 0; index < segments.length; index += 1) {
      const treeObject = repo.objects.get(treeOid);
      if (!treeObject || treeObject.type !== 'tree') return null;
      const entries = parseTree(treeObject.data);
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      const isLast = index === segments.length - 1;
      const object = repo.objects.get(entry.oid);
      if (!object) return null;
      if (isLast) {
        if (object.type === 'tree') return { kind: 'dir', oid: entry.oid };
        return { kind: 'file', oid: entry.oid };
      }
      if (object.type !== 'tree') return null;
      treeOid = entry.oid;
    }
    return { kind: 'dir', oid: treeOid };
  }

  /**
   * Build a tree from a flat path->blob map plus existing entries below directories not touched.
   * `changes` maps full path to blob oid, or null to delete. Existing tree content at untouched
   * paths is preserved from `baseTreeOid` (null for an empty base).
   */
  buildTreeRecursive(baseTreeOid: string | null, changes: Map<string, string | null>): string | null {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
      existingSubtree: Map<string, string | null>; // preserved entries we don't touch (oid, or null deleted)
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map(), existingSubtree: new Map() });
    const root = make();

    // Walk base tree only along paths that intersect changes.
    const loadBase = (treeOid: string | null, node: Node, pathPrefix: string): void => {
      if (treeOid === null) return;
      const treeObject = repo.objects.get(treeOid);
      if (!treeObject || treeObject.type !== 'tree') return;
      for (const entry of parseTree(treeObject.data)) {
        const fullPath = pathPrefix === '' ? entry.name : `${pathPrefix}/${entry.name}`;
        if (changes.has(fullPath)) continue;
        const touchedBelow = [...changes.keys()].some((key) => key.startsWith(`${fullPath}/`));
        if (!touchedBelow) {
          node.existingSubtree.set(entry.name, entry.oid);
          continue;
        }
        const object = repo.objects.get(entry.oid);
        if (object && object.type === 'tree') {
          const child = make();
          node.dirs.set(entry.name, child);
          loadBase(entry.oid, child, fullPath);
        } else {
          node.files.set(entry.name, entry.oid);
        }
      }
    };
    loadBase(baseTreeOid, root, '');

    for (const [path, blobOid] of changes) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      const leaf = segments[segments.length - 1];
      if (blobOid === null) {
        node.files.delete(leaf);
        node.dirs.delete(leaf);
        node.existingSubtree.delete(leaf);
      } else {
        node.files.set(leaf, blobOid);
        node.dirs.delete(leaf);
        node.existingSubtree.delete(leaf);
      }
    }

    const build = (node: Node): string | null => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '100644', name, oid });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const oid = build(child);
        if (oid === null) continue;
        entries.push({ mode: '40000', name, oid });
      }
      for (const [name, oid] of [...node.existingSubtree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (oid === null) continue;
        const object = repo.objects.get(oid);
        if (!object) continue;
        entries.push({ mode: object.type === 'tree' ? '40000' : '100644', name, oid });
      }
      if (entries.length === 0) return null;
      return this.put(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /**
   * Commit `changes` on `branch` (creating the branch from `baseBranch` when it does not exist).
   * Answers { commitOid, treeOid }, or null when the base is unresolvable.
   */
  commitChanges(
    repo: Repo,
    branch: string,
    changes: ReadonlyMap<string, string | null>,
    options: { message: string; author?: Identity },
  ): { commitOid: string; treeOid: string } | null {
    const refName = `refs/heads/${branch}`;
    let parentOid: string | null = repo.refs.get(refName) ?? null;
    if (parentOid === null) {
      const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (base !== undefined) {
        repo.refs.set(refName, base);
        parentOid = base;
      }
    }
    let parentCommitOid: string | null = null;
    if (parentOid !== null) parentCommitOid = this.peelCommit(repo, parentOid);
    const baseTreeOid = parentCommitOid !== null ? parseCommit(repo.objects.get(parentCommitOid)!.data).tree : null;
    const treeOid = this.buildTreeRecursive(baseTreeOid, new Map(changes));
    if (treeOid === null) return null;
    const who = options.author ?? this.identity;
    const timestamp = Math.floor(Date.now() / 1000);
    const data = buildCommit({
      tree: treeOid,
      parents: parentCommitOid !== null ? [parentCommitOid] : [],
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
      author: `${who.name} <${who.email}>`,
      committer: `${who.name} <${who.email}>`,
      timestamp,
    });
    const commitOid = this.put(repo, 'commit', data);
    repo.refs.set(refName, commitOid);
    return { commitOid, treeOid };
  }

  /**
   * Diff two trees into REST pull-file entries (added / modified / removed with line counts).
   */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): Array<{
    filename: string;
    status: 'added' | 'removed' | 'modified';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const flatten = (treeOid: string | null, prefix: string, into: Map<string, string>): void => {
      if (treeOid === null) return;
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const child = repo.objects.get(entry.oid);
        if (child && child.type === 'tree') flatten(entry.oid, path, into);
        else into.set(path, entry.oid);
      }
    };
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    flatten(baseTreeOid, '', baseFiles);
    flatten(headTreeOid, '', headFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const files: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before === after) continue;
      const beforeBytes = before !== undefined ? repo.objects.get(before)?.data : undefined;
      const afterBytes = after !== undefined ? repo.objects.get(after)?.data : undefined;
      if (before === undefined) {
        const lines = afterBytes ? afterBytes.toString('utf8').split('\n').length - (afterBytes.toString('utf8').endsWith('\n') ? 1 : 0) : 0;
        files.push({ filename: path, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
      } else if (after === undefined) {
        const lines = beforeBytes ? beforeBytes.toString('utf8').split('\n').length - (beforeBytes.toString('utf8').endsWith('\n') ? 1 : 0) : 0;
        files.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, lines), changes: Math.max(1, lines) });
      } else {
        const beforeText = beforeBytes ? beforeBytes.toString('utf8').split('\n') : [];
        const afterText = afterBytes ? afterBytes.toString('utf8').split('\n') : [];
        const beforeSet = new Map<string, number>();
        for (const line of beforeText) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
        const afterSet = new Map<string, number>();
        for (const line of afterText) afterSet.set(line, (afterSet.get(line) ?? 0) + 1);
        let additions = 0;
        let deletions = 0;
        for (const [line, count] of afterSet) {
          const held = beforeSet.get(line) ?? 0;
          if (count > held) additions += count - held;
        }
        for (const [line, count] of beforeSet) {
          const held = afterSet.get(line) ?? 0;
          if (count > held) deletions += count - held;
        }
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /**
   * Squash-merge: commit the head tree onto the base branch as one new commit with both parents'
   * history preserved (single-parent squash, as GitHub's squash does). Refuses on conflict: when the
   * same file changed on both branches since their merge base with different content.
   */
  squashMerge(repo: Repo, headBranch: string, baseBranch: string): { sha: string } | 'conflict' | 'unknown' {
    const headRef = `refs/heads/${headBranch}`;
    const baseRef = `refs/heads/${baseBranch}`;
    const headTip = repo.refs.get(headRef);
    const baseTip = repo.refs.get(baseRef);
    if (headTip === undefined || baseTip === undefined) return 'unknown';
    const headCommitOid = this.peelCommit(repo, headTip);
    const baseCommitOid = this.peelCommit(repo, baseTip);
    if (headCommitOid === null || baseCommitOid === null) return 'unknown';
    const headCommit = repo.objects.get(headCommitOid)!;
    const baseCommit = repo.objects.get(baseCommitOid)!;
    const headTree = parseCommit(headCommit.data).tree;
    const baseTree = parseCommit(baseCommit.data).tree;

    // Conflict: a path changed on the head side and differently on the base side since the merge base.
    const mergeBase = this.mergeBase(repo, headCommitOid, baseCommitOid);
    const baseTreeAtMergeBase = mergeBase !== null ? parseCommit(repo.objects.get(mergeBase)!.data).tree : null;
    const baseSide = this.diffTrees(repo, baseTreeAtMergeBase, baseTree);
    const headSide = this.diffTrees(repo, baseTreeAtMergeBase, headTree);
    const baseChanged = new Map(baseSide.map((entry) => [entry.filename, entry]));
    for (const entry of headSide) {
      const other = baseChanged.get(entry.filename);
      if (other === undefined) continue;
      // Both sides touched the same path; conflict when the resulting blobs differ.
      const headBlob = this.resolvePath(repo, headCommitOid, entry.filename);
      const baseBlob = this.resolvePath(repo, baseCommitOid, entry.filename);
      if (!headBlob || !baseBlob || headBlob.oid !== baseBlob.oid) return 'conflict';
    }
    if (headTree === baseTree) {
      // Nothing to merge: still record a merge (GitHub would say nothing to merge) — report the base tip.
      return { sha: baseCommitOid };
    }
    const who = this.identity;
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `Merge pull request from ${headBranch}\n\nSquash-merge ${headBranch} into ${baseBranch}\n`;
    const data = buildCommit({
      tree: headTree,
      parents: [baseCommitOid],
      message,
      author: `${who.name} <${who.email}>`,
      committer: `${who.name} <${who.email}>`,
      timestamp,
    });
    const sha = this.put(repo, 'commit', data);
    repo.refs.set(baseRef, sha);
    return { sha };
  }

  /** The best common ancestor of two commits, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOf = (start: string): Set<string> => {
      try {
        return collectReachable([start], (oid) => repo.objects.get(oid));
      } catch {
        return new Set();
      }
    };
    const aAncestors = ancestorsOf(a);
    const bAncestors = ancestorsOf(b);
    let best: string | null = null;
    let bestTime = -1;
    for (const oid of aAncestors) {
      if (!bAncestors.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      const time = commitTimestampFrom(view);
      if (time > bestTime) {
        bestTime = time;
        best = oid;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- issues and pulls

  createLabel(repo: Repo, name: string, color = 'ededed'): IssueLabel {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, options: { title: string; body?: string; labels?: readonly string[] }): Issue | 'bad-label' {
    const labels: string[] = [];
    for (const name of options.labels ?? []) {
      if (!repo.labels.has(name)) return 'bad-label';
      labels.push(name);
    }
    const id = nextGlobalIssueId++;
    const number = repo.nextIssueNumber++;
    const timestamp = nowIso();
    const issue: Issue = {
      id,
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      labels,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      user: this.identity.login,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  createPull(repo: Repo, options: { title: string; body?: string; head: string; base: string }): PullRequest | 'bad-refs' {
    const headTip = repo.refs.get(`refs/heads/${options.head}`);
    const baseTip = repo.refs.get(`refs/heads/${options.base}`);
    if (headTip === undefined || baseTip === undefined) return 'bad-refs';
    const id = nextGlobalPullId++;
    const number = repo.nextPullNumber++;
    const pull: PullRequest = {
      id,
      number,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: options.head,
      base: options.base,
      createdAt: nowIso(),
      user: this.identity.login,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  /** Create an annotated tag object and set refs/tags/<name>. */
  createTag(repo: Repo, name: string, targetOid: string, message: string): string {
    const object = repo.objects.get(targetOid);
    if (!object) return '';
    const timestamp = Math.floor(Date.now() / 1000);
    const data = buildTag({
      object: targetOid,
      type: object.type,
      tag: name,
      message: message.endsWith('\n') ? message : `${message}\n`,
      tagger: `${this.identity.name} <${this.identity.email}>`,
      timestamp,
    });
    const tagOid = this.put(repo, 'tag', data);
    repo.refs.set(`refs/tags/${name}`, tagOid);
    return tagOid;
  }
  /** Walk first-parent history from `tip`, newest first, at most `limit` commits. */
  walkCommits(repo: Repo, tip: string, limit = 100): string[] {
    const out: string[] = [];
    let current: string | undefined = tip;
    while (current !== undefined && out.length < limit) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      out.push(current);
      current = parseCommit(object.data).parents[0];
    }
    return out;
  }

  addComment(repo: Repo, issue: Issue, body: string): { id: number; body: string; user: string; createdAt: string } {
    const comment = { id: nextGlobalCommentId++, body, user: this.identity.login, createdAt: nowIso() };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    void repo;
    return comment;
  }

  /** Files changed between a pull's base and head tips (computed live from the trees). */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string }> {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const headCommit = repo.objects.get(headTip);
    const baseCommit = repo.objects.get(baseTip);
    if (!headCommit || !baseCommit || headCommit.type !== 'commit' || baseCommit.type !== 'commit') return [];
    const files = this.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
    return files.map((entry) => ({ filename: entry.path, status: entry.status }));
  }
}

function commitTimestampFrom(view: ReturnType<typeof parseCommit>): number {
  // The committer line's trailing " <email> <time> <tz>" timestamp.
  const match = / (\d{9,}) [+-]\d{4}$/.exec(view.committer);
  return match ? Number(match[1]) : 0;
}

}
