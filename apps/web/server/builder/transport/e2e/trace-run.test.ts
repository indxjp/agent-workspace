/**
 * [US-BLD-04][api][run] The trace id a journal row carries is never one the caller chose. A
 * framework that adopts an inbound `traceparent` as the request span's parent (Next.js does) would
 * otherwise let a run join its journal rows to any trace id it likes (review of #1897).
 */
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WORKSPACE, builderDoor } from './harness';

const FORGED_TRACE = '0123456789abcdef0123456789abcdef';
const FORGED = `00-${FORGED_TRACE}-0123456789abcdef-01`;

let sdk: NodeSDK;

beforeAll(() => {
  // The production tracing setup: it installs the W3C propagator and the async context manager.
  sdk = new NodeSDK({ spanProcessors: [] });
  sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
});

describe('[US-BLD-04][api][run] the journalled trace id is minted by the server', () => {
  it('a forged inbound traceparent is not the trace id of the journal row', async () => {
    const door = builderDoor({
      featureOn: true,
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]),
    });
    const { runId, token } = await door.start({ role: 'builder' }, 'scripted:trace');

    // What the framework does for an inbound request: the server span's parent is the forged one.
    const inbound = propagation.extract(context.active(), { traceparent: FORGED });
    const span = trace.getTracer('test').startSpan('POST /api/builder/mcp', {}, inbound);
    expect(span.spanContext().traceId).toBe(FORGED_TRACE);
    await context.with(trace.setSpan(inbound, span), () =>
      door.call(token, 'catalog_list', { kinds: ['engines'] }, { traceparent: FORGED }),
    );
    span.end();

    const rows = door.journal.filter((row) => row.runId === runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(rows[0]?.traceId).not.toBe(FORGED_TRACE);
  });
});
