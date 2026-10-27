/**
 * The HTTP edge: body reading, response shaping, and the workspace gate every route goes through.
 *
 * The gate assertions are the point of this file. `withWorkspaceStore` is the only path from a
 * request to a store, so row-level workspace scoping — this repository's extension of spec §25's
 * intent, stated in the header of `store.ts` and not quoted from the specification — is true of
 * the whole API exactly as far as these hold, including the unconfigured case, which must fail
 * rather than fall through to an empty-but-successful answer (ADR-0015).
 */
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
} from '../../contracts/agents';
import type { ApiProblem, ApiResult } from '../http/result';
import { MAX_REQUEST_BODY_BYTES, readAgentIdParam, readJsonBody, withWorkspaceStore } from './http';
import { apiResultResponse } from '../http/json-transport';
import { createInMemoryAgentStoreProvider } from './memory-store';
import { type WorkspaceResolution } from './runtime';
import type { WorkspaceAgentStore } from './store';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  clearApplicationContext();
});

function codeOf(result: ApiResult): string {
  const problem = result.body as Partial<ApiProblem>;
  const code = problem.error?.code;
  if (typeof code !== 'string') {
    throw new Error(`expected an error envelope, received ${JSON.stringify(result.body)}`);
  }
  return code;
}

function jsonRequest(payload: string, contentType: string | null = 'application/json'): Request {
  const headers = contentType === null ? {} : { 'content-type': contentType };
  return new Request('https://example.invalid/api/agents', {
    method: 'POST',
    headers,
    body: payload,
  });
}

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    const outcome = await readJsonBody(jsonRequest('{"name":"A"}'));
    expect(outcome).toEqual({ ok: true, value: { name: 'A' } });
  });

  it('accepts a charset parameter on the content type', async () => {
    const outcome = await readJsonBody(jsonRequest('{}', 'application/json; charset=utf-8'));
    expect(outcome.ok).toBe(true);
  });

  it('accepts the media type in any case', async () => {
    const outcome = await readJsonBody(jsonRequest('{}', 'Application/JSON'));
    expect(outcome.ok).toBe(true);
  });

  it('returns 415 when no Content-Type is declared', async () => {
    const outcome = await readJsonBody(jsonRequest('{}', null));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(415);
    expect(codeOf(outcome.result)).toBe('unsupported_media_type');
  });

  it('returns 415 for a form post rather than trying to parse it', async () => {
    const outcome = await readJsonBody(jsonRequest('name=A', 'application/x-www-form-urlencoded'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(415);
  });

  it('returns 400 for an empty body instead of an empty object', async () => {
    const outcome = await readJsonBody(jsonRequest(''));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(400);
    expect(codeOf(outcome.result)).toBe('malformed_body');
  });

  it('returns 400 for bytes that are not JSON', async () => {
    const outcome = await readJsonBody(jsonRequest('{"name": '));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(codeOf(outcome.result)).toBe('malformed_body');
  });

  it('passes a non-object JSON value through, so the body parser rejects it by name', async () => {
    const outcome = await readJsonBody(jsonRequest('[1,2,3]'));
    expect(outcome).toEqual({ ok: true, value: [1, 2, 3] });
  });
});

describe('readJsonBody bounds the request body in bytes, not only the fields in it', () => {
  /**
   * A body whose `instructions` is the longest the contract will accept, written with a character
   * `JSON.stringify` escapes to six bytes — the worst case `MAX_REQUEST_BODY_BYTES` is derived
   * from. If the bound were set by guesswork rather than derived, this is the request it would
   * wrongly reject.
   */
  function largestLegalBody(): string {
    return JSON.stringify({
      name: 'A'.repeat(AGENT_NAME_MAX_LENGTH),
      instructions: '\u0001'.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH),
      modelConnectionId: null,
      model: 'A'.repeat(AGENT_MODEL_MAX_LENGTH),
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: true,
      },
    });
  }

  it('accepts the largest body the agent contract can legally produce', async () => {
    const body = largestLegalBody();
    // The premise of the assertion, stated so a future change to the bound cannot make this pass
    // by making the body small: this really is a body of hundreds of kilobytes.
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(
      AGENT_INSTRUCTIONS_MAX_LENGTH * 5,
    );
    const outcome = await readJsonBody(jsonRequest(body));
    expect(outcome.ok).toBe(true);
  });

  it('returns 413 for a body one byte over the bound', async () => {
    const overshoot = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1);
    const outcome = await readJsonBody(jsonRequest(overshoot));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(413);
    expect(codeOf(outcome.result)).toBe('request_body_too_large');
  });

  it('bounds a streamed body that declares no Content-Length', async () => {
    // The check that actually holds. A `Request` built from a stream carries no Content-Length, so
    // a bound implemented only as a header check would let this through — and the header is
    // caller-supplied anyway. The stream yields far more than the bound, one chunk at a time, and
    // must be refused without being read to the end.
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Deliberately unbounded: if the reader does not stop, this never finishes.
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request('https://example.invalid/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(request.headers.get('content-length')).toBeNull();

    const outcome = await readJsonBody(request);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(413);
    expect(codeOf(outcome.result)).toBe('request_body_too_large');
    // It stopped: the whole body was never materialised. The reader may sit one chunk past the
    // bound, so the allowance is one chunk, not zero.
    expect(emitted).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES + chunk.byteLength);
  });

  it('returns 400 for a Content-Length that is not a byte count', async () => {
    const request = new Request('https://example.invalid/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    request.headers.set('content-length', 'not-a-number');
    const outcome = await readJsonBody(request);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(400);
    expect(codeOf(outcome.result)).toBe('malformed_body');
  });

  it('returns 400 for bytes that are not valid UTF-8', async () => {
    const request = new Request('https://example.invalid/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    const outcome = await readJsonBody(request);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.result.status).toBe(400);
    expect(codeOf(outcome.result)).toBe('malformed_body');
  });

  it('derives the bound from the instructions bound rather than fixing a number', () => {
    // Stated as a relation, not a transcribed constant: the bound must leave room for the largest
    // legal `instructions` even when every code unit escapes to six bytes.
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(AGENT_INSTRUCTIONS_MAX_LENGTH * 6);
  });
});

