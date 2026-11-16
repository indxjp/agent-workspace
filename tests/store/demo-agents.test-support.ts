/**
 * The demo agent of every live Agent Store entry, imported by literal specifier so the repository's
 * import gates (the §42 SDK boundary, the database reachability gate and the in-memory run store
 * gate) can read each one. Keyed by the agent file's repository path, `<source>/agents/<agent>.ts`,
 * which is what a catalog entry names. A new live entry fails `demoAgentDefinition` until its agent
 * is listed here.
 */
import cadDrafting from '../gallery/cad-drafting/agents/cad-drafting.ts';
import contractReview from '../gallery/contract-review/agents/contract-review.ts';
import customerInquiry from '../gallery/customer-inquiry/agents/customer-inquiry.ts';
import excelConsolidation from '../gallery/excel-consolidation/agents/excel-consolidation.ts';
import maintenanceTroubleshooting from '../gallery/maintenance-troubleshooting/agents/maintenance-troubleshooting.ts';
import manualSearch from '../gallery/manual-search/agents/manual-search.ts';
import meetingMinutes from '../gallery/meeting-minutes/agents/meeting-minutes.ts';
import qualityDefect from '../gallery/quality-defect/agents/quality-defect.ts';
import quotation from '../gallery/quotation/agents/quotation.ts';
import ringiReview from '../gallery/ringi-review/agents/ringi-review.ts';
import salesAssistant from '../../examples/crm/agents/sales-assistant.ts';
import triage from '../../examples/service-desk/agents/triage.ts';
import helper from '../../examples/team-chat/agents/helper.ts';
import writer from '../../examples/wiki/agents/writer.ts';
import type { CatalogEntry } from '../../examples/store/catalog/define.ts';

const DEMO_AGENTS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['tests/gallery/cad-drafting/agents/cad-drafting.ts', cadDrafting],
  ['tests/gallery/contract-review/agents/contract-review.ts', contractReview],
  ['tests/gallery/customer-inquiry/agents/customer-inquiry.ts', customerInquiry],
  ['tests/gallery/excel-consolidation/agents/excel-consolidation.ts', excelConsolidation],
  [
    'tests/gallery/maintenance-troubleshooting/agents/maintenance-troubleshooting.ts',
    maintenanceTroubleshooting,
  ],
  ['tests/gallery/manual-search/agents/manual-search.ts', manualSearch],
  ['tests/gallery/meeting-minutes/agents/meeting-minutes.ts', meetingMinutes],
  ['tests/gallery/quality-defect/agents/quality-defect.ts', qualityDefect],
  ['tests/gallery/quotation/agents/quotation.ts', quotation],
  ['tests/gallery/ringi-review/agents/ringi-review.ts', ringiReview],
  ['examples/crm/agents/sales-assistant.ts', salesAssistant],
  ['examples/service-desk/agents/triage.ts', triage],
  ['examples/team-chat/agents/helper.ts', helper],
  ['examples/wiki/agents/writer.ts', writer],
]);

/** The default export of `entry`'s demo agent file; throws when the file is not listed above. */
export function demoAgentDefinition(entry: CatalogEntry): unknown {
  if (entry.status !== 'live') throw new Error(`${entry.slug} is not live and has no demo agent`);
  const file = `${entry.source}/agents/${entry.demo.agent}.ts`;
  if (!DEMO_AGENTS.has(file)) {
    throw new Error(
      `${entry.slug}: its demo agent ${file} is not listed in demo-agents.test-support.ts`,
    );
  }
  return DEMO_AGENTS.get(file);
}
