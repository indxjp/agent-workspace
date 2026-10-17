import { describe, expect, it } from 'vitest';

import { createAzureOpenAIProvider, buildAzureOpenAIUrl } from './azure-openai.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { createOpenAIProvider } from './openai.js';
import {
  hostedToolField,
  unrelayableToolType,
  relayedBody,
  vendorStateField,
} from './passthrough.js';
import type {
  ForwardRequest,
  RequestContext,
  WireProtocol,
  WireProtocolForwarder,
} from '../types.js';

type Capture = {
  readonly calls: { url: string; init: RequestInit }[];
  readonly fetch: typeof fetch;
};

/** The URL a `fetch` double was called with. Every adapter passes a string; the other two shapes
are narrowed rather than stringified, which `no-base-to-string` requires. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function capture(response: () => Response): Capture {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport: typeof fetch = (input, init) => {
    calls.push({ url: urlOf(input), init: init ?? {} });
    return Promise.resolve(response());
  };
  return { calls, fetch: transport };
}

const RUN_TOKEN = 'run-token-the-upstream-must-never-see';

function context(headers?: Readonly<Record<string, string>>): RequestContext {
  return {
    providerId: 'openai',
    credential: 'stored-provider-credential',
    requestId: 'request-passthrough',
    settings: {},
    requestHeaders: new Headers({
      authorization: `Bearer ${RUN_TOKEN}`,
      cookie: 'session=should-not-travel',
      'openai-beta': 'responses=v1',
      'x-forwarded-for': '203.0.113.7',
      ...headers,
    }),
  };
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('a relayed body must be a JSON string');
  return JSON.parse(init.body) as Record<string, unknown>;
}

const PROTOCOLS = ['openai-responses', 'openai-chat-completions'] as const;

type AdapterCase = {
  readonly id: string;
  readonly create: (transport: typeof fetch) => WireProtocolForwarder;
  readonly credentialHeader: 'authorization' | 'api-key';
  readonly expectedUrl: Readonly<Record<WireProtocol, string>>;
  /** Azure relays its deployment rather than the client's model (ADR-0068 D8). */
  readonly relayedModel: string;
};

const ADAPTERS: readonly AdapterCase[] = [
  {
    id: 'openai',
    create: (transport) =>
      createOpenAIProvider({ baseUrl: 'http://localhost/oai/v1', fetch: transport }),
    credentialHeader: 'authorization',
    expectedUrl: {
      'openai-responses': 'http://localhost/oai/v1/responses',
      'openai-chat-completions': 'http://localhost/oai/v1/chat/completions',
      'anthropic-messages': '',
    },
    relayedModel: 'gpt-client-choice',
  },
  {
    id: 'azure-openai',
    create: (transport) =>
      createAzureOpenAIProvider({
        endpoint: 'http://localhost',
        deployment: 'prod-deployment',
        fetch: transport,
      }),
    credentialHeader: 'api-key',
    expectedUrl: {
      'openai-responses': 'http://localhost/openai/v1/responses',
      'openai-chat-completions': 'http://localhost/openai/v1/chat/completions',
      'anthropic-messages': '',
    },
    relayedModel: 'prod-deployment',
  },
  {
    id: 'openai-compatible',
    create: (transport) =>
      createOpenAICompatibleProvider({ baseUrl: 'http://localhost/vllm/v1', fetch: transport }),
    credentialHeader: 'authorization',
    expectedUrl: {
      'openai-responses': 'http://localhost/vllm/v1/responses',
      'openai-chat-completions': 'http://localhost/vllm/v1/chat/completions',
      'anthropic-messages': '',
    },
    relayedModel: 'gpt-client-choice',
  },
];

const request: ForwardRequest = { model: 'gpt-client-choice', input: 'hi' };

