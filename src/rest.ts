// REST v3 under /api/v3: repositories, git refs, contents, commits, branches, issues, labels,
// comments and pulls — the shapes the suite's RestClient and shapes read.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, DEFAULT_BRANCH, type Issue, type PullRequest, type Repo } from './store.ts';
import type { Scenario } from './scenario.ts';

export interface RestContext {
  store: Store;
  scenario: Scenario;
  token: string;
}

export interface RestReply {
  status: number;
  body: unknown | Buffer;
  headers?: Record<string, string>;
  raw?: boolean;
}

function requestId(): string {
  return createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16).toUpperCase();
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, body, headers: { 'x-github-request-id': requestId(), ...headers } };
}

function error(status: number, message: string): RestReply {
  return jsonReply(status, { message });
}

function readJson(req: IncomingMessage): Promise<{ ok: boolean; body: unknown; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) return resolve({ ok: true, body: {}, raw });
      try {
        resolve({ ok: true, body: JSON.parse(raw.toString('utf8')), raw });
      } catch {
        resolve({ ok: false, body: null, raw });
      }
    });
    req.on('error', reject);
  });
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`repo:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_pull_requests: true,
    size: repo.objects.size,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: name.length * 7919, name, color: label?.color ?? 'ededed' };
    }),
    user: { login: issue.user },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
  return {
    id: pull.id,
    node_id: Buffer.from(`pull:${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: { login: pull.user },
    head: { ref: pull.head, sha: headTip, label: pull.head, repo: repoJson(repo) },
    base: { ref: pull.base, sha: baseTip, label: pull.base, repo: repoJson(repo) },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, commitOid: string): Record<string, unknown> {
  const object = repo.objects.get(commitOid);
  if (!object) return {};
  const text = object.data.toString('utf8');
  const header = (key: string): string => {
    const at = text.indexOf(`\n${key} `);
    if (at < 0) return '';
    return text.slice(at + key.length + 2, text.indexOf('\n', at + 1)).trim();
  };
  const treeAt = text.indexOf('tree ');
  const messageAt = text.indexOf('\n\n');
  const committer = header('committer');
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(committer);
  const epoch = timeMatch ? Number(timeMatch[1]) : 0;
  const authorLine = header('author');
  const nameMatch = /^([^<]+)</.exec(authorLine);
  const emailMatch = /<([^>]+)>/.exec(authorLine);
  return {
    sha: commitOid,
    node_id: Buffer.from(`commit:${commitOid}`).toString('base64'),
    commit: {
      message: text.slice(messageAt + 2),
      author: { name: nameMatch?.[1]?.trim() ?? '', email: emailMatch?.[1] ?? '', date: new Date(epoch * 1000).toISOString() },
      committer: { name: nameMatch?.[1]?.trim() ?? '', email: emailMatch?.[1] ?? '', date: new Date(epoch * 1000).toISOString() },
      tree: { sha: text.slice(treeAt + 5, text.indexOf('\n', treeAt)) },
    },
    parents: ((): Array<{ sha: string }> => {
      const parents: string[] = [];
      let index = 0;
      for (;;) {
        const at = text.indexOf('\nparent ', index);
        if (at < 0) break;
        parents.push(text.slice(at + 8, text.indexOf('\n', at + 1)));
        index = at + 1;
      }
      return parents.map((sha) => ({ sha }));
    })(),
    html_url: '',
  };
}

