// The forge server: one Node http server that serves /healthz, the REST v3 surface under /api/v3,
// git smart HTTP under /:owner/:repo.git/*, GraphQL at /api/graphql and MCP at /mcp.
//
// The store boots empty: the conformance suite creates everything it reads through the API, and the
// viewer's identity comes from the scenario the kit ships (buildScenario() is seedless).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buildScenario } from './scenario.ts';
import { Store } from './store.ts';
import type { Repo } from './store.ts';
import { handleRest } from './rest.ts';
import { infoRefs, uploadPackV2, uploadPackV0, receivePack } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcpPost, MCP_PREFERRED_REVISION } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (auth.startsWith('token ')) return auth.slice(6).trim();
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return (colon >= 0 ? decoded.slice(colon + 1) : decoded).trim();
  }
  const header = req.headers['x-forge-token'];
  return typeof header === 'string' && header !== '' ? header : null;
}

export interface AppOptions {
  /** The bearer token every API call must present. */
  token?: string;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(options: AppOptions = {}): Server {
  const scenario = buildScenario();
  const store = new Store(scenario.viewer, scenario.labels);
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? 'forge-token';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let path = '/';
      try {
        path = new URL(req.url ?? '/', 'http://forge').pathname;
      } catch {
        path = '/';
      }
      const body = await readBody(req);
      const presented = bearerToken(req);
      const authed = presented === token;

      // Boot probe.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack
      const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path)
        ?? /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        const [, owner, repoName, action] = gitMatch;
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (method === 'GET' && action === 'info/refs') {
          const service = new URL(req.url ?? '/', 'http://forge').searchParams.get('service') ?? 'git-upload-pack';
          const v2 = new URL(req.url ?? '/', 'http://forge').searchParams.get('v2') !== null
            || String(req.headers['git-protocol'] ?? '').includes('version=2');
          const reply = infoRefs(store, repo, service === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack', v2);
          res.writeHead(reply.status, { 'content-type': reply.contentType, 'cache-control': 'no-cache' });
          res.end(reply.body);
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (action === 'git-upload-pack') {
          const isV2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
          const reply = isV2
            ? await uploadPackV2(store, repo, body)
            : await uploadPackV0(store, repo, body);
          res.writeHead(reply.status, { 'content-type': reply.contentType, ...(reply.headers ?? {}) });
          res.end(reply.body);
          return;
        }
        if (action === 'git-receive-pack') {
          const reply = await receivePack(store, repo, body);
          res.writeHead(reply.status, { 'content-type': reply.contentType, ...(reply.headers ?? {}) });
          res.end(reply.body);
          return;
        }
      }

      // GraphQL v4
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        let payload: unknown = null;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const outcome = handleGraphQL({ store, scenario, token, authed, errors: [] }, payload);
        sendJson(res, outcome.status, outcome.body);
        return;
      }

      // MCP streamable HTTP
      if (path === '/mcp') {
        if (method === 'GET') {
          // No GET stream in the modern revision: the client only ever POSTs; answer 405 JSON.
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        let payload: unknown = null;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        const reply = handleMcpPost({ store, scenario, token, authed }, payload);
        if (reply === null) {
          res.writeHead(202).end();
          return;
        }
        sendJson(res, reply.status, reply.body, { 'mcp-protocol-version': MCP_PREFERRED_REVISION });
        return;
      }

      // REST v3
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const sub = path.slice('/api/v3'.length) || '/';
        const reply = await handleRest({ store, scenario, token, authed }, method, sub, req, res, req.url ?? '/', body);
        if (reply.raw) {
          res.writeHead(reply.status, { 'content-type': 'application/x-git-upload-pack-advertisement', ...(reply.headers ?? {}) });
          res.end(reply.body);
          return;
        }
        sendJson(res, reply.status, reply.body, reply.headers ?? {});
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
      if (!res.headersSent) sendJson(res, 500, { message: 'Server Error', detail });
      else res.end();
    });
  });
}

export type { Repo };
