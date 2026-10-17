// R-05 probe: read Microsoft's published OpenAPI 3 spec for the Azure OpenAI v1
// data plane as raw bytes, and print the exact declarations R-05 cites. No
// summarizing pass: every block below is JSON.stringify of the parsed file.
//
//   curl -sS -o azure-v1-v1-generated.json \
//     https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/ai/data-plane/OpenAI.v1/azure-v1-v1-generated.json
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raw = readFileSync('azure-v1-v1-generated.json');
const text = raw.toString('utf8');
const j = JSON.parse(text);
const S = j.components.schemas;

console.log('### 1. File identity');
console.log('  bytes        :', raw.length);
console.log('  sha256       :', createHash('sha256').update(raw).digest('hex'));
console.log('  openapi      :', j.openapi);
console.log('  info.title   :', j.info.title);
console.log('  info.version :', j.info.version);
console.log('  servers      :', JSON.stringify(j.servers));

console.log('\n### 2. The api-version query parameter');
const seen = new Map();
(function walk(n) {
  if (Array.isArray(n)) return n.forEach(walk);
  if (n && typeof n === 'object') {
    if (n.name === 'api-version' && n.in === 'query') seen.set(JSON.stringify(n), n);
    for (const k of Object.keys(n)) walk(n[k]);
  }
})(j);
console.log(`  distinct declarations: ${seen.size}`);
for (const n of seen.values()) console.log(JSON.stringify(n, null, 2).split('\n').map(l => '  ' + l).join('\n'));
console.log('  AzureAIFoundryModelsApiVersion =', JSON.stringify(S.AzureAIFoundryModelsApiVersion));

console.log('\n### 3. Responses-API paths declared in the spec');
for (const p of Object.keys(j.paths).sort()) {
  if (p.includes('responses')) console.log(`  ${Object.keys(j.paths[p]).filter(k => k !== 'parameters').map(m => m.toUpperCase()).join('/')}  ${j.servers[0].url}${p}`);
}

console.log('\n### 4. Content filtering — Responses API surface');
console.log('  OpenAI.Response.content_filters =', JSON.stringify(S['OpenAI.Response'].properties.content_filters));
const F = S.AzureContentFilterForResponsesAPI;
console.log('  AzureContentFilterForResponsesAPI.properties =', Object.keys(F.properties).join(', '));
console.log('  AzureContentFilterForResponsesAPI.required   =', JSON.stringify(F.required));
console.log('  .blocked      =', JSON.stringify(F.properties.blocked));
console.log('  .source_type  =', JSON.stringify(F.properties.source_type));
console.log('  .content_filter_offsets ->', JSON.stringify(F.properties.content_filter_offsets));
console.log('  AzureContentFilterResultOffsets =', JSON.stringify(S.AzureContentFilterResultOffsets));

console.log('\n### 5. Content filtering — Chat Completions surface');
const cc = j.paths['/chat/completions'].post.responses['200'].content['application/json'].schema.anyOf[0];
console.log('  200 body top-level properties =', Object.keys(cc.properties).join(', '));
const pf = cc.properties.prompt_filter_results;
console.log('  prompt_filter_results.type       =', pf.type);
console.log('  prompt_filter_results.items props=', Object.keys(pf.items.properties).join(', '));
console.log('  prompt_index                     =', JSON.stringify(pf.items.properties.prompt_index));
const CH = S['OpenAI.CreateChatCompletionResponseChoices'];
console.log('  choice properties                =', Object.keys(CH.properties).join(', '));
console.log('  choice.finish_reason             =', JSON.stringify(CH.properties.finish_reason));
console.log('  choice.content_filter_results    =', JSON.stringify(CH.properties.content_filter_results));

console.log('\n### 6. Raw-byte occurrence counts (grep over the undecoded file text)');
for (const tok of ['prompt_filter_results', 'prompt_index', 'content_filters', 'content_filter_results', 'reference-preview'])
  console.log(`  "${tok}": ${(text.match(new RegExp(tok, 'g')) || []).length}`);
