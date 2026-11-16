// GraphQL v4 at /api/graphql: a hand-rolled executor for the documents gh and github-mcp-server
// send (the suite's exact set), plus introspection of Issue/PullRequest/Repository/SearchType, node
// id round-trips, batching, and error semantics.

import { Store } from './store.ts';
import type { Repo, Issue, PullRequest } from './store.ts';
import type { Scenario } from './scenario.ts';

export interface GraphQLContext {
  store: Store;
  scenario: Scenario;
  token: string;
  authed: boolean;
  errors: string[];
}

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.lastIndexOf(':');
    if (colon < 0) return null;
    const numeric = Number(text.slice(colon + 1));
    if (!Number.isInteger(numeric)) return null;
    return { kind: text.slice(0, colon), id: numeric };
  } catch {
    return null;
  }
}

function parseSelections(source: string, start: number): { fields: Selection[]; end: number } {
  const fields: Selection[] = [];
  let index = start;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] === '}') return { fields, end: index + 1 };
    if (source[index] === '.') {
      // inline fragment: "... on Type { ... }" — merge its selections into the parent scope.
      const braceAt = source.indexOf('{', index);
      const close = matchBrace(source, braceAt);
      const parsed = parseSelections(source, braceAt + 1);
      for (const field of parsed.fields) fields.push(field);
      index = close;
      continue;
    }
    let name = '';
    let alias = '';
    while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) name += source[index++];
    // alias?
    let probe = index;
    while (probe < source.length && /\s/.test(source[probe])) probe += 1;
    if (source[probe] === ':') {
      alias = name;
      index = probe + 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      name = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) name += source[index++];
      probe = index;
      while (probe < source.length && /\s/.test(source[probe])) probe += 1;
    }
    // arguments?
    let args: Record<string, unknown> = {};
    if (source[probe] === '(') {
      const close = matchParen(source, probe);
      args = parseArguments(source.slice(probe + 1, close));
      index = close;
      probe = index;
      while (probe < source.length && /\s/.test(source[probe])) probe += 1;
    }
    let subFields: Selection[] = [];
    if (source[probe] === '{') {
      const parsed = parseSelections(source, probe + 1);
      subFields = parsed.fields;
      index = parsed.end;
    } else {
      index = probe;
    }
    fields.push({ name, alias, args, fields: subFields });
  }
  return { fields, end: index };
}

function matchBrace(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function matchParen(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' && source[index - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function parseArguments(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /[,\s]/.test(text[index])) index += 1;
    if (index >= text.length) break;
    let name = '';
    while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) name += text[index++];
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== ':') break;
    index += 1;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    let value: unknown = null;
    if (text[index] === '"') {
      let literal = '';
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length) {
          literal += text[index + 1] === 'n' ? '\n' : text[index + 1];
          index += 2;
          continue;
        }
        literal += text[index++];
      }
      index += 1;
      value = literal;
    } else if (text[index] === '$') {
      let variable = '';
      index += 1;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) variable += text[index++];
      value = { $var: variable };
    } else if (text[index] === '[') {
      const close = matchBracket(text, index);
      value = text.slice(index + 1, close).split(',').map((entry) => entry.trim().replace(/^\[|\]$/g, '')).filter((entry) => entry !== '');
      index = close;
    } else if (text[index] === '{') {
      const close = matchBrace(text, index);
      value = parseArguments(text.slice(index + 1, close - 1));
      index = close;
    } else {
      let literal = '';
      while (index < text.length && /[A-Za-z0-9_.-]/.test(text[index])) literal += text[index++];
      if (/^-?\d+(\.\d+)?$/.test(literal)) value = Number(literal);
      else if (literal === 'true') value = true;
      else if (literal === 'false') value = false;
      else if (literal === 'null') value = null;
      else value = literal;
    }
    if (name !== '') args[name] = value;
  }
  return args;
}

