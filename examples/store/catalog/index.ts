/**
 * The Agent Store catalog: every entry file in this folder, in shelf order, checked as a whole
 * when this module loads. Pages read `CATALOG` and `COUNTS` and never type a number in.
 *
 * Each entry is `./<slug>.ts`, default-exporting `defineEntry({...})`, imported statically below
 * (a computed import would hide an entry from the build). `tests/store/catalog.test.ts` fails when
 * a file in this folder is not imported here.
 */
import crmSales from './crm-sales.ts';
import quotation from './quotation.ts';
import proposal from './proposal.ts';
import meetingPrep from './meeting-prep.ts';
import leadPriority from './lead-priority.ts';
import dealRisk from './deal-risk.ts';
import competitor from './competitor.ts';
import renewal from './renewal.ts';
import priceGuard from './price-guard.ts';
import territory from './territory.ts';
import customerInquiry from './customer-inquiry.ts';
import serviceDesk from './service-desk.ts';
import faqBot from './faq-bot.ts';
import returns from './returns.ts';
import slaWatch from './sla-watch.ts';
import voc from './voc.ts';
import escalation from './escalation.ts';
import multilingual from './multilingual.ts';
import refund from './refund.ts';
import survey from './survey.ts';
import manualSearch from './manual-search.ts';
import wiki from './wiki.ts';
import policyQa from './policy-qa.ts';
import newcomer from './newcomer.ts';
import translator from './translator.ts';
import glossary from './glossary.ts';
import summarizer from './summarizer.ts';
import slides from './slides.ts';
import digest from './digest.ts';
import faqBuilder from './faq-builder.ts';
import cadDrafting from './cad-drafting.ts';
import qualityDefect from './quality-defect.ts';
import maintenance from './maintenance.ts';
import workInstruction from './work-instruction.ts';
import inspection from './inspection.ts';
import supplier from './supplier.ts';
import spareParts from './spare-parts.ts';
import change4m from './change-4m.ts';
import kyt from './kyt.ts';
import dailyReport from './daily-report.ts';
import contractReview from './contract-review.ts';
import nda from './nda.ts';
import adCompliance from './ad-compliance.ts';
import privacy from './privacy.ts';
import screening from './screening.ts';
import regWatch from './reg-watch.ts';
import patentSearch from './patent-search.ts';
import terms from './terms.ts';
import caseFile from './case-file.ts';
import legalIntake from './legal-intake.ts';
import ringiReview from './ringi-review.ts';
import excelConsolidation from './excel-consolidation.ts';
import expense from './expense.ts';
import invoice from './invoice.ts';
import budget from './budget.ts';
import cash from './cash.ts';
import close from './close.ts';
import collections from './collections.ts';
import tax from './tax.ts';
import irQa from './ir-qa.ts';
import screeningHr from './screening-hr.ts';
import interview from './interview.ts';
import onboarding from './onboarding.ts';
import attendance from './attendance.ts';
import hrQa from './hr-qa.ts';
import training from './training.ts';
import reviewFeedback from './review-feedback.ts';
import facility from './facility.ts';
import pulse from './pulse.ts';
import offboarding from './offboarding.ts';
import incident from './incident.ts';
import codeReview from './code-review.ts';
import releaseNotes from './release-notes.ts';
import accountRequests from './account-requests.ts';
import assets from './assets.ts';
import logs from './logs.ts';
import secAlert from './sec-alert.ts';
import tests from './tests.ts';
import sql from './sql.ts';
import itHelpdesk from './it-helpdesk.ts';
import teamChat from './team-chat.ts';
import meetingMinutes from './meeting-minutes.ts';
import standup from './standup.ts';
import projectStatus from './project-status.ts';
import okr from './okr.ts';
import announce from './announce.ts';
import decisionLog from './decision-log.ts';
import handover from './handover.ts';
import taskExtract from './task-extract.ts';
import scheduling from './scheduling.ts';
import market from './market.ts';
import kpi from './kpi.ts';
import forecast from './forecast.ts';
import dashNarrator from './dash-narrator.ts';
import trend from './trend.ts';
import segments from './segments.ts';
import pricing from './pricing.ts';
import patentMap from './patent-map.ts';
import churn from './churn.ts';
import peers from './peers.ts';
import { assertCatalog, countCatalog, featuredEntry, type CatalogEntry } from './define.ts';

const ENTRIES: readonly CatalogEntry[] = [
  crmSales,
  quotation,
  proposal,
  meetingPrep,
  leadPriority,
  dealRisk,
  competitor,
  renewal,
  priceGuard,
  territory,
  customerInquiry,
  serviceDesk,
  faqBot,
  returns,
  slaWatch,
  voc,
  escalation,
  multilingual,
  refund,
  survey,
  manualSearch,
  wiki,
  policyQa,
  newcomer,
  translator,
  glossary,
  summarizer,
  slides,
  digest,
  faqBuilder,
  cadDrafting,
  qualityDefect,
  maintenance,
  workInstruction,
  inspection,
  supplier,
  spareParts,
  change4m,
  kyt,
  dailyReport,
  contractReview,
  nda,
  adCompliance,
  privacy,
  screening,
  regWatch,
  patentSearch,
  terms,
  caseFile,
  legalIntake,
  ringiReview,
  excelConsolidation,
  expense,
  invoice,
  budget,
  cash,
  close,
  collections,
  tax,
  irQa,
  screeningHr,
  interview,
  onboarding,
  attendance,
  hrQa,
  training,
  reviewFeedback,
  facility,
  pulse,
  offboarding,
  incident,
  codeReview,
  releaseNotes,
  accountRequests,
  assets,
  logs,
  secAlert,
  tests,
  sql,
  itHelpdesk,
  teamChat,
  meetingMinutes,
  standup,
  projectStatus,
  okr,
  announce,
  decisionLog,
  handover,
  taskExtract,
  scheduling,
  market,
  kpi,
  forecast,
  dashNarrator,
  trend,
  segments,
  pricing,
  patentMap,
  churn,
  peers,
];

export const CATALOG: readonly CatalogEntry[] = assertCatalog(ENTRIES);

export const COUNTS = countCatalog(CATALOG);

/** The entry the home page features beside the hero. */
export const FEATURED = featuredEntry(CATALOG, 'ringi-review');

export {
  AREAS,
  CUSTOMIZE_CONTROLS,
  entryView,
  PUBLIC_REPOSITORY_URL,
  type AreaId,
  type CatalogCounts,
  type CatalogEntry,
  type CustomizeControl,
  type EntryView,
  type LineCount,
  type LiveEntry,
  type SourceView,
  type Wave,
} from './define.ts';
