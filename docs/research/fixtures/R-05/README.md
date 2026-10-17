# R-05 fixtures — Azure OpenAI

Six probe scripts and the output each one produced on 2026-09-05 — three for the round-2 repair
(below) and three more for the round-3 repair (at the foot of this file). Every `.txt` in this
directory was written by redirecting the matching `.mjs`; none of it was typed by hand, and
none of it was abridged.

No Azure subscription, resource, key or deployment was available in this environment, so
none of these probes calls Azure. What they *do* is executed rather than read: the request
probe runs the official client and captures the bytes it was about to send, and the spec
probe parses Microsoft's published OpenAPI file locally instead of asking a summarizer what
it says.

## Regenerating

The probes are run **outside the repository** so no `node_modules/` or lockfile lands in the
tree (§5.1 rule 6). From a scratch directory:

```bash
mkdir -p /tmp/r05-probe && cd /tmp/r05-probe
printf '{"name":"r05-probe","private":true,"type":"module"}\n' > package.json
npm install openai @anthropic-ai/sdk

curl -sS -o azure-v1-v1-generated.json \
  https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/ai/data-plane/OpenAI.v1/azure-v1-v1-generated.json

cp <repo>/docs/research/fixtures/R-05/*.mjs .
# probe-azure-request.mjs is not committed as a file - see "Why one probe lives in this
# README" below. Save the fenced block at the foot of this README as probe-azure-request.mjs.
node probe-openapi-spec.mjs      > probe-openapi-spec.txt
node probe-azure-request.mjs     > probe-azure-request.txt
node probe-anthropic-refusal.mjs > probe-anthropic-refusal.txt
```

Versions pinned by the committed output: `openai@7.10.0`, `@anthropic-ai/sdk@0.124.0`,
Node v24.19.0, spec file sha256 `9fade08c…43f7a8` (full digest in the output).

## The three probes

| File | What it establishes | Which note section |
| --- | --- | --- |
| `probe-openapi-spec.mjs` / `.txt` | The `api-version` query parameter on the v1 route: optional, default `v1`, enum `["v1","preview"]`. The four `/openai/v1/responses…` paths. `OpenAI.Response.content_filters` and its member shape. `prompt_filter_results[]`/`prompt_index` and `finish_reason: "content_filter"` on Chat Completions. Raw-byte occurrence counts, including `reference-preview` = 0. | Findings 1, 2, 5; Contract summary |
| `probe-azure-request.mjs` (source below) / `.txt` | The URL, query string and auth header the official `openai` client actually emits for Azure, captured from a stub `fetch`: `api-key:` vs `Authorization: Bearer`, the `/openai/deployments/{name}/…` insertion and the exact endpoint set it applies to, and the two constructor errors. | Findings 2, 3, 4 |
| `probe-anthropic-refusal.mjs` / `.txt` | That `StopReason` includes `'refusal'` and that `RefusalStopDetails` exists, read from the shipped `.d.ts`. This is the probe that refutes R-05 round 1's headline "spec contradiction". | "What this contradicts in the specification" |

## What these probes are not

Reading a `.d.ts` or a spec JSON is a **documentation read**, not a live test. §5.1 rule 4
allows only `verified` (tested live), `documented` (primary source, untested) and `unknown`;
nothing established by `probe-openapi-spec.mjs` or `probe-anthropic-refusal.mjs` is therefore
marked `verified` in the note.

`probe-azure-request.mjs` is different in kind — it *executes* the client and observes real
output — but what it tests is the **client library's** request construction, not Azure's
acceptance of that request. The note says so at every row that rests on it.

## Why one probe lives in this README instead of as a `.mjs`

`probe-azure-request.mjs` imports `openai`, a package this repository deliberately does not
declare — the probe runs from the scratch installation above, exactly as the R-06 probes run from
theirs. The §42 boundary gate has a sanctioned verdict for that (ADR-0032 clause 1: an
unresolvable bare specifier inside a research fixture is a classification, not a refusal), but the
classification is asserted as a **set equality** against a literal in `tests/no-sdk-import.test.ts`:

```ts
const PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF = ['@modelcontextprotocol/sdk'];
```

