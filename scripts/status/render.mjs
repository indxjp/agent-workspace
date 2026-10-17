import { readFile, writeFile } from 'node:fs/promises';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';

const allowedStatuses = new Set([
  'implemented',
  'partial',
  'fixture-verified',
  'live-verified',
  'deferred',
  'unsupported',
]);
const root = new URL('../../', import.meta.url);
const sourceUrl = new URL('docs/capabilities/status.json', root);
const outputUrl = new URL('docs/capability-status.md', root);
const source = JSON.parse(await readFile(sourceUrl, 'utf8'));

if (source.schemaVersion !== 2 || source.canonical !== true) {
  throw new Error('capability status must use schemaVersion 2 and declare itself canonical');
}
if (!Array.isArray(source.capabilities) || source.capabilities.length === 0) {
  throw new Error('capability status must contain at least one capability');
}
const areas = new Set();
for (const [index, capability] of source.capabilities.entries()) {
  if (typeof capability.area !== 'string' || capability.area.trim() === '') {
    throw new Error(`capabilities[${String(index)}].area must be non-empty`);
  }
  if (areas.has(capability.area)) throw new Error(`duplicate capability area: ${capability.area}`);
  areas.add(capability.area);
  if (!allowedStatuses.has(capability.status)) {
    throw new Error(`unsupported status for ${capability.area}: ${String(capability.status)}`);
  }
  if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
    throw new Error(`${capability.area} must name repository evidence`);
  }
  if (typeof capability.id !== 'string' || capability.id.trim() === '') {
    throw new Error(`${capability.area} must have a stable id`);
  }
  if (
    capability.releaseImpact !== 'none' &&
    (typeof capability.evidenceRequirement?.id !== 'string' ||
      capability.evidenceRequirement.id.trim() === '')
  ) {
    throw new Error(`${capability.area} must name a release evidence requirement`);
  }
}

/** @typedef {{ area: string, status: string, releaseImpact: string, evidence: string[] }} Capability */

const escape = (/** @type {unknown} */ value) => String(value).replaceAll('|', '\\|');
const rows = source.capabilities
  .map(
    (/** @type {Capability} */ item) =>
      `| ${escape(item.area)} | ${escape(item.status)} | ${escape(item.releaseImpact)} | ${item.evidence
        .map((/** @type {string} */ path) => `\`${escape(path)}\``)
        .join('<br>')} |`,
  )
  .join('\n');
const output =
  `# Capability status\n\n` +
  `This is generated from \`docs/capabilities/status.json\`; edit the JSON and run ` +
  `\`pnpm status:render\`. “Fixture-verified” is not live-provider, deployed-runtime, or human ` +
  `acceptance evidence.\n\n` +
  `Release verdict: **${escape(source.releaseVerdict)}**.\n\n` +
  `| Capability | Status | Release impact | Evidence |\n` +
  `| --- | --- | --- | --- |\n${rows}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outputUrl, 'utf8').catch(() => '');
  if (current !== output) {
    console.error('docs/capability-status.md is stale; run pnpm status:render');
    process.exit(1);
  }
  console.log('capability status is current');
} else {
  await writeFile(outputUrl, output, 'utf8');
  console.log('wrote docs/capability-status.md');
}
