import type { Buffer } from 'node:buffer';

import type { FrameLocator, Page } from '@playwright/test';

import type { FakeRequestRecord } from '../generated-project/fake-anthropic.mjs';
import type { OrdersCall, ToolRequestRecord } from './fake-anthropic-tools.mjs';

export const JOURNEY_BUDGET_SECONDS: 600;
export const JOURNEY_LOOK_CHANGE_BUDGET_SECONDS: 60;
export const JOURNEY_TOOL_BUDGET_SECONDS: 900;
export type JourneyBudgetSeconds = 600 | 60 | 900;
export const SEALED_PATHS: readonly string[];
export const TOOL_OWNED_PATHS: readonly string[];
export const DEFAULT_SURFACE_COLOUR: '#2f5fd0';
export const JOURNEY_BRAND_COLOUR: string;
export const MIN_COMMAND_MS: number;

export class JourneyFailure extends Error {
  constructor(message: string);
}

export type DevLine =
  | { readonly kind: 'ready'; readonly url: string }
  | { readonly kind: 'signedIn' }
  | { readonly kind: 'widget'; readonly src: string }
  | { readonly kind: 'try'; readonly url: string }
  | { readonly kind: 'modelConnection' }
  | { readonly kind: 'synced' }
  | { readonly kind: 'adminSignIn'; readonly email: string; readonly password: string };

export function parseDevLine(line: string): DevLine | null;
export function devOrigin(parsed: DevLine | null): string | null;
export function colourOfSurfaceSource(text: string): string;
export function assertBrandColour(fileHex: string, answeredHex: string): void;
export function assertLauncherColour(expectedHex: string, computedCss: string): void;
export function assertReplyRecorded(
  requests: readonly FakeRequestRecord[],
  nonce: string,
  apiKey: string,
): void;

export type TreeSnapshot = Readonly<Record<string, string>>;
export function snapshotTree(dir: string, excluded?: readonly string[]): Record<string, string>;
export function diffTrees(
  before: TreeSnapshot,
  after: TreeSnapshot,
): { added: string[]; changed: string[]; removed: string[] };
export function assertUnchanged(
  label: string,
  before: TreeSnapshot,
  after: TreeSnapshot,
  allowedAdded?: readonly string[],
): void;
export function filesContaining(
  dir: string,
  secret: string,
  excluded?: readonly string[],
): string[];
export function assertSecretAbsent(places: Readonly<Record<string, string>>, secret: string): void;

export type JourneyStep = { readonly name: string; readonly seconds: number };
export type TimingsReport = {
  budgetSeconds: JourneyBudgetSeconds;
  totalSeconds: number;
  stepsSeconds: number;
  withinBudget: boolean;
  steps: { name: string; seconds: number }[];
};
export function timingsReport(
  input: {
    readonly steps: readonly JourneyStep[];
    readonly wallSeconds: number;
  },
  budgetSeconds?: JourneyBudgetSeconds,
): TimingsReport;
export function totalLine(report: TimingsReport, label?: string): string;
export function stepSummaryMarkdown(report: TimingsReport, title?: string): string;
export function assertWithinBudget(report: TimingsReport, seconds?: JourneyBudgetSeconds): void;
export type UnfinishedTimingsReport = {
  budgetSeconds: JourneyBudgetSeconds;
  finished: false;
  elapsedSeconds: number;
  failedStep: { name: string; seconds: number };
  steps: { name: string; seconds: number }[];
};
export function unfinishedTimingsReport(
  input: {
    readonly steps: readonly JourneyStep[];
    readonly failed: JourneyStep;
    readonly elapsedSeconds: number;
  },
  budgetSeconds?: JourneyBudgetSeconds,
): UnfinishedTimingsReport;
export function unfinishedJourneyRecord(
  report: UnfinishedTimingsReport,
  model: 'fake' | 'live',
): UnfinishedTimingsReport & { model: 'fake' | 'live' };
export function unfinishedSummaryMarkdown(report: UnfinishedTimingsReport, title?: string): string;
export function remainingMs(deadline: number, now: number, variable: string): number;
export function workDirectoryOf(value: string | undefined): string | null;
export function registryOf(value: string | undefined): string | null;
export function stringMapOf(json: string, what: string): Record<string, string>;
export function createAnswerFor(
  screen: string,
  answers: Readonly<Record<string, string>>,
): string | null;

export function redact(text: string, secret: string): string;
export function agentNameOfSource(source: string): string;
export function mcpAgentSource(source: string, connector: string): string;
export function toolAgentSource(source: string): string;
export function withSurfaceColour(source: string, hex: string): string;
export function assertToolCallSeen(
  calls: readonly OrdersCall[],
  nonce: string,
  token: string,
): void;
export function assertToolAnswer(requests: readonly FakeRequestRecord[], nonce: string): void;
export function assertToolOffered(
  toolRequests: readonly Pick<ToolRequestRecord, 'nonce' | 'toolNames'>[],
  nonce: string,
  toolName: string,
  offered: boolean,
): void;
export function assertServerRefusal(output: string, file: string): void;
export function agentIdOf(json: string, name: string): string;
export function tryPath(): string;
export function journeyMode(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { readonly live: false } | { readonly live: true; readonly apiKey: string };
export function splitFirstHour(argv: readonly string[]): {
  readonly firstHour: boolean;
  readonly rest: string[];
};
export function firstTokenOf(output: string): number;
export function runOf(body: unknown, what: string): { id: string; status: string };
export function sessionTokenOf(body: unknown): string;
export function askWidget(
  page: Page,
  chat: FrameLocator,
  prompt: string,
  timeoutMs: number,
): Promise<number>;
export interface ChatAlert {
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>;
}
export function assertNoChatFailure(chat: {
  locator(selector: string): { all(): Promise<readonly ChatAlert[]> };
}): Promise<void>;
export function stubExpectation(live: boolean, text: string): Record<string, string>;
export function scrubbedEvidence(bytes: Buffer, secrets: Iterable<string>): Buffer | null;
export function quickstartCommands(mdx: string): string[];
export type FirstHourStep = {
  readonly id: string;
  readonly name: string;
  readonly seconds?: number;
  readonly targetSeconds?: number;
  readonly pending?: string;
};
export function firstHourSummaryMarkdown(steps: readonly FirstHourStep[]): string;