That literal would have to gain `'openai'`, and `tests/no-sdk-import.test.ts` is outside R-05's
Owns globs. **This is reported on PR #45 for whoever owns the boundary gate, not edited here.**
Until the literal gains the name, committing the script as
`docs/research/fixtures/R-05/probe-azure-request.mjs` turns CI red, so its source is reproduced
below verbatim instead — Markdown is `inert` to the gate by design (`INERT_EXTENSIONS`, whose
comment cites the R-01 research note as containing fenced code that imports the
SDK). The block below is the byte-exact source that produced the committed
`probe-azure-request.txt`; nothing was retyped.

When `'openai'` is added to that literal, this block should be moved back out to
`probe-azure-request.mjs` unchanged and this section deleted.

```js
// R-05 probe: what URL and headers does the official `openai` client actually put on
// the wire for Azure OpenAI? Executed, not read. A stub fetch captures the request and
// returns a canned 200 so no Azure resource or credential is required.
import { AzureOpenAI } from 'openai';
import { readFileSync } from 'node:fs';

const V = JSON.parse(readFileSync('node_modules/openai/package.json', 'utf8')).version;
console.log(`openai npm package version: ${V}`);
console.log(`node: ${process.version}`);
console.log('');

const captured = [];
const stubFetch = async (url, init) => {
  const u = new URL(String(url));
  captured.push({
    url: String(url),
    method: init.method,
    path: u.pathname,
    query: u.search === '' ? '(none)' : u.search,
    headers: Object.fromEntries([...new Headers(init.headers)].filter(
      ([k]) => ['api-key', 'authorization', 'content-type'].includes(k))),
  });
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 0, model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

async function probe(label, opts, call) {
  captured.length = 0;
  const client = new AzureOpenAI({ fetch: stubFetch, maxRetries: 0, ...opts });
  try { await call(client); } catch (e) { console.log(`  (call threw: ${e.constructor.name}: ${e.message})`); }
  const c = captured[0];
  console.log(`### ${label}`);
  if (!c) { console.log('  no request was made'); console.log(''); return; }
  console.log(`  method : ${c.method.toUpperCase()}`);
  console.log(`  URL    : ${c.url}`);
  console.log(`  path   : ${c.path}`);
  console.log(`  query  : ${c.query}`);
  for (const [k, v] of Object.entries(c.headers)) console.log(`  header : ${k}: ${v}`);
  console.log('');
}

const ENDPOINT = 'https://example-resource.openai.azure.com';

await probe('A. api-key auth, dated api-version, chat.completions',
  { endpoint: ENDPOINT, apiKey: 'FAKE-KEY-NOT-REAL', apiVersion: '2024-10-21', deployment: 'my-deployment' },
  (c) => c.chat.completions.create({ model: 'my-deployment', messages: [{ role: 'user', content: 'hi' }] }));

await probe('B. api-key auth, dated api-version, responses',
  { endpoint: ENDPOINT, apiKey: 'FAKE-KEY-NOT-REAL', apiVersion: '2024-10-21', deployment: 'my-deployment' },
  (c) => c.responses.create({ model: 'my-deployment', input: 'hi' }));

await probe('C. api-key auth, apiVersion "preview" (the v1 preview route)',
  { endpoint: ENDPOINT, apiKey: 'FAKE-KEY-NOT-REAL', apiVersion: 'preview', deployment: 'my-deployment' },
  (c) => c.responses.create({ model: 'my-deployment', input: 'hi' }));

await probe('D. api-key auth, NO deployment configured, dated api-version',
  { endpoint: ENDPOINT, apiKey: 'FAKE-KEY-NOT-REAL', apiVersion: '2024-10-21' },
  (c) => c.chat.completions.create({ model: 'my-deployment', messages: [{ role: 'user', content: 'hi' }] }));

await probe('E. Microsoft Entra ID auth via azureADTokenProvider',
  { endpoint: ENDPOINT, azureADTokenProvider: async () => 'FAKE.ENTRA.TOKEN', apiVersion: '2024-10-21', deployment: 'my-deployment' },
  (c) => c.chat.completions.create({ model: 'my-deployment', messages: [{ role: 'user', content: 'hi' }] }));

await probe('F. baseURL pinned to the v1 route (no apiVersion given)',
  { baseURL: `${ENDPOINT}/openai/v1`, apiKey: 'FAKE-KEY-NOT-REAL', apiVersion: 'preview' },
  (c) => c.chat.completions.create({ model: 'my-deployment', messages: [{ role: 'user', content: 'hi' }] }));

