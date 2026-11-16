// MCP over streamable HTTP at /mcp (POST JSON-RPC, GET SSE stream): initialize handshake across the
// three protocol revisions, tools/list with the github-mcp-server tool set, tools/call with the
// content envelope the client parses, and the error conventions for unknown tools and bad arguments.

import { parseTree } from './git-objects.ts';
import { Store } from './store.ts';
import type { Scenario } from './scenario.ts';

export interface McpContext {
  store: Store;
  scenario: Scenario;
  token: string;
  authed: boolean;
}

const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function textContent(text: string): Record<string, unknown> {
  return { type: 'text', text };
}

function contentResult(text: string, structured?: Record<string, unknown>): Record<string, unknown> {
  return structured === undefined
    ? { content: [textContent(text)] }
    : { content: [textContent(text)], structuredContent: structured };
}

function errorResult(message: string, structured?: Record<string, unknown>): Record<string, unknown> {
  return { isError: true, content: [textContent(message)], ...(structured !== undefined ? { structuredContent: structured } : {}) };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolSpec[] = [
  {
    name: 'get_me',
    description: 'Get the authenticated user',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_repository',
    description: 'Create a new GitHub repository',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' }, autoInit: { type: 'boolean' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update a single file in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        message: { type: 'string' },
        branch: { type: 'string' },
      },
      required: ['owner', 'repo', 'path', 'content', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'push_files',
    description: 'Push multiple files in a single commit',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        message: { type: 'string' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      },
      required: ['owner', 'repo', 'branch', 'message', 'files'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file_contents',
    description: 'Get file or directory contents',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
      required: ['owner', 'repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, from_branch: { type: 'string' } },
      required: ['owner', 'repo', 'branch'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_commits',
    description: 'List commits',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, sha: { type: 'string' }, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'issue_number', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' }, commit_title: { type: 'string' }, merge_method: { type: 'string' } },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a pull request',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pull_request_files',
    description: 'List files changed in a pull request',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function requireArgs(args: Record<string, unknown>, required: readonly string[]): string | null {
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return `Missing required argument: ${key}`;
  }
  return null;
}

function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === 'number' ? value : fallback;
}

/** Execute a tools/call. Returns { result } for a tool result envelope or { rpcError } for -32602. */
function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; invalid?: string } {
  const { store } = ctx;
  const spec = TOOLS.find((entry) => entry.name === name);
  if (spec === undefined) return { result: errorResult(`Unknown tool: ${name}`) };
  if (args === undefined || args === null || typeof args !== 'object') return { invalid: 'Invalid params: arguments must be an object' };
  const missing = requireArgs(args, (spec.inputSchema.required as readonly string[]) ?? []);
  if (missing !== null) return { invalid: `Invalid params: ${missing}` };
  if (!ctx.authed) return { result: errorResult('Bad credentials') };

  switch (name) {
    case 'get_me': {
      const me = { login: store.identity.login, id: 1, name: store.identity.name, email: store.identity.email };
      return { result: contentResult(JSON.stringify(me), me) };
    }
    case 'create_repository': {
      const repoName = str(args, 'name');
      if (!/^[A-Za-z0-9_.-]+$/.test(repoName)) return { result: errorResult('Invalid repository name') };
      const repo = store.createRepo(repoName, { description: str(args, 'description') || undefined, private: args.private === true });
      const summary = { name: repo.name, full_name: `${store.identity.login}/${repo.name}`, private: repo.private, default_branch: repo.defaultBranch };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'create_or_update_file': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const branch = str(args, 'branch', repo.defaultBranch);
      const outcome = store.commitChanges(repo, branch, new Map([[str(args, 'path'), Buffer.from(str(args, 'content'), 'utf8')]]), { message: str(args, 'message') });
      if (outcome === 'no-branch' || outcome === null) return { result: errorResult(`Branch not found: ${branch}`) };
      const summary = { commit: { sha: outcome.commitOid }, content: { path: str(args, 'path') } };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'push_files': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const changes = new Map<string, Buffer>();
      for (const entry of (args.files ?? []) as Array<{ path: string; content: string }>) {
        changes.set(String(entry.path), Buffer.from(String(entry.content), 'utf8'));
      }
      const outcome = store.commitChanges(repo, str(args, 'branch'), changes, { message: str(args, 'message') });
      if (outcome === 'no-branch' || outcome === null) return { result: errorResult(`Branch not found: ${str(args, 'branch')}`) };
      const summary = { commit: { sha: outcome.commitOid } };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'get_file_contents': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const ref = str(args, 'ref', repo.defaultBranch);
      const tip = store.resolveRevision(repo, ref);
      if (tip === undefined) return { result: errorResult(`Ref not found: ${ref}`) };
      const resolved = store.resolvePath(repo, tip, str(args, 'path'));
      if (resolved === undefined || resolved === null) return { result: errorResult('File not found') };
      if (resolved.kind === 'file') {
        const object = store.get(repo, resolved.oid);
        const text = object ? object.data.toString('utf8') : '';
        return { result: contentResult(text, { path: str(args, 'path'), content: text }) };
      }
      const dirObject = store.get(repo, resolved.oid);
      const entries = dirObject ? parseTree(dirObject.data) : [];
      const listing = entries.map((entry) => ({ path: `${str(args, 'path')}/${entry.name}`.replace(/^\/+/, ''), type: entry.mode === '40000' ? 'dir' : 'file' }));
      return { result: contentResult(JSON.stringify(listing), { entries: listing }) };
    }
    case 'create_branch': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const from = str(args, 'from_branch', repo.defaultBranch);
      const tip = store.resolveRevision(repo, from);
      if (tip === undefined) return { result: errorResult(`Ref not found: ${from}`) };
      repo.refs.set(`refs/heads/${str(args, 'branch')}`, tip);
      const summary = { ref: `refs/heads/${str(args, 'branch')}`, sha: tip };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'list_commits': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const ref = str(args, 'sha', repo.defaultBranch);
      const tip = store.resolveRevision(repo, ref);
      if (tip === undefined) return { result: errorResult(`Ref not found: ${ref}`) };
      const commits = store.walkCommits(repo, tip, num(args, 'per_page', 30));
      const listing = commits.map((oid) => ({ sha: oid }));
      return { result: contentResult(JSON.stringify(listing), { commits: listing }) };
    }
    case 'create_issue': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const labels = Array.isArray(args.labels) ? (args.labels as string[]).map(String) : undefined;
      const created = store.createIssue(repo, { title: str(args, 'title'), body: str(args, 'body') || undefined, labels });
      if (created === 'bad-label') return { result: errorResult('Label not found') };
      const summary = { number: created.number, title: created.title, state: created.state, html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${created.number}` };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'list_issues': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const state = str(args, 'state', 'open');
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const listing = issues.slice(0, num(args, 'per_page', 30)).map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }));
      return { result: contentResult(JSON.stringify(listing), { issues: listing }) };
    }
    case 'get_issue': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const issue = store.getIssue(repo, num(args, 'issue_number', -1));
      if (issue === undefined) return { result: errorResult('Issue not found') };
      const summary = { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((entry) => ({ name: entry })) };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'add_issue_comment': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const issue = store.getIssue(repo, num(args, 'issue_number', -1));
      if (issue === undefined) return { result: errorResult('Issue not found') };
      const comment = store.addComment(repo, issue, str(args, 'body'));
      const summary = { id: comment.id, body: comment.body };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const created = store.createPull(repo, { title: str(args, 'title'), body: str(args, 'body') || undefined, head: str(args, 'head'), base: str(args, 'base', repo.defaultBranch) });
      if (created === 'bad-refs') return { result: errorResult('Invalid head or base branch') };
      const summary = { number: created.number, title: created.title, state: created.state, html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${created.number}` };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const pull = store.getPull(repo, num(args, 'pull_number', -1));
      if (pull === undefined) return { result: errorResult('Pull request not found') };
      const outcome = store.squashMerge(repo, pull.head, pull.base);
      if (outcome === 'conflict') return { result: errorResult('Pull request has conflicts') };
      if (outcome === 'unknown') return { result: errorResult('Pull request is not mergeable') };
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = outcome.sha;
      const summary = { merged: true, sha: outcome.sha };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'get_pull_request': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const pull = store.getPull(repo, num(args, 'pull_number', -1));
      if (pull === undefined) return { result: errorResult('Pull request not found') };
      const summary = { number: pull.number, title: pull.title, state: pull.state, merged: pull.merged, head: { ref: pull.head }, base: { ref: pull.base } };
      return { result: contentResult(JSON.stringify(summary), summary) };
    }
    case 'list_pull_requests': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const state = str(args, 'state', 'open');
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      const listing = pulls.slice(0, num(args, 'per_page', 30)).map((pull) => ({ number: pull.number, title: pull.title, state: pull.state }));
      return { result: contentResult(JSON.stringify(listing), { pulls: listing }) };
    }
    case 'get_pull_request_files': {
      const repo = store.getRepo(str(args, 'owner'), str(args, 'repo'));
      if (repo === undefined) return { result: errorResult('Repository not found') };
      const pull = store.getPull(repo, num(args, 'pull_number', -1));
      if (pull === undefined) return { result: errorResult('Pull request not found') };
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      if (headTip === undefined || baseTip === undefined) return { result: errorResult('Pull request branches are gone') };
      const files = store.pullFiles(repo, pull);
      const listing = files.map((entry) => ({ filename: entry.filename, status: entry.status, additions: 1, deletions: 1 }));
      void baseTip;
      return { result: contentResult(JSON.stringify(listing), { files: listing }) };
    }
    default:
      return { result: errorResult(`Unknown tool: ${name}`) };
  }
}