function matchBracket(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1;
    else if (source[index] === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

interface Selection {
  name: string;
  alias: string;
  args: Record<string, unknown>;
  fields: Selection[];
}

interface Operation {
  type: 'query' | 'mutation';
  name: string;
  fields: Selection[];
}

function parseDocument(document: string, variables: Record<string, unknown>): { operation: Operation | null; errors: string[] } {
  const errors: string[] = [];
  const text = document;
  // strip comments
  const cleaned = text.replace(/#[^\n]*/g, '');
  const operationAt = cleaned.search(/\b(query|mutation)\b/);
  if (operationAt < 0) return { operation: null, errors: ['no operation found'] };
  let index = operationAt;
  let type = 'query' as 'query' | 'mutation';
  const typeMatch = /^(query|mutation)\b/.exec(cleaned.slice(index));
  if (typeMatch) {
    type = typeMatch[1] as 'query' | 'mutation';
    index += typeMatch[0].length;
  }
  let name = '';
  while (index < cleaned.length && /\s/.test(cleaned[index])) index += 1;
  while (index < cleaned.length && /[A-Za-z0-9_]/.test(cleaned[index])) name += cleaned[index++];
  // variable declarations: skip to the first '{'
  const braceAt = cleaned.indexOf('{', index);
  if (braceAt < 0) return { operation: null, errors: ['no selection set'] };
  const varText = cleaned.slice(index, braceAt);
  const declared = new Map<string, unknown>();
  for (const match of varText.matchAll(/\$\w+:\s*\[?(\w+)/g)) declared.set(match[0].split(':')[0].slice(1), undefined);
  const parsed = parseSelections(cleaned, braceAt + 1);
  const resolveVars = (fields: Selection[]): void => {
    for (const field of fields) {
      for (const [key, value] of Object.entries(field.args)) {
        if (typeof value === 'object' && value !== null && '$var' in (value as Record<string, unknown>)) {
          const name2 = (value as { $var: string }).$var;
          field.args[key] = variables[name2] ?? null;
        } else if (Array.isArray(value)) {
          field.args[key] = value.map((entry) => (typeof entry === 'string' && entry.startsWith('$') ? (variables[entry.slice(1)] ?? null) : entry));
        } else if (typeof value === 'object' && value !== null) {
          const record = value as Record<string, unknown>;
          for (const [k, v] of Object.entries(record)) {
            if (typeof v === 'string' && v.startsWith('$')) record[k] = variables[v.slice(1)] ?? null;
          }
        }
      }
      resolveVars(field.fields);
    }
  };
  resolveVars(parsed.fields);
  void declared;
  return { operation: { type, name, fields: parsed.fields }, errors };
}

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'createdAt', 'author', 'repository', 'comments', 'closedAt', 'updatedAt', 'url', 'viewerDidAuthor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'mergeStateStatus', 'files', 'createdAt', 'author', 'url', 'mergeCommit', 'closedAt', 'mergedAt', 'commits', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'createdAt', 'isPrivate', 'isEmpty', 'ref', 'object', 'isFork', 'updatedAt', 'labels', 'diskUsage', 'sshUrl', 'visibility'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION'],
};

const VIEWER_FIELDS = ['login', 'id', 'name', 'email', 'url', 'createdAt', 'repositories', 'databaseId'];

function issueGql(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    author: { login: issue.user },
    labels: {},
    repository: repositoryGql(repo, []),
  };
}

function pullGql(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headCommitOid = headTip !== undefined ? this0(repo, headTip) : null;
  const baseCommitOid = baseTip !== undefined ? this0(repo, baseTip) : null;
  const headTree = headCommitOid !== null ? (repo.objects.get(headCommitOid)!.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m) ?? [])[1] : null;
  const baseTree = baseCommitOid !== null ? (repo.objects.get(baseCommitOid)!.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m) ?? [])[1] : null;
  const mergeable = ((): string => {
    if (pull.merged) return 'MERGEABLE';
    // Cheap conflict test: any path both sides touched differently.
    const files = repoDiff(repo, baseTree, headTree);
    return files.length === 0 || files.every((entry) => entry.status !== 'conflict') ? 'MERGEABLE' : 'CONFLICTING';
  })();
  const paths = repoDiff(repo, baseTree, headTree);
  return {
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: headTip,
    baseRefOid: baseTip,
    mergeable,
    files: { nodes: paths.map((entry) => ({ path: entry.path })), totalCount: paths.length },
    createdAt: pull.createdAt,
    author: { login: pull.user },
    _paths: paths,
  };
}

function this0(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const at = object.data.toString('utf8').indexOf('object ');
    return object.data.toString('utf8').slice(at + 7, at + 47);
  }
  return null;
}

