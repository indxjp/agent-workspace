/**
 * The storage design, §05 "A signed link leaks": a signed link is never
 * written to logs. Both presign routes are driven through the real handlers with a store whose URL
 * carries a sentinel signature in each cloud's form; every place the web app writes telemetry —
 * the JSON logger, `console.*`, exported spans, audit — must hold neither the sentinel nor the URL.
 * The 201 body must still carry the URL, so a pass cannot mean the route never signed. The complete
 * step that follows an upload is driven too: it neither signs nor logs a link.
 */
import { trace } from '@opentelemetry/api';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import * as tracing from '@opentelemetry/sdk-trace';
import { format } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { POST as downloadUrlRoute } from '../../app/api/files/[id]/download-urls/route';
import { POST as completeRoute } from '../../app/api/files/[id]/upload-complete/route';
import { POST as uploadUrlRoute } from '../../app/api/files/[id]/upload-urls/route';
import {
  bytesToStream,
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';

import type { AuditRuntime } from '../audit/runtime';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { redactingExporter } from '../telemetry/redact-span';
import { captureLog } from '../telemetry/capture-log';
import { log as webLog } from '../telemetry/logger';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { encodeFileId } from './file-id';
import { createCatalogFilesWorld, type CatalogFilesWorld } from './catalog-runtime-fixtures';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ACTOR_HEADER = 'x-test-actor';
const FILE = 'docs/a.txt';

/** One signed URL per cloud, each carrying a signature nobody may ever read back from telemetry. */
const FORMS = [
  { cloud: 's3', signature: 'X-Amz-Signature=S3SENTINELsig0123456789abcdef' },
  { cloud: 'gcs', signature: 'X-Goog-Signature=GCSSENTINELsig0123456789abcdef' },
  { cloud: 'azure', signature: 'sv=2024-11-04&sig=AZSENTINEL%2Bsig%2F0123456789%3D' },
] as const;
type Form = (typeof FORMS)[number];

const urlFor = (form: Form): string =>
  `https://store.invalid/${WORKSPACE}/${FILE}?X-Test=1&${form.signature}`;

type Mode = { readonly kind: 'sign' } | { readonly kind: 'fail' };

function signingObjects(form: Form, mode: Mode): ObjectStoreV2 {
  const inner = createInMemoryObjectStore();
  return {
    ...inner,
    capabilities: { ...inner.capabilities, sign: true },
    createSignedUrl: () =>
      mode.kind === 'fail'
        ? Promise.reject(new Error(`signing failed for ${urlFor(form)}`))
        : Promise.resolve({ url: urlFor(form), headers: {} }),
  };
}

let world: CatalogFilesWorld;

let auditTouched = 0;
let consoleSpies: MockInstance[] = [];
let consoleText: string[] = [];
let log: ReturnType<typeof captureLog>;
let spans: tracing.InMemorySpanExporter;
let provider: tracing.TracerProvider;

beforeEach(() => {
  auditTouched = 0;
  consoleText = [];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleText.push(format(...args));
    }),
  );
  log = captureLog();
  spans = new tracing.InMemorySpanExporter();
  provider = new tracing.TracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor({ exporter: redactingExporter(spans) })],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  clearApplicationContext();
  log.restore();
  for (const spy of consoleSpies) spy.mockRestore();
  trace.disable();
  await provider.shutdown();
});

function configure(form: Form, mode: Mode): void {
  world = createCatalogFilesWorld({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver(
      [WORKSPACE].map((id, index) => ({ id, slug: `workspace-${String(index)}` })),
    ),
    resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    objects: signingObjects(form, mode),
    log: webLog,
  });
  installTestDomains({
    audit: new Proxy({} as AuditRuntime, {
      get() {
        auditTouched += 1;
        throw new Error('the presign path must not touch audit');
      },
    }),
    files: { kind: 'serving', runtime: world.runtime },
    rbac: {
      directory: createMemoryDirectory({
        users: [
          { email: 'owner@example.test', name: 'Owner', workspaceId: WORKSPACE, role: 'owner' },
        ],
      }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
            apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceId: WORKSPACE,
            role: 'owner',
            label: 'Signed link test key',
          }),
        ),
    },
  });
}

const BYTES = new TextEncoder().encode('bytes');
const MEMBER = {
  workspaceId: WORKSPACE,
  principalId: '37d41bbb-42d1-4a16-8f5d-de3fef42eed0',
  userId: null,
};

async function seedFile(): Promise<void> {
  const saved = await world.storage.save(MEMBER, {
    area: 'files',
    path: FILE,
    maxBytes: 1024,
    replace: true,
    body: bytesToStream(BYTES),
  });
  if (!saved.ok) throw new Error(`seeding was refused: ${saved.code}`);
}

