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
import assets from '../../use-cases/assets/agents/assets.ts';
import attendance from '../../use-cases/attendance/agents/attendance.ts';
import budget from '../../use-cases/budget/agents/budget.ts';
import change4m from '../../use-cases/change-4m/agents/change-4m.ts';
import cash from '../../use-cases/cash/agents/cash.ts';
import caseFile from '../../use-cases/case-file/agents/case-file.ts';
import churn from '../../use-cases/churn/agents/churn.ts';
import close from '../../use-cases/close/agents/close.ts';
import codeReview from '../../use-cases/code-review/agents/code-review.ts';
import customerInquiryRebuild from '../../use-cases/customer-inquiry/agents/customer-inquiry.ts';
import dailyReport from '../../use-cases/daily-report/agents/daily-report.ts';
import dashNarrator from '../../use-cases/dash-narrator/agents/dash-narrator.ts';
import dealRisk from '../../use-cases/deal-risk/agents/deal-risk.ts';
import digest from '../../use-cases/digest/agents/digest.ts';
import collections from '../../use-cases/collections/agents/collections.ts';
import competitor from '../../use-cases/competitor/agents/competitor.ts';
import decisionLog from '../../use-cases/decision-log/agents/decision-log.ts';
import escalation from '../../use-cases/escalation/agents/escalation.ts';
import expense from '../../use-cases/expense/agents/expense.ts';
import facility from '../../use-cases/facility/agents/facility.ts';
import incident from '../../use-cases/incident/agents/incident.ts';
import invoice from '../../use-cases/invoice/agents/invoice.ts';
import faqBot from '../../use-cases/faq-bot/agents/faq-bot.ts';
import faqBuilder from '../../use-cases/faq-builder/agents/faq-builder.ts';
import forecast from '../../use-cases/forecast/agents/forecast.ts';
import glossary from '../../use-cases/glossary/agents/glossary.ts';
import handover from '../../use-cases/handover/agents/handover.ts';
import hrQa from '../../use-cases/hr-qa/agents/hr-qa.ts';
import inspection from '../../use-cases/inspection/agents/inspection.ts';
import interview from '../../use-cases/interview/agents/interview.ts';
import kyt from '../../use-cases/kyt/agents/kyt.ts';
import irQa from '../../use-cases/ir-qa/agents/ir-qa.ts';
import itHelpdesk from '../../use-cases/it-helpdesk/agents/it-helpdesk.ts';
import kpi from '../../use-cases/kpi/agents/kpi.ts';
import leadPriority from '../../use-cases/lead-priority/agents/lead-priority.ts';
import legalIntake from '../../use-cases/legal-intake/agents/legal-intake.ts';
import maintenance from '../../use-cases/maintenance/agents/maintenance.ts';
import manualSearchRebuild from '../../use-cases/manual-search/agents/manual-search.ts';
import logs from '../../use-cases/logs/agents/logs.ts';
import market from '../../use-cases/market/agents/market.ts';
import meetingPrep from '../../use-cases/meeting-prep/agents/meeting-prep.ts';
import multilingual from '../../use-cases/multilingual/agents/multilingual.ts';
import nda from '../../use-cases/nda/agents/nda.ts';
import newcomer from '../../use-cases/newcomer/agents/newcomer.ts';
import okr from '../../use-cases/okr/agents/okr.ts';
import offboarding from '../../use-cases/offboarding/agents/offboarding.ts';
import onboarding from '../../use-cases/onboarding/agents/onboarding.ts';
import patentSearch from '../../use-cases/patent-search/agents/patent-search.ts';
import qualityDefectRebuild from '../../use-cases/quality-defect/agents/quality-defect.ts';
import excelConsolidationRebuild from '../../use-cases/excel-consolidation/agents/excel-consolidation.ts';
import quotationRebuild from '../../use-cases/quotation/agents/quotation.ts';
import cadDraftingRebuild from '../../use-cases/cad-drafting/agents/cad-drafting.ts';
import meetingMinutesRebuild from '../../use-cases/meeting-minutes/agents/meeting-minutes.ts';
import contractReviewRebuild from '../../use-cases/contract-review/agents/contract-review.ts';
import policyQa from '../../use-cases/policy-qa/agents/policy-qa.ts';
import ringiReviewRebuild from '../../use-cases/ringi-review/agents/ringi-review.ts';
import pricing from '../../use-cases/pricing/agents/pricing.ts';
import priceGuard from '../../use-cases/price-guard/agents/price-guard.ts';
import privacy from '../../use-cases/privacy/agents/privacy.ts';
import projectStatus from '../../use-cases/project-status/agents/project-status.ts';
import proposal from '../../use-cases/proposal/agents/proposal.ts';
import refund from '../../use-cases/refund/agents/refund.ts';
import renewal from '../../use-cases/renewal/agents/renewal.ts';
import pulse from '../../use-cases/pulse/agents/pulse.ts';
import returns from '../../use-cases/returns/agents/returns.ts';
import reviewFeedback from '../../use-cases/review-feedback/agents/review-feedback.ts';
import scheduling from '../../use-cases/scheduling/agents/scheduling.ts';
import screeningHr from '../../use-cases/screening-hr/agents/screening-hr.ts';
import regWatch from '../../use-cases/reg-watch/agents/reg-watch.ts';
import releaseNotes from '../../use-cases/release-notes/agents/release-notes.ts';
import screening from '../../use-cases/screening/agents/screening.ts';
import secAlert from '../../use-cases/sec-alert/agents/sec-alert.ts';
import segments from '../../use-cases/segments/agents/segments.ts';
import slaWatch from '../../use-cases/sla-watch/agents/sla-watch.ts';
import spareParts from '../../use-cases/spare-parts/agents/spare-parts.ts';
import slides from '../../use-cases/slides/agents/slides.ts';
import sql from '../../use-cases/sql/agents/sql.ts';
import standup from '../../use-cases/standup/agents/standup.ts';
import terms from '../../use-cases/terms/agents/terms.ts';
import tax from '../../use-cases/tax/agents/tax.ts';
import territory from '../../use-cases/territory/agents/territory.ts';
import taskExtract from '../../use-cases/task-extract/agents/task-extract.ts';
import training from '../../use-cases/training/agents/training.ts';
import supplier from '../../use-cases/supplier/agents/supplier.ts';
import tests from '../../use-cases/tests/agents/tests.ts';
import summarizer from '../../use-cases/summarizer/agents/summarizer.ts';
import survey from '../../use-cases/survey/agents/survey.ts';
import translator from '../../use-cases/translator/agents/translator.ts';
import voc from '../../use-cases/voc/agents/voc.ts';
import trend from '../../use-cases/trend/agents/trend.ts';
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
  ['use-cases/assets/agents/assets.ts', assets],
  ['use-cases/attendance/agents/attendance.ts', attendance],
  ['use-cases/budget/agents/budget.ts', budget],
  ['use-cases/change-4m/agents/change-4m.ts', change4m],
  ['use-cases/cash/agents/cash.ts', cash],
  ['use-cases/case-file/agents/case-file.ts', caseFile],
  ['use-cases/churn/agents/churn.ts', churn],
  ['use-cases/close/agents/close.ts', close],
  ['use-cases/code-review/agents/code-review.ts', codeReview],
  ['use-cases/customer-inquiry/agents/customer-inquiry.ts', customerInquiryRebuild],
  ['use-cases/daily-report/agents/daily-report.ts', dailyReport],
  ['use-cases/dash-narrator/agents/dash-narrator.ts', dashNarrator],
  ['use-cases/deal-risk/agents/deal-risk.ts', dealRisk],
  ['use-cases/digest/agents/digest.ts', digest],
  ['use-cases/collections/agents/collections.ts', collections],
  ['use-cases/competitor/agents/competitor.ts', competitor],
  ['use-cases/decision-log/agents/decision-log.ts', decisionLog],
  ['use-cases/escalation/agents/escalation.ts', escalation],
  ['use-cases/expense/agents/expense.ts', expense],
  ['use-cases/facility/agents/facility.ts', facility],
  ['use-cases/incident/agents/incident.ts', incident],
  ['use-cases/invoice/agents/invoice.ts', invoice],
  ['use-cases/faq-bot/agents/faq-bot.ts', faqBot],
  ['use-cases/faq-builder/agents/faq-builder.ts', faqBuilder],
  ['use-cases/forecast/agents/forecast.ts', forecast],
  ['use-cases/glossary/agents/glossary.ts', glossary],
  ['use-cases/handover/agents/handover.ts', handover],
  ['use-cases/hr-qa/agents/hr-qa.ts', hrQa],
  ['use-cases/inspection/agents/inspection.ts', inspection],
  ['use-cases/interview/agents/interview.ts', interview],
  ['use-cases/kyt/agents/kyt.ts', kyt],
  ['use-cases/ir-qa/agents/ir-qa.ts', irQa],
  ['use-cases/it-helpdesk/agents/it-helpdesk.ts', itHelpdesk],
  ['use-cases/kpi/agents/kpi.ts', kpi],
  ['use-cases/lead-priority/agents/lead-priority.ts', leadPriority],
  ['use-cases/legal-intake/agents/legal-intake.ts', legalIntake],
  ['use-cases/maintenance/agents/maintenance.ts', maintenance],
  ['use-cases/manual-search/agents/manual-search.ts', manualSearchRebuild],
  ['use-cases/logs/agents/logs.ts', logs],
  ['use-cases/market/agents/market.ts', market],
  ['use-cases/meeting-prep/agents/meeting-prep.ts', meetingPrep],
  ['use-cases/multilingual/agents/multilingual.ts', multilingual],
  ['use-cases/nda/agents/nda.ts', nda],
  ['use-cases/newcomer/agents/newcomer.ts', newcomer],
  ['use-cases/okr/agents/okr.ts', okr],
  ['use-cases/offboarding/agents/offboarding.ts', offboarding],
  ['use-cases/onboarding/agents/onboarding.ts', onboarding],
  ['use-cases/patent-search/agents/patent-search.ts', patentSearch],
  ['use-cases/quality-defect/agents/quality-defect.ts', qualityDefectRebuild],
  ['use-cases/excel-consolidation/agents/excel-consolidation.ts', excelConsolidationRebuild],
  ['use-cases/quotation/agents/quotation.ts', quotationRebuild],
  ['use-cases/cad-drafting/agents/cad-drafting.ts', cadDraftingRebuild],
  ['use-cases/meeting-minutes/agents/meeting-minutes.ts', meetingMinutesRebuild],
  ['use-cases/contract-review/agents/contract-review.ts', contractReviewRebuild],
  ['use-cases/policy-qa/agents/policy-qa.ts', policyQa],
  ['use-cases/ringi-review/agents/ringi-review.ts', ringiReviewRebuild],
  ['use-cases/pricing/agents/pricing.ts', pricing],
  ['use-cases/price-guard/agents/price-guard.ts', priceGuard],
  ['use-cases/privacy/agents/privacy.ts', privacy],
  ['use-cases/project-status/agents/project-status.ts', projectStatus],
  ['use-cases/proposal/agents/proposal.ts', proposal],
  ['use-cases/refund/agents/refund.ts', refund],
  ['use-cases/renewal/agents/renewal.ts', renewal],
  ['use-cases/pulse/agents/pulse.ts', pulse],
  ['use-cases/returns/agents/returns.ts', returns],
  ['use-cases/review-feedback/agents/review-feedback.ts', reviewFeedback],
  ['use-cases/scheduling/agents/scheduling.ts', scheduling],
  ['use-cases/screening-hr/agents/screening-hr.ts', screeningHr],
  ['use-cases/reg-watch/agents/reg-watch.ts', regWatch],
  ['use-cases/release-notes/agents/release-notes.ts', releaseNotes],
  ['use-cases/screening/agents/screening.ts', screening],
  ['use-cases/sec-alert/agents/sec-alert.ts', secAlert],
  ['use-cases/segments/agents/segments.ts', segments],
  ['use-cases/sla-watch/agents/sla-watch.ts', slaWatch],
  ['use-cases/spare-parts/agents/spare-parts.ts', spareParts],
  ['use-cases/slides/agents/slides.ts', slides],
  ['use-cases/sql/agents/sql.ts', sql],
  ['use-cases/standup/agents/standup.ts', standup],
  ['use-cases/terms/agents/terms.ts', terms],
  ['use-cases/tax/agents/tax.ts', tax],
  ['use-cases/territory/agents/territory.ts', territory],
  ['use-cases/task-extract/agents/task-extract.ts', taskExtract],
  ['use-cases/training/agents/training.ts', training],
  ['use-cases/supplier/agents/supplier.ts', supplier],
  ['use-cases/tests/agents/tests.ts', tests],
  ['use-cases/summarizer/agents/summarizer.ts', summarizer],
  ['use-cases/survey/agents/survey.ts', survey],
  ['use-cases/translator/agents/translator.ts', translator],
  ['use-cases/voc/agents/voc.ts', voc],
  ['use-cases/trend/agents/trend.ts', trend],
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