describe.each(ADAPTERS)('$id relays the OpenAI dialects', (adapter) => {
  it.each(PROTOCOLS)('addresses the upstream %s endpoint', async (protocol) => {
    const transport = capture(() => Response.json({ id: 'resp_1' }));
    await adapter.create(transport.fetch).forward(request, protocol, context());
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(adapter.expectedUrl[protocol]);
    expect(bodyOf(transport.calls[0]?.init ?? {})['model']).toBe(adapter.relayedModel);
  });

  it.each(PROTOCOLS)(
    'substitutes the stored credential and drops the run token (%s)',
    async (protocol) => {
      const transport = capture(() => Response.json({ id: 'resp_1' }));
      await adapter.create(transport.fetch).forward(request, protocol, context());
      const init = transport.calls[0]?.init ?? {};
      const expected =
        adapter.credentialHeader === 'authorization'
          ? 'Bearer stored-provider-credential'
          : 'stored-provider-credential';
      expect(headerOf(init, adapter.credentialHeader)).toBe(expected);
      expect(JSON.stringify([...new Headers(init.headers)])).not.toContain(RUN_TOKEN);
      // Only the named client headers travel; everything else is dropped (ADR-0068 D7).
      expect(headerOf(init, 'openai-beta')).toBe('responses=v1');
      expect(headerOf(init, 'cookie')).toBeNull();
      expect(headerOf(init, 'x-forwarded-for')).toBeNull();
    },
  );

  // The allowlist names headers rather than matching an `openai-` prefix: these two choose which
  // organisation and project on the *stored* credential serves and is billed for the turn, which is
  // the model connection's decision and not the sandboxed caller's (ADR-0068 D7).
  it.each(['openai-organization', 'openai-project'])(
    'does not relay the client header %s, which would pick the billed account',
    async (name) => {
      const transport = capture(() => Response.json({ id: 'resp_1' }));
      await adapter
        .create(transport.fetch)
        .forward(request, 'openai-responses', context({ [name]: 'org-not-ours' }));
      const init = transport.calls[0]?.init ?? {};
      expect(headerOf(init, name)).toBeNull();
      expect(JSON.stringify([...new Headers(init.headers)])).not.toContain('org-not-ours');
    },
  );

  it('streams a relayed response through without buffering it', async () => {
    const wire = 'data: {"type":"response.completed"}\n\n';
    const transport = capture(
      () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
    );
    const response = await adapter
      .create(transport.fetch)
      .forward({ ...request, stream: true }, 'openai-responses', context());
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(wire);
  });

  it('rebuilds the client response from an allowlist, so no upstream header leaks', async () => {
    const transport = capture(
      () =>
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'upstream-req-1',
            'set-cookie': 'upstream_session=leaked',
            'openai-organization': 'org-not-ours',
            'api-key': 'stored-provider-credential',
          },
        }),
    );
    const response = await adapter
      .create(transport.fetch)
      .forward(request, 'openai-responses', context());
    expect(response.headers.get('x-request-id')).toBe('upstream-req-1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('openai-organization')).toBeNull();
    expect(response.headers.get('api-key')).toBeNull();
    expect(JSON.stringify([...response.headers])).not.toContain('stored-provider-credential');
  });

  it('relays an upstream failure status and body rather than reshaping it', async () => {
    const transport = capture(() =>
      Response.json({ error: { message: 'model overloaded' } }, { status: 503 }),
    );
    const response = await adapter
      .create(transport.fetch)
      .forward(request, 'openai-chat-completions', context());
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('model overloaded');
  });

  it('turns on usage reporting for a streamed chat completion the client did not ask it for', async () => {
    const transport = capture(() => Response.json({ id: 'chatcmpl_1' }));
    await adapter
      .create(transport.fetch)
      .forward({ ...request, stream: true }, 'openai-chat-completions', context());
    expect(bodyOf(transport.calls[0]?.init ?? {})['stream_options']).toEqual({
      include_usage: true,
    });
  });

  it('merges rather than replaces the stream_options the client sent', async () => {
    const transport = capture(() => Response.json({ id: 'chatcmpl_1' }));
    await adapter
      .create(transport.fetch)
      .forward(
        { ...request, stream: true, stream_options: { include_obfuscation: false } },
        'openai-chat-completions',
        context(),
      );
    expect(bodyOf(transport.calls[0]?.init ?? {})['stream_options']).toEqual({
      include_obfuscation: false,
      include_usage: true,
    });
  });

  it('leaves a non-streaming chat completion body alone', async () => {
    const transport = capture(() => Response.json({ id: 'chatcmpl_1' }));
    await adapter.create(transport.fetch).forward(request, 'openai-chat-completions', context());
    expect(bodyOf(transport.calls[0]?.init ?? {})).not.toHaveProperty('stream_options');
  });

  it('refuses anthropic-messages, which it translates rather than relays', async () => {
    const transport = capture(() => Response.json({}));
    const response = await adapter
      .create(transport.fetch)
      .forward(request, 'anthropic-messages', context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'protocol_not_supported_for_connection' },
    });
    expect(transport.calls).toEqual([]);
  });

  it.each([
    'web_search',
    'file_search',
    'code_interpreter',
    'image_generation',
    'mcp',
    'computer_use_preview',
    'shell',
    'a_tool_type_openai_has_not_shipped_yet',
  ])('refuses the vendor-hosted tool %s and sends nothing upstream', async (type) => {
    const transport = capture(() => Response.json({}));
    const response = await adapter
      .create(transport.fetch)
      .forward({ ...request, tools: [{ type }] }, 'openai-responses', context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'hosted_tool_not_permitted', code: 'hosted_tool_not_permitted' },
    });
    expect(transport.calls).toEqual([]);
  });

  it('relays a function tool, which runs inside the sandbox', async () => {
    const transport = capture(() => Response.json({ id: 'resp_1' }));
    const response = await adapter
      .create(transport.fetch)
      .forward(
        { ...request, tools: [{ type: 'function', name: 'lookup' }, { type: 'custom' }] },
        'openai-responses',
        context(),
      );
    expect(response.status).toBe(200);
    expect(transport.calls).toHaveLength(1);
  });

  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'refuses a top-level web_search_options on %s and sends nothing upstream',
    async (protocol) => {
      const transport = capture(() => Response.json({}));
      const response = await adapter
        .create(transport.fetch)
        .forward({ ...request, web_search_options: {} }, protocol, context());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'hosted_tool_not_permitted', code: 'hosted_tool_not_permitted' },
      });
      expect(transport.calls).toEqual([]);
    },
  );

  it('relays store: false on a Responses request the client said nothing about', async () => {
    const transport = capture(() => Response.json({ id: 'resp_1' }));
    await adapter.create(transport.fetch).forward(request, 'openai-responses', context());
    expect(bodyOf(transport.calls[0]?.init ?? {})['store']).toBe(false);
  });

  it('overwrites a client store: true rather than relaying vendor-side retention', async () => {
    const transport = capture(() => Response.json({ id: 'resp_1' }));
    await adapter
      .create(transport.fetch)
      .forward({ ...request, store: true }, 'openai-responses', context());
    expect(bodyOf(transport.calls[0]?.init ?? {})['store']).toBe(false);
  });

  // A stored Chat Completion is retained at the vendor too, outside `session_transcripts`, so the
  // retention half of the rule applies to this dialect as much as to the Responses API.
  it.each([undefined, true, false])(
    'relays store: false on a Chat Completions request whose client sent store: %s',
    async (clientStore) => {
      const transport = capture(() => Response.json({ id: 'chatcmpl_1' }));
      await adapter
        .create(transport.fetch)
        .forward(
          { ...request, ...(clientStore === undefined ? {} : { store: clientStore }) },
          'openai-chat-completions',
          context(),
        );
      expect(bodyOf(transport.calls[0]?.init ?? {})['store']).toBe(false);
    },
  );

  it.each(['previous_response_id', 'conversation', 'prompt'])(
    'refuses %s with vendor_state_not_permitted and sends nothing upstream',
    async (field) => {
      const transport = capture(() => Response.json({}));
      const response = await adapter
        .create(transport.fetch)
        .forward({ ...request, [field]: 'resp_elsewhere' }, 'openai-responses', context());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'vendor_state_not_permitted', code: 'vendor_state_not_permitted' },
      });
      expect(transport.calls).toEqual([]);
    },
  );

  // The rule is about where the state lives, so a field the Chat Completions API does not define
  // cannot become permissible by arriving on that route.
  it('refuses previous_response_id on Chat Completions too', async () => {
    const transport = capture(() => Response.json({}));
    const response = await adapter
      .create(transport.fetch)
      .forward(
        { ...request, previous_response_id: 'resp_elsewhere' },
        'openai-chat-completions',
        context(),
      );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'vendor_state_not_permitted' },
    });
    expect(transport.calls).toEqual([]);
  });

  // A stored prompt object carries its own instructions and its own tools, so relaying the
  // reference would also let a hosted tool through a body that declares no `tools` at all.
  it('refuses a stored prompt reference with vendor_state_not_permitted', async () => {
    const transport = capture(() => Response.json({}));
    const response = await adapter
      .create(transport.fetch)
      .forward(
        { ...request, prompt: { id: 'pmpt_elsewhere', version: '3' } },
        'openai-responses',
        context(),
      );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'vendor_state_not_permitted', code: 'vendor_state_not_permitted' },
    });
    expect(transport.calls).toEqual([]);
  });

  it('refuses background: true on the Responses route and sends nothing upstream', async () => {
    const transport = capture(() => Response.json({}));
    const response = await adapter
      .create(transport.fetch)
      .forward({ ...request, background: true }, 'openai-responses', context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'background_not_supported', code: 'background_not_supported' },
    });
    expect(transport.calls).toEqual([]);
  });
});

