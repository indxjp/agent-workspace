// R-05 round-3 probe: four claims round 2 made about vendor docs pages, checked against
// the pages' own HTML rather than a summarizer. Fetch first, then run:
//   curl -sSL -A "Mozilla/5.0" -o page-api-version-lifecycle.html https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
//   curl -sSL -A "Mozilla/5.0" -o page-switching-endpoints.html   https://learn.microsoft.com/en-us/azure/developer/ai/how-to/switching-endpoints
//   curl -sSL -A "Mozilla/5.0" -o page-endpoints.html             https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints
//   curl -sSL -A "Mozilla/5.0" -o page-howto-responses.html       https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses
//   node probe-docs-pages-r3.mjs > probe-docs-pages-r3.txt
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const idxs = (hay, n) => { const o = []; let i = hay.indexOf(n); while (i !== -1) { o.push(i); i = hay.indexOf(n, i + 1); } return o; };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ');
const load = (f) => { const h = readFileSync(f, 'utf8'); console.log(`  ${f}  ${readFileSync(f).length} bytes  sha256 ${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)}…`); return h; };

console.log(`node: ${process.version}   pages fetched 2026-09-05`);
console.log('');
console.log('### 0. the four page files this probe reads');
const life = load('page-api-version-lifecycle.html');
const sw = load('page-switching-endpoints.html');
const ep = load('page-endpoints.html');
const hr = load('page-howto-responses.html');
console.log('');

console.log('### 1. api-version-lifecycle: which code tabs carry https://ai.azure.com/.default  (frozen item N3)');
{
  const secs = [];
  for (const i of idxs(life, 'data-tab="')) {
    const j = life.indexOf('"', i + 10);
    if (life.slice(j + 1, j + 40).includes('tabindex')) continue; // a tab header, not a panel
    secs.push({ i, p: life.slice(i + 10, j) });
  }
  secs.forEach((s, k) => { s.label = `group${Math.floor(k / 6) + 1}:${s.p}`; });
  console.log(`  tab panels on the page, in order: ${JSON.stringify(secs.map((s) => s.label))}`);
  for (const n of ['ai.azure.com/.default', 'cognitiveservices.azure.com/.default', 'WithTokenCredential']) {
    const tally = {};
    for (const h of idxs(life, n)) {
      let cur = '(outside any tab panel)';
      for (const s of secs) { if (s.i < h) cur = s.label; else break; }
      tally[cur] = (tally[cur] || 0) + 1;
    }
    console.log(`  "${n}" -> ${JSON.stringify(tally)}`);
  }
  const g = idxs(life, 'WithTokenCredential')[0];
  console.log('  the Go tab, verbatim:');
  for (const l of text(life.slice(g - 300, g + 40)).split('\n').map((s) => s.trim()).filter(Boolean).slice(-6)) console.log(`    ${l}`);
}
console.log('');

console.log('### 2. switching-endpoints: which language zone pivots carry the cognitiveservices scope  (frozen item N3)');
{
  const secs = [];
  for (const i of idxs(sw, 'data-pivot="')) { const j = sw.indexOf('"', i + 12); secs.push({ i, p: sw.slice(i + 12, j) }); }
  console.log(`  zone pivots present: ${JSON.stringify([...new Set(secs.map((s) => s.p))])}`);
  for (const n of ['cognitiveservices.azure.com/.default', 'ai.azure.com/.default', 'WithTokenCredential']) {
    const tally = {};
    for (const h of idxs(sw, n)) {
      let cur = '(outside any pivot)';
      for (const s of secs) { if (s.i < h) cur = s.p; else break; }
      tally[cur] = (tally[cur] || 0) + 1;
    }
    console.log(`  "${n}" -> ${JSON.stringify(tally)}`);
  }
  const g = idxs(sw, 'WithTokenCredential')[0];
  console.log('  the golang pivot, verbatim:');
  for (const l of text(sw.slice(g - 240, g + 40)).split('\n').map((s) => s.trim()).filter(Boolean).slice(-5)) console.log(`    ${l}`);
}
console.log('');

console.log('### 3. endpoints page: is the Authorization-bearer-with-resource-key form documented?  (frozen item N6)');
{
  const t = text(ep);
  const i = t.indexOf('Pass your key in the');
  console.log('  verbatim:');
  for (const l of t.slice(i, i + 300).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6)) console.log(`    ${l}`);
}
console.log('');

console.log('### 4. Responses how-to page: what it does and does not say about source_type  (frozen items B2 / N1 / N5)');
{
  const t = text(hr);
  console.log(`  occurrences of "source_type": ${idxs(t, 'source_type').length}`);
  const i = t.indexOf('Each entry describes one filter result');
  console.log('  the field table, verbatim:');
  for (const l of t.slice(i, i + 700).split('\n').map((s) => s.trim()).filter(Boolean)) console.log(`    ${l}`);
  console.log(`  occurrences of the literal '"source_type": "prompt"'      : ${idxs(hr, '"source_type": "prompt"').length}`);
  console.log(`  occurrences of the literal '"source_type": "completion"' : ${idxs(hr, '"source_type": "completion"').length}`);
  console.log(`  occurrences of "task_adherence"                           : ${idxs(t, 'task_adherence').length}`);
  console.log(`  occurrences of "content_filter_offsets"                   : ${idxs(t, 'content_filter_offsets').length}`);
  const k = hr.indexOf('"source_type": "prompt"');
  const start = hr.lastIndexOf('<pre><code class="lang-json">', k);
  const end = hr.indexOf('</code></pre>', k);
  console.log('  the REST tab sample response body, verbatim:');
  for (const l of hr.slice(start + 29, end).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').split(String.fromCharCode(10))) console.log(`    ${l}`);

}

console.log('');
console.log('### 5. Responses REST reference: the rows for the three disputed fields  (frozen items B1 / B2 / N5)');
console.log('   https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses?view=rest-microsoft-foundry-v1');
{
  const rr = load('page-responses-rest.html');
  const title = rr.slice(rr.indexOf('<title>') + 7, rr.indexOf('</title>'));
  console.log(`  page title: ${title}`);
  const rows = rr.split('<tr>').slice(1).map((r) => r.slice(0, r.indexOf('</tr>')));
  const wanted = ['parallel_tool_calls', 'source_type', 'jailbreak', 'task_adherence'];
  const seen = new Set();
  for (const r of rows) {
    const cells = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim());
    if (!cells.length || !wanted.includes(cells[0])) continue;
    const key = cells.slice(0, 5).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  Name=${cells[0]}  Type=${cells[1]}  Required=${cells[3]}  Default=${cells[4] || '(none)'}`);
    console.log(`    Description: ${cells[2] || '(empty)'}`);
  }
  console.log('  (columns are the reference table headers: Name, Type, Description, Required, Default)');
}
