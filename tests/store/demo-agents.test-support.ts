/**
 * The demo agent of every Agent Store entry with a source (live, or coming soon with its code
 * merged), imported by literal specifier so the repository's import gates (the §42 SDK boundary, the
 * database reachability gate and the in-memory run store gate) can read each one. Keyed by the agent
 * file's repository path, `<source>/agents/<agent>.ts`, which is what a catalog entry names. An entry
 * that gains a source fails `demoAgentDefinition` (and so its seed) until its agent is listed here.
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
import accountRequests from '../../use-cases/account-requests/agents/account-requests.ts';
import adCompliance from '../../use-cases/ad-compliance/agents/ad-compliance.ts';
import announce from '../../use-cases/announce/agents/announce.ts';
import attendance from '../../use-cases/attendance/agents/attendance.ts';
import budget from '../../use-cases/budget/agents/budget.ts';
import codeReview from '../../use-cases/code-review/agents/code-review.ts';
import dealRisk from '../../use-cases/deal-risk/agents/deal-risk.ts';
import expense from '../../use-cases/expense/agents/expense.ts';
import incident from '../../use-cases/incident/agents/incident.ts';
import invoice from '../../use-cases/invoice/agents/invoice.ts';
import faqBot from '../../use-cases/faq-bot/agents/faq-bot.ts';
import glossary from '../../use-cases/glossary/agents/glossary.ts';
import inspection from '../../use-cases/inspection/agents/inspection.ts';
import interview from '../../use-cases/interview/agents/interview.ts';
import market from '../../use-cases/market/agents/market.ts';
import meetingPrep from '../../use-cases/meeting-prep/agents/meeting-prep.ts';
import nda from '../../use-cases/nda/agents/nda.ts';
import newcomer from '../../use-cases/newcomer/agents/newcomer.ts';
import onboarding from '../../use-cases/onboarding/agents/onboarding.ts';
import policyQa from '../../use-cases/policy-qa/agents/policy-qa.ts';
import privacy from '../../use-cases/privacy/agents/privacy.ts';
import projectStatus from '../../use-cases/project-status/agents/project-status.ts';
import proposal from '../../use-cases/proposal/agents/proposal.ts';
import returns from '../../use-cases/returns/agents/returns.ts';
import screeningHr from '../../use-cases/screening-hr/agents/screening-hr.ts';
import releaseNotes from '../../use-cases/release-notes/agents/release-notes.ts';
import screening from '../../use-cases/screening/agents/screening.ts';
import slaWatch from '../../use-cases/sla-watch/agents/sla-watch.ts';
import standup from '../../use-cases/standup/agents/standup.ts';
import translator from '../../use-cases/translator/agents/translator.ts';
import workInstruction from '../../use-cases/work-instruction/agents/work-instruction.ts';
import { hasSource, type CatalogEntry } from '../../examples/store/catalog/define.ts';

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
  ['use-cases/account-requests/agents/account-requests.ts', accountRequests],
  ['use-cases/ad-compliance/agents/ad-compliance.ts', adCompliance],
  ['use-cases/announce/agents/announce.ts', announce],
  ['use-cases/attendance/agents/attendance.ts', attendance],
  ['use-cases/budget/agents/budget.ts', budget],
  ['use-cases/code-review/agents/code-review.ts', codeReview],
  ['use-cases/deal-risk/agents/deal-risk.ts', dealRisk],
  ['use-cases/expense/agents/expense.ts', expense],
  ['use-cases/incident/agents/incident.ts', incident],
  ['use-cases/invoice/agents/invoice.ts', invoice],
  ['use-cases/faq-bot/agents/faq-bot.ts', faqBot],
  ['use-cases/glossary/agents/glossary.ts', glossary],
  ['use-cases/inspection/agents/inspection.ts', inspection],
  ['use-cases/interview/agents/interview.ts', interview],
  ['use-cases/market/agents/market.ts', market],
  ['use-cases/meeting-prep/agents/meeting-prep.ts', meetingPrep],
  ['use-cases/nda/agents/nda.ts', nda],
  ['use-cases/newcomer/agents/newcomer.ts', newcomer],
  ['use-cases/onboarding/agents/onboarding.ts', onboarding],
  ['use-cases/policy-qa/agents/policy-qa.ts', policyQa],
  ['use-cases/privacy/agents/privacy.ts', privacy],
  ['use-cases/project-status/agents/project-status.ts', projectStatus],
  ['use-cases/proposal/agents/proposal.ts', proposal],
  ['use-cases/returns/agents/returns.ts', returns],
  ['use-cases/screening-hr/agents/screening-hr.ts', screeningHr],
  ['use-cases/release-notes/agents/release-notes.ts', releaseNotes],
  ['use-cases/screening/agents/screening.ts', screening],
  ['use-cases/sla-watch/agents/sla-watch.ts', slaWatch],
  ['use-cases/standup/agents/standup.ts', standup],
  ['use-cases/translator/agents/translator.ts', translator],
  ['use-cases/work-instruction/agents/work-instruction.ts', workInstruction],
]);

/** The default export of `entry`'s demo agent file; throws when the file is not listed above. */
export function demoAgentDefinition(entry: CatalogEntry): unknown {
  if (!hasSource(entry)) throw new Error(`${entry.slug} has no source and no demo agent`);
  const file = `${entry.source}/agents/${entry.demo.agent}.ts`;
  if (!DEMO_AGENTS.has(file)) {
    throw new Error(
      `${entry.slug}: its demo agent ${file} is not listed in demo-agents.test-support.ts`,
    );
  }
  return DEMO_AGENTS.get(file);
}