describe('the hosted-tool rule is a closed allowlist', () => {
  it('permits a request with no tools at all', () => {
    expect(unrelayableToolType({ model: 'm' })).toBeNull();
    expect(unrelayableToolType({ model: 'm', tools: [] })).toBeNull();
  });

  it('refuses a tool entry that names no type, rather than assuming it is a function', () => {
    expect(unrelayableToolType({ model: 'm', tools: [{ name: 'lookup' }] })).toBe('unnamed');
    expect(unrelayableToolType({ model: 'm', tools: ['web_search'] })).toBe('unnamed');
  });

  it('names the first refused tool even when a permitted one comes before it', () => {
    expect(
      unrelayableToolType({ model: 'm', tools: [{ type: 'function' }, { type: 'web_search' }] }),
    ).toBe('web_search');
  });

  it('names the top-level field that asks for a hosted tool without declaring one', () => {
    expect(hostedToolField({ model: 'm' })).toBeNull();
    expect(hostedToolField({ model: 'm', tools: [{ type: 'function' }] })).toBeNull();
    expect(hostedToolField({ model: 'm', web_search_options: {} })).toBe('web_search_options');
    // Present but empty or `null` still asks for it: only an absent field does not.
    expect(hostedToolField({ model: 'm', web_search_options: null })).toBe('web_search_options');
  });
});