describe('apiResultResponse', () => {
  it('serialises a body as JSON with a charset', async () => {
    const response = apiResultResponse({ status: 201, body: { id: 'x' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ id: 'x' });
  });

  it('sends no body and no content type for a 204', async () => {
    const response = apiResultResponse({ status: 204, body: null });
    expect(response.status).toBe(204);
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });
});

describe('readAgentIdParam', () => {
  it('reads the id out of the resolved params', async () => {
    expect(await readAgentIdParam({ params: Promise.resolve({ id: 'abc' }) })).toBe('abc');
  });

  it('yields undefined rather than throwing when params resolved to something else', async () => {
    const context = { params: Promise.resolve(null) } as unknown as {
      params: Promise<{ id: string }>;
    };
    expect(await readAgentIdParam(context)).toBeUndefined();
  });
});

describe('withWorkspaceStore — the gate every agent route passes through', () => {
  function configure(resolution: WorkspaceResolution): void {
    installTestDomains({
      agents: {
        resolveWorkspace: () => Promise.resolve(resolution),
        agents: createInMemoryAgentStoreProvider(),
      },
    });
  }

  const request = new Request('https://example.invalid/api/agents');

  it('returns 503 when nothing has been wired, never 401 and never an empty success', async () => {
    clearApplicationContext();
    const result = await withWorkspaceStore(request, () =>
      Promise.resolve({ status: 200, body: { agents: [] } }),
    );
    expect(result.status).toBe(503);
    expect(codeOf(result)).toBe('agents_runtime_not_configured');
  });

  it('does not call the handler at all when nothing is wired', async () => {
    clearApplicationContext();
    let called = false;
    await withWorkspaceStore(request, () => {
      called = true;
      return Promise.resolve({ status: 200, body: null });
    });
    expect(called).toBe(false);
  });

  it('returns 401 when the resolver says the caller is not authenticated', async () => {
    configure({ kind: 'unauthenticated', reason: 'No session cookie.' });
    const result = await withWorkspaceStore(request, () =>
      Promise.resolve({ status: 200, body: null }),
    );
    expect(result.status).toBe(401);
    expect(codeOf(result)).toBe('unauthenticated');
  });

  it('returns 403 when the resolver says the caller may not act in that workspace', async () => {
    configure({ kind: 'forbidden', reason: 'Not a member of this workspace.' });
    const result = await withWorkspaceStore(request, () =>
      Promise.resolve({ status: 200, body: null }),
    );
    expect(result.status).toBe(403);
    expect(codeOf(result)).toBe('forbidden');
  });

  it('hands the handler a store bound to the resolved workspace, and nothing else', async () => {
    configure({ kind: 'workspace', workspaceId: WORKSPACE_A });
    let received: WorkspaceAgentStore | null = null;
    await withWorkspaceStore(request, async (store) => {
      received = store;
      const outcome = await store.create(
        {
          name: 'Probe',
          instructions: '',
          modelConnectionId: null,
          model: null,
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
        {
          principalId: '66666666-6666-4666-8666-666666666666',
          userId: '77777777-7777-4777-8777-777777777777',
        },
      );
      expect(outcome.kind === 'created' && outcome.agent.workspaceId).toBe(WORKSPACE_A);
      return { status: 200, body: null };
    });
    expect(received).not.toBeNull();
    // The store's own surface carries no workspace parameter: there is nothing to forget (§25).
    const surface = Object.keys(received ?? {});
    expect(surface.sort()).toEqual([
      'create',
      'createWithAssignments',
      'delete',
      'get',
      'list',
      'replacePolicy',
      'update',
    ]);
  });

  it('passes the request to the resolver, so the workspace is derived from it and not from a global', async () => {
    let seen: Request | null = null;
    installTestDomains({
      agents: {
        resolveWorkspace: (incoming) => {
          seen = incoming;
          return Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A });
        },
        agents: createInMemoryAgentStoreProvider(),
      },
    });
    await withWorkspaceStore(request, () => Promise.resolve({ status: 200, body: null }));
    expect(seen).toBe(request);
  });
});
