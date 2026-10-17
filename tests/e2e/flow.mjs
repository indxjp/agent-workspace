import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

/** @typedef {{asserted?: boolean, ok?: boolean, status?: number, code?: string, detail?: string}} Observation */
/** @typedef {{id: string, status: 'passed' | 'failed' | 'credential-bound', detail: string, loginPath?: 'oidc' | 'bootstrap-administrator'}} FlowResult */
/** @typedef {(context: {index: number, previous: FlowResult[]}) => Observation | Promise<Observation>} StepRunner */

export const EXPECTED_STEP_COUNT = 11;
export const GATEWAY_CREDENTIAL_BOUND_STEPS = new Set([
  'add model',
  'run',
  'tool executes',
  'stream result',
  'resume session',
]);

export class SpecFlowError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'SpecFlowError';
    this.code = code;
  }
}

/** @param {string} source */
export function parsePrimaryFlow(source) {
  const sectionStart = source.search(/^# 51\.\s/mu);
  if (sectionStart < 0) throw new SpecFlowError('SECTION_51_MISSING', 'spec §51 was not found');
  const afterStart = source.slice(sectionStart);
  const nextSection = afterStart.slice(1).search(/^# \d+\.\s/mu);
  const section = nextSection < 0 ? afterStart : afterStart.slice(0, nextSection + 1);
  const heading = /^### End-to-End\s*$/mu.exec(section);
  if (heading === null) {
    throw new SpecFlowError('END_TO_END_HEADING_MISSING', '§51 has no End-to-End heading');
  }
  const tail = section.slice(heading.index + heading[0].length);
  const nextHeading = /^#{1,3}\s/mu.exec(tail);
  const scope = nextHeading === null ? tail : tail.slice(0, nextHeading.index);
  const fence = /```text\s*\r?\n([\s\S]*?)```/u.exec(scope);
  if (fence === null) {
    throw new SpecFlowError(
      'END_TO_END_FENCE_MISSING',
      'no text fence follows the End-to-End heading before the next heading',
    );
  }
  const fencedSteps = fence[1];
  if (fencedSteps === undefined) {
    throw new SpecFlowError('END_TO_END_FENCE_MISSING', 'the End-to-End text fence is empty');
  }
  const steps = fencedSteps
    .split(/^\s*↓\s*$/mu)
    .map((step) => step.trim())
    .filter(Boolean);
  if (steps.length !== EXPECTED_STEP_COUNT) {
    throw new SpecFlowError(
      'END_TO_END_STEP_COUNT',
      `expected ${EXPECTED_STEP_COUNT} steps but parsed ${steps.length}`,
    );
  }
  return steps;
}

export async function readPrimaryFlow(specUrl = new URL('../../docs/spec.md', import.meta.url)) {
  return parsePrimaryFlow(await readFile(specUrl, 'utf8'));
}

/** @param {unknown} observation */
export function isGatewayUnauthenticated(observation) {
  if (observation === null || typeof observation !== 'object') return false;
  const candidate = /** @type {Observation} */ (observation);
  if (candidate.status !== 401) return false;
  const code = candidate.code;
  return code === 'token_missing' || code === 'token_invalid' || code === 'token_expired';
}

/** @param {string} step @param {Observation | undefined} observation */
export function classifyObservation(step, observation) {
  if (observation?.asserted !== true) return 'failed';
  if (observation.ok === true) return 'passed';
  if (GATEWAY_CREDENTIAL_BOUND_STEPS.has(step) && isGatewayUnauthenticated(observation)) {
    return 'credential-bound';
  }
  return 'failed';
}

/**
 * @param {{steps: string[], runners: Record<string, StepRunner>, loginPath: 'oidc' | 'bootstrap-administrator'}} input
 * @returns {Promise<FlowResult[]>}
 */
export async function runPrimaryFlow({ steps, runners, loginPath }) {
  if (loginPath !== 'oidc' && loginPath !== 'bootstrap-administrator') {
    throw new Error(`loginPath must be oidc or bootstrap-administrator; got ${String(loginPath)}`);
  }
  /** @type {FlowResult[]} */
  const results = [];
  for (const [index, step] of steps.entries()) {
    const runner = runners[step];
    /** @type {Observation} */
    let observation;
    try {
      observation =
        typeof runner === 'function'
          ? await runner({ index: index + 1, previous: results })
          : { asserted: false, ok: false, detail: 'step runner is missing' };
    } catch (error) {
      observation = {
        asserted: true,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    results.push({
      id: step,
      status: classifyObservation(step, observation),
      detail: typeof observation?.detail === 'string' ? observation.detail : '',
      ...(index === 0 ? { loginPath } : {}),
    });
  }
  return results;
}