function handleRequest(ctx: McpContext, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id;
  const method = request.method ?? '';
  if (method === 'server/discover') {
    const requested = typeof request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (request.params._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] as string
      : PREFERRED_REVISION;
    if (!SUPPORTED_REVISIONS.includes(requested)) {
      return rpcError(id, -32022, `Unsupported protocol version: ${requested}`);
    }
    return rpcResult(id, {
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', title: 'GitHub Core Clone', version: '1.0.0' } },
      serverInfo: { name: 'github-core-clone', title: 'GitHub Core Clone', version: '1.0.0' },
      capabilities: { tools: { listChanged: false } },
      supportedVersions: SUPPORTED_REVISIONS,
      protocolVersion: requested,
    });
  }
  if (method === 'initialize') {
    const requested = typeof request.params?.protocolVersion === 'string' ? (request.params.protocolVersion as string) : PREFERRED_REVISION;
    const negotiated = requested;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false }, logging: {} },
      serverInfo: { name: 'github-core-clone', title: 'GitHub Core Clone', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
  }
  if (method === 'tools/call') {
    const toolName = typeof request.params?.name === 'string' ? (request.params.name as string) : '';
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') return rpcError(id, -32602, 'Invalid params: missing tool name');
    const outcome = callTool(ctx, toolName, args);
    if (outcome.invalid !== undefined) return rpcError(id, -32602, outcome.invalid);
    return rpcResult(id, outcome.result ?? errorResult('tool failed'));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** POST /mcp. Returns null for notification-only bodies (204). */
export function handleMcpPost(ctx: McpContext, body: unknown): { status: number; body: unknown } | null {
  if (!ctx.authed) {
    return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } } };
  }
  if (Array.isArray(body)) {
    const replies = body.map((entry) => handleRequest(ctx, entry as JsonRpcRequest)).filter((reply) => reply !== null);
    return { status: 200, body: replies };
  }
  const reply = handleRequest(ctx, body as JsonRpcRequest);
  if (reply === null) return null;
  return { status: 200, body: reply };
}

export const MCP_PREFERRED_REVISION = PREFERRED_REVISION;
export const MCP_SUPPORTED_REVISIONS = SUPPORTED_REVISIONS;