console.log('### G. constructor validation: apiKey AND azureADTokenProvider together');
try {
  new AzureOpenAI({ endpoint: ENDPOINT, apiKey: 'k', azureADTokenProvider: async () => 't', apiVersion: '2024-10-21' });
  console.log('  accepted (no error)');
} catch (e) { console.log(`  threw ${e.constructor.name}: ${e.message}`); }
console.log('');

console.log('### H. constructor validation: neither endpoint nor baseURL');
try {
  new AzureOpenAI({ apiKey: 'k', apiVersion: '2024-10-21' });
  console.log('  accepted (no error)');
} catch (e) { console.log(`  threw ${e.constructor.name}: ${e.message}`); }

console.log('');
console.log('### I. plain OpenAI client pinned at {endpoint}/openai/v1 with an api-key header');
{
  const { OpenAI } = await import('openai');
  const c = new OpenAI({
    baseURL: `${ENDPOINT}/openai/v1`,
    apiKey: 'unused',
    defaultHeaders: { 'api-key': 'FAKE-KEY-NOT-REAL' },
    fetch: stubFetch, maxRetries: 0,
  });
  for (const [label, fn] of [
    ['chat.completions.create', () => c.chat.completions.create({ model: 'my-deployment', messages: [{ role: 'user', content: 'hi' }] })],
    ['responses.create',        () => c.responses.create({ model: 'my-deployment', input: 'hi' })],
    ['responses.retrieve',      () => c.responses.retrieve('resp_abc')],
    ['responses.delete',        () => c.responses.delete('resp_abc')],
    ['responses.inputItems.list',() => c.responses.inputItems.list('resp_abc')],
    ['responses.cancel',        () => c.responses.cancel('resp_abc')],
  ]) {
    captured.length = 0;
    try { await fn(); } catch {}
    const r = captured[0];
    console.log(`  ${label.padEnd(26)} ${r ? r.method.toUpperCase().padEnd(6) + r.path + (r.query === '(none)' ? '' : r.query) : '(no request)'}`);
  }
}

console.log('');
console.log('### J. openai/azure.js deployment-scoped endpoint set (read from the shipped build)');
{
  const src = readFileSync('node_modules/openai/azure.js', 'utf8');
  const m = src.match(/const _deployments_endpoints = new Set\(\[([\s\S]*?)\]\);/);
  console.log('  ' + m[1].split(',').map(s => s.trim()).filter(Boolean).join(' '));
}
```

---

## Round-3 probes

Round 2 of the fact-check returned FAIL on nine items, six of which were defects the round-1
repair had introduced. Three more probes were run to settle them. Two are committed as `.mjs`
(they import nothing outside `node:`); the third imports `openai`, so its source lives in this
README for the same reason `probe-azure-request.mjs` does.

| File | What it establishes | Frozen items |
| --- | --- | --- |
| `probe-openapi-spec-r3.mjs` / `.txt` | `parallel_tool_calls` on the Responses request and response schemas; that `AzureContentFilterForResponsesAPI.source_type` declares **no** `enum`; the `required` list and all 15 declared properties of `AzureContentFilterResultsForResponsesAPI`; that `OpenAI.ResponseCompletedEvent.response` is `$ref OpenAI.Response`, which carries the same `content_filters` array | B1, B2/N1, N4, N5 |
| `probe-docs-pages-r3.mjs` / `.txt` | Which code tab / zone pivot of the api-version-lifecycle and switching-endpoints pages carries which `.default` scope, with the Go extracts verbatim; the endpoints page's bearer-token sentence; what the Responses how-to page's field table and REST-tab sample body do and do not say about `source_type`; the Responses REST reference rows for `parallel_tool_calls`, `source_type`, `jailbreak` and `task_adherence` | B1, B2/N1, N3, N5, N6 |
| `probe-azure-redirect.mjs` (source below) / `.txt` | Which `openai@7.10.0` client configurations set `init.redirect = "manual"` on a key-bearing request, and which leave it unset; where in the shipped build the behaviour lives | B3/N2 |

### Regenerating the round-3 probes

From the same scratch directory as above (`openai@7.10.0` installed, and the OpenAPI file
downloaded to `azure-v1-v1-generated.json`):

```bash
node probe-openapi-spec-r3.mjs > probe-openapi-spec-r3.txt
node probe-azure-redirect.mjs  > probe-azure-redirect.txt

