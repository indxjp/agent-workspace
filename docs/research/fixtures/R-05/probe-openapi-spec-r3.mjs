// R-05 round-3 probe: the four facts round 2 got wrong about Microsoft's published
// OpenAPI file, read from the file itself. Documentation read, not a live call.
//   curl -sS -o azure-v1-v1-generated.json \
//     https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/ai/data-plane/OpenAI.v1/azure-v1-v1-generated.json
//   node probe-openapi-spec-r3.mjs > probe-openapi-spec-r3.txt
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FILE = 'azure-v1-v1-generated.json';
const raw = readFileSync(FILE, 'utf8');
const bytes = readFileSync(FILE);
const spec = JSON.parse(raw);
const S = spec.components.schemas;
const count = (n) => { let c = 0, i = raw.indexOf(n); while (i !== -1) { c++; i = raw.indexOf(n, i + 1); } return c; };
const j = (x) => JSON.stringify(x);

console.log(`node: ${process.version}`);
console.log(`file: ${FILE}  bytes: ${bytes.length}`);
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`);
console.log('');

console.log('### 1. parallel_tool_calls on the Responses surface  (frozen item B1)');
console.log(`  POST /responses requestBody schema         : ${j(spec.paths['/responses'].post.requestBody.content['application/json'].schema)}`);
console.log(`  OpenAI.CreateResponse.parallel_tool_calls  : ${j(S['OpenAI.CreateResponse'].properties.parallel_tool_calls)}`);
console.log(`  OpenAI.Response.parallel_tool_calls        : ${j(S['OpenAI.Response'].properties.parallel_tool_calls)}`);
console.log(`  OpenAI.Response.required includes it       : ${S['OpenAI.Response'].required.includes('parallel_tool_calls')}`);
console.log(`  raw occurrences of "parallel_tool_calls"   : ${count('parallel_tool_calls')}`);
console.log('');

console.log('### 2. content_filters member: source_type has no enum  (frozen items B2 / N1)');
console.log(`  AzureContentFilterForResponsesAPI.required            : ${j(S['AzureContentFilterForResponsesAPI'].required)}`);
console.log(`  AzureContentFilterForResponsesAPI.properties.source_type: ${j(S['AzureContentFilterForResponsesAPI'].properties.source_type)}`);
console.log(`  raw occurrences of "source_type"                      : ${count('source_type')}`);
console.log('');

console.log('### 3. the inner content_filter_results object  (frozen item N5)');
console.log(`  AzureContentFilterResultsForResponsesAPI.required  : ${j(S['AzureContentFilterResultsForResponsesAPI'].required)}`);
console.log('  AzureContentFilterResultsForResponsesAPI.properties (all, in declaration order):');
for (const k of Object.keys(S['AzureContentFilterResultsForResponsesAPI'].properties)) console.log(`    ${k}`);
console.log('');

console.log('### 4. the terminal streaming event carries the same object  (frozen item N4)');
const ev = S['OpenAI.ResponseCompletedEvent'];
console.log(`  OpenAI.ResponseCompletedEvent.required      : ${j(ev.required)}`);
console.log(`  ...properties.type                          : ${j(ev.properties.type.enum)}`);
console.log(`  ...properties.response                      : ${j(ev.properties.response.allOf)}`);
console.log(`  OpenAI.Response.properties.content_filters  : ${j(S['OpenAI.Response'].properties.content_filters)}`);
