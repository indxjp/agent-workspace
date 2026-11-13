#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runHarnessCli } from './harness-cli.mjs';
export {
  workDirectoryOf,
  registryOf,
  stringMapOf,
  journeyMode,
  splitFirstHour,
  stubExpectation,
  quickstartCommands,
} from './harness-config.mjs';
export {
  JOURNEY_FEATURE_IDS,
  CONSOLE_FEATURE_ENTRIES,
  consoleEntriesFor,
} from './harness-features.mjs';

export {
  assertReplyRecorded,
  assertToolCallSeen,
  assertToolAnswer,
  assertToolOffered,
  assertServerRefusal,
  agentIdOf,
} from './harness-provider.mjs';

export {
  DEFAULT_SURFACE_COLOUR,
  JOURNEY_BRAND_COLOUR,
  colourOfSurfaceSource,
  assertBrandColour,
  assertLauncherColour,
  agentNameOfSource,
  mcpAgentSource,
  toolAgentSource,
  withSurfaceColour,
} from './harness-source.mjs';

export { JourneyFailure } from './harness-failure.mjs';

export {
  JOURNEY_BUDGET_SECONDS,
  JOURNEY_LOOK_CHANGE_BUDGET_SECONDS,
  JOURNEY_TOOL_BUDGET_SECONDS,
  JOURNEY_PORTAL_BUDGET_SECONDS,
  MIN_COMMAND_MS,
  timingsReport,
  totalLine,
  stepSummaryMarkdown,
  unfinishedTimingsReport,
  unfinishedJourneyRecord,
  unfinishedSummaryMarkdown,
  assertWithinBudget,
  remainingMs,
  firstTokenOf,
  firstHourSummaryMarkdown,
} from './harness-timings.mjs';

export {
  TOOL_OWNED_PATHS,
  snapshotTree,
  SEALED_PATHS,
  filesContaining,
  assertSecretAbsent,
  diffTrees,
  assertUnchanged,
  redact,
  scrubbedEvidence,
} from './harness-files.mjs';

export { parseDevLine, devOrigin, createAnswerFor } from './harness-terminal.mjs';

export {
  tryPath,
  openWidgetHost,
  runOf,
  sessionTokenOf,
  askWidget,
  assertNoChatFailure,
} from './harness-widget.mjs';

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runHarnessCli();
}