curl -sSL -A "Mozilla/5.0" -o page-api-version-lifecycle.html https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
curl -sSL -A "Mozilla/5.0" -o page-switching-endpoints.html   https://learn.microsoft.com/en-us/azure/developer/ai/how-to/switching-endpoints
curl -sSL -A "Mozilla/5.0" -o page-endpoints.html             https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints
curl -sSL -A "Mozilla/5.0" -o page-howto-responses.html       https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses
curl -sSL -A "Mozilla/5.0" -o page-responses-rest.html        "https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses?view=rest-microsoft-foundry-v1"
node probe-docs-pages-r3.mjs > probe-docs-pages-r3.txt
```

`probe-docs-pages-r3.txt` prints each page's byte count and a sha256 prefix, so a re-runner can
tell immediately whether the page changed under them. The five pages were fetched 2026-09-05;
`learn.microsoft.com` reflows these articles, so byte counts will drift and the *tallies*, not the
digests, are the thing to compare.

`probe-azure-redirect.mjs` is the second probe here that **executes** the client library. Like
`probe-azure-request.mjs` it proves what the client does, never what Azure accepts, and every row
resting on it says so.

### `probe-azure-redirect.mjs` — source

Committed here rather than as a `.mjs` file for the reason given above: it imports `openai`, and
`PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF` in `tests/no-sdk-import.test.ts` is outside R-05's Owns
globs. The block below is the byte-exact source that produced `probe-azure-redirect.txt`.

```js
// R-05 round-3 probe: does openai@7.10.0 set `redirect: "manual"` on "any request
// carrying an api-key header"? Executed against a stub fetch; no Azure resource needed.
//   node probe-azure-redirect.mjs > probe-azure-redirect.txt
import { AzureOpenAI, OpenAI } from 'openai';
import { readFileSync } from 'node:fs';

console.log(`openai npm package version: ${JSON.parse(readFileSync('node_modules/openai/package.json', 'utf8')).version}`);
console.log(`node: ${process.version}`);
console.log('');
console.log('### A. what `init.redirect` is, per client configuration, on chat.completions.create');
console.log('');

let seen = null;
const stubFetch = async (url, init) => {
  const h = Object.fromEntries([...new Headers(init.headers)]);
  seen = {
    redirect: Object.prototype.hasOwnProperty.call(init, 'redirect') ? String(init.redirect) : '(unset)',
    'api-key header': 'api-key' in h,
    'authorization header': 'authorization' in h,
  };
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 0, model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const E = 'https://example-resource.openai.azure.com';
const cases = [
  ['AzureOpenAI + apiKey', () => new AzureOpenAI({ endpoint: E, apiKey: 'FAKE-KEY-NOT-REAL', apiVersion: '2024-10-21', deployment: 'my-deployment', fetch: stubFetch, maxRetries: 0 })],
  ['AzureOpenAI + azureADTokenProvider', () => new AzureOpenAI({ endpoint: E, azureADTokenProvider: async () => 'FAKE.ENTRA.TOKEN', apiVersion: '2024-10-21', deployment: 'my-deployment', fetch: stubFetch, maxRetries: 0 })],
  ['plain OpenAI, baseURL {endpoint}/openai/v1, defaultHeaders {api-key}', () => new OpenAI({ baseURL: `${E}/openai/v1`, apiKey: 'unused', defaultHeaders: { 'api-key': 'FAKE-KEY-NOT-REAL' }, fetch: stubFetch, maxRetries: 0 })],
];
for (const [label, make] of cases) {
  seen = null;
  const c = make();
  try { await c.chat.completions.create({ model: 'my-deployment', messages: [{ role: 'user', content: 'hi' }] }); }
  catch (e) { console.log(`  (threw ${e.constructor.name}: ${e.message})`); }
  console.log(`  ${label}`);
  console.log(`    ${JSON.stringify(seen)}`);
}
console.log('');
console.log('### B. where the behaviour lives: the only two redirect assignments in openai/azure.js');
{
  const src = readFileSync('node_modules/openai/azure.js', 'utf8').split('\n');
  for (let i = 0; i < src.length; i++) {
    if (src[i].includes('redirect')) console.log(`  azure.js:${i + 1}: ${src[i].trim()}`);
  }
  console.log('  enclosing methods: AzureOpenAI.buildRequest() and AzureOpenAI.fetchWithAuth(),');
  console.log('  both guarded by `headers.has("api-key")`. The base OpenAI class overrides neither.');
}
```

`azure.js` is not the only file in the package that mentions `redirect` — `bedrock.*` and the
X.509 / workload-identity auth helpers set it too — but none of those is on the Azure api-key
path, which is why §B reads only `azure.js`.