function queryOf(url: string): URLSearchParams {
  try {
    return new URL(url, 'http://x').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Route a REST request. `path` is the /api/v3-relative pathname (no query). */
export async function handleRest(ctx: RestContext, method: string, path: string, req: IncomingMessage, res: ServerResponse, rawUrl: string): Promise<RestReply> {
  const { store, scenario } = ctx;
  const owner = scenario.viewer.login;
  const segments = path.split('/').filter((segment) => segment !== '');
  const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? await readJson(req) : { ok: true, body: {}, raw: Buffer.alloc(0) };
  if (!body.ok) return error(400, 'Problems parsing JSON');

  // ---- root and meta
  if (segments.length === 0) {
    if (method === 'GET') {
      return jsonReply(200, {
        current_user_url: '/api/v3/user',
        authorizations_url: '/api/v3/authorizations',
        emails_url: '/api/v3/user/emails',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        meta_url: '/api/v3/meta',
      }, { 'x-oauth-scopes': 'repo, read:org, workflow' });
    }
    return error(404, 'Not Found');
  }
  const [head] = segments;

  if (head === 'meta' && method === 'GET') {
    return jsonReply(200, { verifiable_password_authentication: false, installed_version: '3.14.0-forge' });
  }
  if (head === 'user') {
    const rest = segments.slice(1);
    if (rest.length === 0 && method === 'GET') {
      return jsonReply(200, { login: store.identity.login, id: 1, name: store.identity.name, email: store.identity.email, type: 'User' });
    }
    if (rest[0] === 'repos' && method === 'GET') {
      const query = queryOf(rawUrl);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
      const repos = [...store.repos.values()].filter((repo) => repo.owner === owner);
      const start = (page - 1) * perPage;
      const items = repos.slice(start, start + perPage).map(repoJson);
      const headers: Record<string, string> = {};
      if (start + perPage < repos.length) {
        const nextUrl = `/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const base = ((): string => {
          try {
            const url = new URL(rawUrl, 'http://x');
            return `${url.protocol}//${url.host}`;
          } catch {
            return '';
          }
        })();
        headers.link = `<${base}${nextUrl}>; rel="next", <${base}/api/v3/user/repos?per_page=${perPage}&page=${Math.max(1, Math.ceil(repos.length / perPage))}>; rel="last"`;
      }
      return jsonReply(200, items, headers);
    }
    return error(404, 'Not Found');
  }

  if (head === 'user' || head !== 'repos') return error(404, 'Not Found');

  // ---- /repos/{owner}/{repo}/...
  const ownerName = segments[1];
  if (ownerName === undefined) return error(404, 'Not Found');
  if (segments.length === 2) {
    if (method === 'POST') {
      // POST /repos/{owner}/{repo} is not a GitHub route; fall through to 404.
      return error(404, 'Not Found');
    }
    const repo = store.getRepo(ownerName, segments[1] as never as string);
    void repo;
  }

  // POST /user/repos is handled under 'user' above; repository-scope routes:
  const repoOwner = segments[1];
  const repoName = segments[2];
  if (repoName === undefined) return error(404, 'Not Found');

  // Create: POST /user/repos handled above. Here: everything under /repos/...
  const repo = store.getRepo(repoOwner, repoName);
  if (segments.length === 3) {
    if (method === 'GET') {
      if (!repo) return error(404, 'Not Found');
      return jsonReply(200, repoJson(repo));
    }
    if (method === 'PATCH') {
      if (!repo) return error(404, 'Not Found');
      const input = body.body as Record<string, unknown>;
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      if (typeof input.default_branch === 'string' && input.defaultBranchGuard !== true) repo.defaultBranch = input.default_branch;
      if (typeof input.name === 'string' && input.name !== repo.name && input.name !== '') {
        store.deleteRepo(repo.owner, repo.name);
        repo.name = input.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      return jsonReply(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      if (!repo) return error(404, 'Not Found');
      store.deleteRepo(repoOwner, repoName);
      return { status: 204, body: Buffer.alloc(0), raw: true, headers: { 'x-github-request-id': requestId() } };
    }
    return error(404, 'Not Found');
  }

  if (!repo) return error(404, 'Not Found');
  const resource = segments[3];
  const rest = segments.slice(4);

  // ---- /git/refs
  if (resource === 'git' && rest[0] === 'refs') {
    const refQuery = rest.slice(1).join('/');
    if (method === 'POST') {
      const input = body.body as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return error(422, `Invalid ref: ${ref}`);
      if (!repo.objects.has(sha)) return error(422, `Object does not exist: ${sha}`);
      if (repo.refs.has(ref)) return error(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonReply(201, { ref, node_id: '', object: { sha, type: 'commit' }, url: '' });
    }
    if (method === 'GET') {
      if (refQuery === '') {
        const refs = store.refTips(repo).map((tip) => ({ ref: tip.ref, node_id: '', object: { sha: tip.oid, type: repo.objects.get(tip.oid)?.type === 'tag' ? 'tag' : 'commit' }, url: '' }));
        return jsonReply(200, refs);
      }
      const oid = repo.refs.get(refQuery);
      if (oid === undefined) return error(404, 'Not Found');
      return jsonReply(200, { ref: refQuery, node_id: '', object: { sha: oid, type: 'commit' }, url: '' });
    }
    if (method === 'PATCH' && refQuery !== '') {
      const input = body.body as Record<string, unknown>;
      const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : '';
      const force = input.force === true;
      const current = repo.refs.get(refQuery);
      if (current === undefined) return error(422, 'Reference does not exist');
      if (!repo.objects.has(sha)) return error(422, `Object does not exist: ${sha}`);
      if (!force && !store.isAncestor(repo, current, sha)) return error(422, 'Update is not a fast-forward');
      repo.refs.set(refQuery, sha);
      return jsonReply(200, { ref: refQuery, object: { sha, type: 'commit' } });
    }
    if (method === 'DELETE' && refQuery !== '') {
      if (!repo.refs.delete(refQuery)) return error(422, 'Reference does not exist');
      return { status: 204, body: Buffer.alloc(0), raw: true, headers: { 'x-github-request-id': requestId() } };
    }
    return error(404, 'Not Found');
  }

  // ---- /branches
  if (resource === 'branches') {
    if (method === 'GET' && rest.length === 0) {
      const branches = store.refTips(repo)
        .filter((tip) => tip.ref.startsWith('refs/heads/'))
        .map((tip) => ({
          name: tip.ref.slice('refs/heads/'.length),
          commit: { sha: tip.oid, commit: commitJson(repo, tip.oid).commit },
          protected: false,
        }));
      return jsonReply(200, branches);
    }
    const name = rest[0] ?? '';
    const oid = repo.refs.get(`refs/heads/${name}`);
    if (oid === undefined) return error(404, 'Branch not found');
    return jsonReply(200, { name, commit: { sha: oid }, protected: false });
  }

  // ---- /commits
  if (resource === 'commits') {
    if (method !== 'GET') return error(404, 'Not Found');
    const query = queryOf(rawUrl);
    const sha = query.get('sha') ?? repo.defaultBranch;
    const commitOid = store.resolveRevision(repo, sha);
    if (commitOid === null) return error(404, `No commit found for SHA: ${sha}`);
    const list: string[] = [];
    let current: string | null = commitOid;
    const limit = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
    while (current !== null && list.length < limit) {
      list.push(current);
      const parents = ((): string[] => {
        const object = repo.objects.get(current);
        if (!object) return [];
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
      })();
      current = parents[0] ?? null;
    }
    return jsonReply(200, list.map((oid) => commitJson(repo, oid)));
  }

  // ---- /contents/{path...}
  if (resource === 'contents') {
    const filePath = rest.join('/');
    if (method === 'GET') {
      const query = queryOf(rawUrl);
      const revision = query.get('ref') ?? repo.defaultBranch;
      const commitOid = store.resolveRevision(repo, revision);
      if (commitOid === null) return error(404, 'Not Found');
      const resolved = store.resolvePath(repo, commitOid, filePath);
      if (resolved === null) return error(404, 'Not Found');
      if (resolved.kind === 'dir') {
        const treeObject = repo.objects.get(resolved.oid)!;
        const entries: Array<Record<string, unknown>> = [];
        for (const entry of ((): Array<{ mode: string; name: string; oid: string }> => {
          const text = treeObject.data;
          const out: Array<{ mode: string; name: string; oid: string }> = [];
          let offset = 0;
          while (offset < text.length) {
            const space = text.indexOf(0x20, offset);
            if (space < 0) break;
            const mode = text.subarray(offset, space).toString('ascii');
            const nul = text.indexOf(0x00, space + 1);
            if (nul < 0) break;
            const name = text.subarray(space + 1, nul).toString('utf8');
            offset = nul + 1 + 20;
            out.push({ mode, name, oid: Buffer.from(text.subarray(nul + 1, offset)).toString('hex') });
          }
          return out;
        })()) {
          const object = repo.objects.get(entry.oid);
          const isTree = object?.type === 'tree';
          const fullPath = `${filePath}/${entry.name}`;
          entries.push({
            type: isTree ? 'dir' : 'file',
            name: entry.name,
            path: fullPath,
            sha: entry.oid,
            size: isTree ? 0 : (object?.data.length ?? 0),
            encoding: isTree ? undefined : 'base64',
            content: isTree ? undefined : b64encode(object?.data.toString('utf8') ?? ''),
          });
        }
        return jsonReply(200, entries);
      }
      const object = repo.objects.get(resolved.oid)!;
      const bytes = object.data;
      return jsonReply(200, {
        type: 'file',
        name: filePath.split('/').pop(),
        path: filePath,
        sha: resolved.oid,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
      });
    }
    if (method === 'PUT') {
      const input = body.body as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : '';
      const content = typeof input.content === 'string' ? b64decode(input.content) : '';
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const givenSha = typeof input.sha === 'string' ? input.sha.toLowerCase() : undefined;
      const commitOid = store.resolveRevision(repo, branch);
      if (commitOid === null && repo.refs.get(`refs/heads/${branch}`) === undefined && branch !== repo.defaultBranch) {
        return error(404, 'Branch not found');
      }
      const resolved = commitOid !== null ? store.resolvePath(repo, commitOid, filePath) : null;
      if (givenSha !== undefined) {
        if (resolved === null || resolved.kind !== 'file' || resolved.oid !== givenSha) {
          return error(409, `${filePath} does not match ${givenSha}`);
        }
      } else if (resolved !== null && resolved.kind === 'file') {
        // GitHub updates only with a sha; creating without sha over an existing file is an error.
        return error(422, `${filePath} already exists`);
      }
      const blobOid = store.put(repo, 'blob', Buffer.from(content, 'utf8'));
      const outcome = store.commitChanges(repo, branch, new Map([[filePath, blobOid]]), { message });
      if (outcome === null) return error(422, 'could not commit');
      return jsonReply(resolved === null ? 201 : 200, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: Buffer.byteLength(content, 'utf8'), type: 'file', encoding: 'base64', content: b64encode(content) },
        commit: { sha: outcome.commitOid, message, author: { name: store.identity.name, email: store.identity.email } },
      });
    }
    if (method === 'DELETE') {
      const input = body.body as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : '';
      const givenSha = typeof input.sha === 'string' ? input.sha.toLowerCase() : '';
      const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
      const commitOid = store.resolveRevision(repo, branch);
      if (commitOid === null) return error(404, 'Not Found');
      const resolved = store.resolvePath(repo, commitOid, filePath);
      if (resolved === null || resolved.kind !== 'file') return error(404, 'Not Found');
      if (givenSha !== '' && resolved.oid !== givenSha) return error(409, 'sha mismatch');
      const outcome = store.commitChanges(repo, branch, new Map([[filePath, null]]), { message });
      if (outcome === null) return error(422, 'could not commit');
      return jsonReply(200, { content: null, commit: { sha: outcome.commitOid, message } });
    }
    return error(404, 'Not Found');
  }

  // ---- /labels
  if (resource === 'labels') {
    if (method === 'GET' && rest.length === 0) {
      return jsonReply(200, [...repo.labels.values()].map((label) => ({ id: label.name.length * 7919, name: label.name, color: label.color })));
    }
    if (method === 'POST' && rest.length === 0) {
      const input = body.body as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return error(422, 'Validation Failed');
      const label = store.createLabel(repo, name, typeof input.color === 'string' ? input.color : 'ededed');
      return jsonReply(201, { id: name.length * 7919, name: label.name, color: label.color });
    }
    return error(404, 'Not Found');
  }

  // ---- /issues
  if (resource === 'issues') {
    const number = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
    if (method === 'GET' && rest.length === 0) {
      const query = queryOf(rawUrl);
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => {
        const factor = direction === 'asc' ? 1 : -1;
        if (sort === 'created') return a.createdAt < b.createdAt ? -factor : a.createdAt > b.createdAt ? factor : factor * (a.number - b.number);
        return factor * (a.number - b.number);
      });
      return jsonReply(200, issues.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST' && rest.length === 0) {
      const input = body.body as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      const labels = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const created = store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : undefined, labels });
      if (created === 'bad-label') return error(422, `Validation Failed: label ${labels.join(', ')} does not exist`);
      return jsonReply(201, issueJson(repo, created));
    }
    if (number === null) return error(404, 'Not Found');
    const issue = store.getIssue(repo, number);
    if (rest.length === 1) {
      if (!issue) return error(404, 'Not Found');
      if (method === 'GET') return jsonReply(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const input = body.body as Record<string, unknown>;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') {
          issue.state = input.state;
          issue.closedAt = input.state === 'closed' ? new Date().toISOString() : null;
        }
        issue.updatedAt = new Date().toISOString();
        return jsonReply(200, issueJson(repo, issue));
      }
      return error(404, 'Not Found');
    }
    if (rest[1] === 'comments') {
      if (!issue) return error(404, 'Not Found');
      if (method === 'GET') {
        return jsonReply(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.user }, created_at: comment.createdAt })));
      }
      if (method === 'POST') {
        const input = body.body as Record<string, unknown>;
        const text = typeof input.body === 'string' ? input.body : '';
        const comment = { id: 30_000 + (issue.comments.length + 1) * 7 + number, body: text, user: store.identity.login, createdAt: new Date().toISOString() };
        issue.comments.push(comment);
        return jsonReply(201, { id: comment.id, body: comment.body, user: { login: comment.user }, created_at: comment.createdAt });
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  // ---- /pulls
  if (resource === 'pulls') {
    const number = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
    if (method === 'GET' && rest.length === 0) {
      const query = queryOf(rawUrl);
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      return jsonReply(200, pulls.map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST' && rest.length === 0) {
      const input = body.body as Record<string, unknown>;
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.head === 'string' ? input.head : '';
      const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
      const created = store.createPull(repo, { title, body: typeof input.body === 'string' ? input.body : undefined, head, base });
      if (created === 'bad-refs') return error(422, `Validation Failed: head ${head} or base ${base} does not exist`);
      return jsonReply(201, pullJson(repo, created));
    }
    if (number === null) return error(404, 'Not Found');
    const pull = store.getPull(repo, number);
    if (rest.length === 1) {
      if (!pull) return error(404, 'Not Found');
      if (method === 'GET') return jsonReply(200, pullJson(repo, pull));
      if (method === 'PATCH') {
        const input = body.body as Record<string, unknown>;
        if (typeof input.title === 'string') pull.title = input.title;
        if (typeof input.body === 'string') pull.body = input.body;
        if (input.state === 'closed') pull.state = 'closed';
        if (input.state === 'open') pull.state = 'open';
        return jsonReply(200, pullJson(repo, pull));
      }
      return error(404, 'Not Found');
    }
    if (rest[1] === 'files' && method === 'GET') {
      if (!pull) return error(404, 'Not Found');
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      if (headTip === undefined || baseTip === undefined) return error(404, 'Not Found');
      const headCommitOid = store.peelCommit(repo, headTip);
      const baseCommitOid = store.peelCommit(repo, baseTip);
      if (headCommitOid === null || baseCommitOid === null) return error(404, 'Not Found');
      const headTree = (repo.objects.get(headCommitOid)!.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m) ?? [])[1] ?? null;
      const baseTree = (repo.objects.get(baseCommitOid)!.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m) ?? [])[1] ?? null;
      const files = store.diffTrees(repo, baseTree, headTree);
      return jsonReply(200, files);
    }
    if (rest[1] === 'merge' && method === 'PUT') {
      if (!pull) return error(404, 'Not Found');
      if (pull.merged) return error(405, 'Pull Request is not mergeable: already merged');
      const input = body.body as Record<string, unknown>;
      void input;
      const outcome = store.squashMerge(repo, pull.head, pull.base);
      if (outcome === 'unknown') return error(404, 'Not Found');
      if (outcome === 'conflict') return error(405, 'Pull Request is not mergeable: conflicts');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = outcome.sha;
      return jsonReply(200, { merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' });
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}