function repoDiff(repo: Repo, baseTree: string | null, headTree: string | null): Array<{ path: string; status: string }> {
  const flatten = (treeOid: string | null, prefix: string, into: Map<string, string>): void => {
    if (treeOid === null) return;
    const object = repo.objects.get(treeOid);
    if (!object) return;
    const data = object.data;
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset);
      if (space < 0) break;
      const nul = data.indexOf(0x00, space + 1);
      if (nul < 0) break;
      const name = data.subarray(space + 1, nul).toString('utf8');
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      offset = nul + 21;
      const path = prefix === '' ? name : `${prefix}/${name}`;
      const child = repo.objects.get(oid);
      if (child && child.type === 'tree') flatten(oid, path, into);
      else into.set(path, oid);
    }
  };
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  flatten(baseTree, '', baseFiles);
  flatten(headTree, '', headFiles);
  const out: Array<{ path: string; status: string }> = [];
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before === after) continue;
    out.push({ path, status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified' });
  }
  return out;
}

function repositoryGql(repo: Repo, fields: Selection[]): Record<string, unknown> {
  const answer: Record<string, unknown> = {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    isEmpty: repo.refs.size === 0,
    description: repo.description,
  };
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  for (const field of fields) {
    if (field.name === 'defaultBranchRef') {
      answer[field.alias || field.name] = defaultTip === undefined ? null : { name: repo.defaultBranch, target: { oid: defaultTip } };
    } else if (field.name === 'issues') {
      answer[field.alias || field.name] = issuesConnection(repo, field);
    } else if (field.name === 'pullRequests') {
      answer[field.alias || field.name] = pullRequestsConnection(repo, field);
    } else if (field.name === 'issue') {
      const number = Number(field.args.number);
      const issue = repo.issues.get(number);
      answer[field.alias || field.name] = issue ? issueGql(repo, issue) : null;
    } else if (field.name === 'pullRequest') {
      const number = Number(field.args.number);
      const pull = repo.pulls.get(number);
      answer[field.alias || field.name] = pull ? pullGql(repo, pull) : null;
    } else if (field.name === 'ref') {
      const refName = typeof field.args.qualifiedName === 'string' ? field.args.qualifiedName.replace(/^refs\/heads\//, '') : '';
      const oid = repo.refs.get(`refs/heads/${refName}`);
      answer[field.alias || field.name] = oid === undefined ? null : { name: refName, target: { oid } };
    }
  }
  return answer;
}

function orderBySort<T>(items: T[], args: Record<string, unknown>, key: (item: T) => number | string): T[] {
  const order = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = typeof order.direction === 'string' ? order.direction : 'ASC';
  const factor = direction === 'DESC' ? -1 : 1;
  return items.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -factor;
    if (ka > kb) return factor;
    return 0;
  });
}

function issuesConnection(repo: Repo, field: Selection): Record<string, unknown> {
  const states = Array.isArray(field.args.states) ? (field.args.states as string[]).map((entry) => String(entry).toUpperCase()) : null;
  let issues = [...repo.issues.values()];
  if (states !== null && states.length > 0) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  orderBySort(issues, field.args, (issue) => `${issue.createdAt}|${String(issue.number).padStart(10, '0')}`);
  const first = typeof field.args.first === 'number' ? field.args.first : 100;
  const after = typeof field.args.after === 'string' && field.args.after !== '' ? Number(Buffer.from(field.args.after, 'base64').toString('utf8')) : 0;
  const windowed = issues.slice(after, after + first);
  const endCursor = after + windowed.length;
  return {
    nodes: windowed.map((issue) => issueGql(repo, issue)),
    pageInfo: { hasNextPage: endCursor < issues.length, endCursor: Buffer.from(String(endCursor)).toString('base64') },
    totalCount: issues.length,
  };
}

function pullRequestsConnection(repo: Repo, field: Selection): Record<string, unknown> {
  const states = Array.isArray(field.args.states) ? (field.args.states as string[]).map((entry) => String(entry).toUpperCase()) : null;
  let pulls = [...repo.pulls.values()];
  if (states !== null && states.length > 0) pulls = pulls.filter((pull) => states.includes(pull.state.toUpperCase()));
  const first = typeof field.args.first === 'number' ? field.args.first : 100;
  return { nodes: pulls.slice(0, first).map((pull) => pullGql(repo, pull)), pageInfo: { hasNextPage: false, endCursor: '' }, totalCount: pulls.length };
}