describe('vendor-side conversation state is named wherever it is asked for', () => {
  it('names nothing for a request that keeps its context in the request', () => {
    expect(vendorStateField({ model: 'm' })).toBeNull();
    expect(vendorStateField({ model: 'm', input: 'hi', store: false })).toBeNull();
  });

  it('names every such field, and a present-but-empty one as well', () => {
    expect(vendorStateField({ model: 'm', previous_response_id: 'resp_1' })).toBe(
      'previous_response_id',
    );
    expect(vendorStateField({ model: 'm', conversation: 'conv_1' })).toBe('conversation');
    expect(vendorStateField({ model: 'm', prompt: { id: 'pmpt_1' } })).toBe('prompt');
    expect(vendorStateField({ model: 'm', previous_response_id: null })).toBe(
      'previous_response_id',
    );
  });
});

describe('the relayed body', () => {
  it('pins the model only when the adapter asks for it', () => {
    expect(relayedBody({ model: 'client' }, 'openai-responses')).toEqual({
      model: 'client',
      store: false,
    });
    expect(relayedBody({ model: 'client' }, 'openai-responses', 'deployment')).toEqual({
      model: 'deployment',
      store: false,
    });
  });

  it('never injects stream_options into a Responses request, which has no such field', () => {
    expect(relayedBody({ model: 'm', stream: true }, 'openai-responses')).toEqual({
      model: 'm',
      stream: true,
      store: false,
    });
  });

  it('states store: false on every Responses body, whatever the client sent', () => {
    expect(relayedBody({ model: 'm' }, 'openai-responses')['store']).toBe(false);
    expect(relayedBody({ model: 'm', store: true }, 'openai-responses')['store']).toBe(false);
    expect(relayedBody({ model: 'm', store: false }, 'openai-responses')['store']).toBe(false);
  });

  // `store` is about retention as well as resumption: a stored Chat Completion leaves the turn's
  // prompt and completion at the vendor, outside `session_transcripts`, so this dialect gets the same
  // `store: false` as the Responses API and is otherwise relayed as the client wrote it.
  it('states store: false on every Chat Completions body, whatever the client sent', () => {
    expect(relayedBody({ model: 'm', store: true }, 'openai-chat-completions')).toEqual({
      model: 'm',
      store: false,
    });
    expect(relayedBody({ model: 'm' }, 'openai-chat-completions')).toEqual({
      model: 'm',
      store: false,
    });
    expect(relayedBody({ model: 'm', store: false }, 'openai-chat-completions')['store']).toBe(
      false,
    );
  });

  it('leaves an anthropic-messages body alone, which is translated rather than relayed', () => {
    expect(relayedBody({ model: 'm', store: true }, 'anthropic-messages')).toEqual({
      model: 'm',
      store: true,
    });
  });
});

describe('Azure passthrough URLs come from buildAzureOpenAIUrl', () => {
  it.each([
    [undefined, 'openai-responses'],
    [undefined, 'openai-chat-completions'],
    ['preview', 'openai-responses'],
    ['2024-10-21', 'openai-chat-completions'],
    ['2024-10-21', 'openai-responses'],
  ] as const)('matches the %s surface for %s', async (apiVersion, protocol) => {
    const transport = capture(() => Response.json({ id: 'resp_1' }));
    const provider = createAzureOpenAIProvider({
      endpoint: 'http://localhost',
      deployment: 'prod-deployment',
      ...(apiVersion === undefined ? {} : { apiVersion }),
      fetch: transport.fetch,
    });
    await provider.forward(request, protocol, context());
    const operation = protocol === 'openai-responses' ? 'responses' : 'chat/completions';
    expect(transport.calls[0]?.url).toBe(
      buildAzureOpenAIUrl('http://localhost', 'prod-deployment', apiVersion, operation),
    );
  });
});