/** What the browser's `PUT` does once it has a link: the bytes land in the pending row's object. */
async function putToPendingObject(): Promise<void> {
  const catalog = await world.catalogs.forWorkspace(WORKSPACE);
  const pending = await catalog.pending(FILE);
  if (pending?.objectId === null || pending?.objectId === undefined) {
    throw new Error('no pending row to upload to');
  }
  await world.objects.write(storageObjectName(WORKSPACE, 'files', pending.objectId), BYTES, {
    contentType: 'text/plain',
  });
}

function mint(route: typeof uploadUrlRoute, sub: string, body: unknown): Promise<Response> {
  return route(
    new Request(`https://example.invalid/api/files/${encodeFileId(FILE)}/${sub}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTOR_HEADER]: 'owner' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: encodeFileId(FILE) }) },
  );
}

const completeUpload = () =>
  completeRoute(
    new Request(`https://example.invalid/api/files/${encodeFileId(FILE)}/upload-complete`, {
      method: 'POST',
      headers: { [ACTOR_HEADER]: 'owner' },
    }),
    { params: Promise.resolve({ id: encodeFileId(FILE) }) },
  );

const mintUpload = () => mint(uploadUrlRoute, 'upload-urls', { sizeBytes: 5 });
const mintDownload = () => mint(downloadUrlRoute, 'download-urls', {});

/** Everything the app wrote to a log, console, span or audit sink while the test ran. */
function telemetry(): string {
  const exported = spans.getFinishedSpans().map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
  }));
  return [log.text(), ...consoleText, JSON.stringify(exported)].join('\n');
}

/** The value after the last `=`: the bare signature, searched for on its own. */
const signatureValue = (form: Form): string => form.signature.split('=').pop() ?? '';

function expectNoLink(form: Form): void {
  const written = telemetry();
  expect(written).not.toContain(signatureValue(form));
  expect(written).not.toContain(form.signature);
  expect(written).not.toContain(urlFor(form));
  expect(auditTouched).toBe(0);
}

/**
 * A failed signing answers `502 storage_unavailable` and logs one redacted line: the provider
 * error's name, never its message, which here carries the link.
 */
async function expectFailureLeaksNothing(
  form: Form,
  minted: Promise<Response>,
  logLine: string,
): Promise<void> {
  const response = await minted;
  expect(response.status, form.cloud).toBe(502);
  const body = await response.text();
  expect(JSON.parse(body), form.cloud).toMatchObject({ error: { code: 'storage_unavailable' } });
  expect(body, form.cloud).not.toContain(signatureValue(form));
  expect(log.text(), form.cloud).toContain(logLine);
  expect(log.text(), form.cloud).not.toContain('https://');
  expectNoLink(form);
}

describe('a signed link is never written to telemetry', () => {
  // @story US-STO-05
  it('[US-STO-05][api][sdk] a download link is never logged', async () => {
    for (const form of FORMS) {
      configure(form, { kind: 'sign' });
      await seedFile();
      const response = await mintDownload();
      expect(response.status, form.cloud).toBe(201);
      expect(((await response.json()) as { url: string }).url, form.cloud).toBe(urlFor(form));
      expectNoLink(form);
    }
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] an upload link is never logged', async () => {
    for (const form of FORMS) {
      configure(form, { kind: 'sign' });
      const response = await mintUpload();
      expect(response.status, form.cloud).toBe(201);
      expect(((await response.json()) as { url: string }).url, form.cloud).toBe(urlFor(form));
      expectNoLink(form);
    }
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] completing an upload never logs or returns a link', async () => {
    for (const form of FORMS) {
      configure(form, { kind: 'sign' });
      expect((await mintUpload()).status, form.cloud).toBe(201);
      await putToPendingObject();
      const response = await completeUpload();
      expect(response.status, form.cloud).toBe(200);
      expect(await response.text(), form.cloud).not.toContain(signatureValue(form));
      expectNoLink(form);
    }
  });

  // @story US-STO-05
  it('[US-STO-05][api][sdk] a download link is not logged when signing fails', async () => {
    for (const form of FORMS) {
      configure(form, { kind: 'fail' });
      await seedFile();
      await expectFailureLeaksNothing(form, mintDownload(), '[files] signing failed');
    }
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] an upload link is not logged when signing fails', async () => {
    for (const form of FORMS) {
      configure(form, { kind: 'fail' });
      await expectFailureLeaksNothing(
        form,
        mintUpload(),
        '[storage] signing an upload link failed',
      );
    }
  });
});