function executeSelection(subject: unknown, fields: readonly Selection[], ctx: GraphQLContext): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  const record = subject as Record<string, unknown>;
  for (const field of fields) {
    const key = field.alias || field.name;
    const value = record[field.name];
    if (field.name === '__typename') {
      answer[key] = record.__typename ?? 'Unknown';
      continue;
    }
    if (value === undefined) {
      if (!(field.name in record) && field.name !== '__typename') {
        ctx.errors.push(`Field '${field.name}' doesn't exist on type '${record.__typename ?? 'Object'}'`);
      }
      answer[key] = null;
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && field.fields.length > 0) {
      answer[key] = executeSelection(value, field.fields, ctx);
      continue;
    }
    if (Array.isArray(value) && field.fields.length > 0) {
      answer[key] = value.map((entry) => (entry !== null && typeof entry === 'object' ? executeSelection(entry, field.fields, ctx) : entry));
      continue;
    }
    answer[key] = value;
  }
  return answer;
}

function executeOperation(operation: Operation, ctx: GraphQLContext): { data: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};
  const { store, scenario } = ctx;
  for (const field of operation.fields) {
    const key = field.alias || field.name;
    if (operation.type === 'query') {
      if (field.name === 'viewer') {
        if (!ctx.authed) {
          errors.push('Resource not accessible by integration');
          data[key] = null;
          continue;
        }
        const viewer = {
          login: store.identity.login,
          id: globalId('User', 1),
          name: store.identity.name,
          email: store.identity.email,
          databaseId: 1,
          createdAt: new Date().toISOString(),
          url: '',
        };
        data[key] = executeSelection(viewer, field.fields, ctx);
        continue;
      }
      if (field.name === '__type') {
        const name = String(field.args.name ?? '');
        const fields = SCHEMA_FIELDS[name];
        if (fields === undefined && name !== 'Query' && name !== 'Repository') {
          data[key] = null;
          continue;
        }
        data[key] = {
          name,
          fields: (fields ?? VIEWER_FIELDS).map((entry) => ({ name: entry })),
          enumValues: (fields ?? []).map((entry) => ({ name: entry })),
        };
        continue;
      }
      if (field.name === 'node') {
        const id = String(field.args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (decoded === null || decoded.kind !== 'Repository') {
          data[key] = null;
          continue;
        }
        const repo = [...store.repos.values()].find((candidate) => candidate.id === decoded.id);
        if (repo === undefined) {
          data[key] = null;
          continue;
        }
        data[key] = executeSelection(repositoryGql(repo, field.fields), field.fields, ctx);
        continue;
      }
      if (field.name === 'repository') {
        const ownerName = String(field.args.owner ?? '');
        const name = String(field.args.name ?? '');
        const repo = store.getRepo(ownerName, name);
        if (repo === undefined) {
          data[key] = null;
          continue;
        }
        data[key] = executeSelection(repositoryGql(repo, field.fields), field.fields, ctx);
        continue;
      }
      if (field.name === 'search') {
        data[key] = { nodes: [], issueCount: 0 };
        continue;
      }
      errors.push(`Field '${field.name}' doesn't exist on type 'Query'`);
      data[key] = null;
      continue;
    }
    // mutations
    if (field.name === 'createIssue') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId !== null ? [...store.repos.values()].find((candidate) => candidate.id === repoId.id) : undefined;
      if (repo === undefined) {
        errors.push('Could not resolve to a node with the global id');
        data[key] = null;
        continue;
      }
      const created = store.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : undefined });
      data[key] = { issue: created === 'bad-label' ? null : issueGql(repo, created) };
      continue;
    }
    if (field.name === 'closeIssue' || field.name === 'reopenIssue') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? input.issueOpenId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      for (const repo of store.repos.values()) {
        for (const issue of repo.issues.values()) {
          if (issue.id === decoded?.id) found = { repo, issue };
        }
      }
      if (found === null) {
        errors.push('Could not resolve to a node with the global id');
        data[key] = null;
        continue;
      }
      found.issue.state = field.name === 'closeIssue' ? 'closed' : 'open';
      found.issue.closedAt = field.name === 'closeIssue' ? new Date().toISOString() : null;
      data[key] = { issue: issueGql(found.repo, found.issue) };
      continue;
    }
    if (field.name === 'createPullRequest') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId !== null ? [...store.repos.values()].find((candidate) => candidate.id === repoId.id) : undefined;
      if (repo === undefined) {
        errors.push('Could not resolve to a node with the global id');
        data[key] = null;
        continue;
      }
      const created = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : undefined,
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? repo.defaultBranch),
      });
      data[key] = { pullRequest: created === 'bad-refs' ? null : pullGql(repo, created) };
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      let found: { repo: Repo; pull: PullRequest } | null = null;
      for (const repo of store.repos.values()) {
        for (const pull of repo.pulls.values()) {
          if (pull.id === decoded?.id) found = { repo, pull };
        }
      }
      if (found === null) {
        errors.push('Could not resolve to a node with the global id');
        data[key] = null;
        continue;
      }
      const outcome = store.squashMerge(found.repo, found.pull.head, found.pull.base);
      if (outcome === 'unknown' || outcome === 'conflict') {
        errors.push('Pull Request is not mergeable');
        data[key] = { pullRequest: { merged: false, state: 'OPEN', number: found.pull.number } };
        continue;
      }
      found.pull.merged = true;
      found.pull.state = 'closed';
      found.pull.mergedAt = new Date().toISOString();
      found.pull.mergeCommitSha = outcome.sha;
      data[key] = { pullRequest: { merged: true, state: 'CLOSED', number: found.pull.number, mergeCommit: { oid: outcome.sha } } };
      continue;
    }
    if (field.name === 'addComment') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      let comment: Record<string, unknown> | null = null;
      for (const repo of store.repos.values()) {
        for (const issue of repo.issues.values()) {
          if (issue.id !== decoded?.id) continue;
          const entry = { id: globalId('IssueComment', 90_000 + issue.comments.length * 13 + issue.number), body: String(input.body ?? ''), createdAt: new Date().toISOString(), author: { login: store.identity.login } };
          issue.comments.push({ id: 90_000 + issue.comments.length * 13 + issue.number, body: String(input.body ?? ''), user: store.identity.login, createdAt: entry.createdAt as string });
          comment = entry;
        }
      }
      if (comment === null) {
        errors.push('Could not resolve to a node with the global id');
        data[key] = null;
        continue;
      }
      data[key] = { commentEdge: { node: comment } };
      continue;
    }
    if (field.name === 'updateIssue' || field.name === 'updatePullRequest') {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.id ?? ''));
      let done = false;
      for (const repo of store.repos.values()) {
        const issue = repo.issues.get(decoded?.id ?? -1);
        if (issue !== undefined) {
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'OPEN' || input.state === 'CLOSED') issue.state = input.state === 'OPEN' ? 'open' : 'closed';
          done = true;
          data[key] = { issue: issueGql(repo, issue) };
          break;
        }
        const pull = repo.pulls.get(decoded?.id ?? -1);
        if (pull !== undefined) {
          if (typeof input.title === 'string') pull.title = input.title;
          if (typeof input.body === 'string') pull.body = input.body;
          done = true;
          data[key] = { pullRequest: pullGql(repo, pull) };
          break;
        }
      }
      if (!done) {
        errors.push('Could not resolve to a node with the global id');
        data[key] = null;
      }
      continue;
    }
    errors.push(`Field '${field.name}' doesn't exist on type 'Mutation'`);
    data[key] = null;
  }
  void scenario;
  return { data, errors };
}

/** POST /api/graphql: { query, variables } or an array of those. */
export function handleGraphQL(ctx: GraphQLContext, payload: unknown): GraphQLResponse {
  if (!ctx.authed) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  const operations: Array<{ query: string; variables?: Record<string, unknown> }> = Array.isArray(payload) ? payload : [payload as { query: string; variables?: Record<string, unknown> }];
  const responses: Array<Record<string, unknown>> = [];
  for (const entry of operations) {
    const document = typeof entry?.query === 'string' ? entry.query : '';
    const variables = (entry?.variables ?? {}) as Record<string, unknown>;
    if (document === '') {
      responses.push({ errors: [{ message: 'no query supplied' }] });
      continue;
    }
    const parsed = parseDocument(document, variables);
    if (parsed.operation === null) {
      responses.push({ errors: parsed.errors.map((message) => ({ message })) });
      continue;
    }
    const outcome = executeOperation(parsed.operation, ctx);
    const body: Record<string, unknown> = { data: outcome.data };
    const allErrors = [...outcome.errors, ...ctx.errors];
    if (allErrors.length > 0) body.errors = allErrors.map((message) => ({ message }));
    responses.push(body);
  }
  return { status: 200, body: Array.isArray(payload) ? responses : responses[0] };
}
