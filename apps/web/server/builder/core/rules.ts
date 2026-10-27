import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import {
  AW_CONTROL_SERVER,
  BUILDER_REFUSAL_CODES,
  BUILDER_TOOLS,
  type BuilderApprovalQuestion,
  type BuilderDecision,
  type BuilderRefusalCode,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';

import { isDraftCall, type ToolCall } from './call';
import type { Facts } from './facts';
import { widenings } from './never-wider';

/** A rule answers with a decision, or `null` to let the next rule look. */
type Rule = (call: ToolCall, facts: Facts) => BuilderDecision | null;

function refuse(
  code: BuilderRefusalCode,
  message: string = BUILDER_REFUSAL_CODES[code].fix,
): BuilderDecision {
  return { kind: 'refuse', code, message };
}

const featureOff: Rule = (_call, facts) => (facts.enabled ? null : refuse('builder_disabled'));

const noCallerForWrites: Rule = (call, facts) => {
  if (facts.caller.kind === 'person') return null;
  const kind = BUILDER_TOOLS[call.tool].kind;
  switch (kind) {
    case 'read':
      return null;
    case 'write':
    case 'spend':
      return refuse('no_caller');
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
};

/** An outside client reads and nothing else: every write or spend is refused, whatever the person's role. */
const externalReadsOnly: Rule = (call, facts) => {
  if (facts.creator.kind !== 'external') return null;
  const kind = BUILDER_TOOLS[call.tool].kind;
  switch (kind) {
    case 'read':
      return null;
    case 'write':
    case 'spend':
      return refuse('read_only_client');
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
};

const access: Rule = (_call, facts) => {
  switch (facts.access) {
    case 'allowed':
      return null;
    case 'not_permitted':
      return refuse('not_permitted');
    case 'not_owner':
      return refuse('not_owner');
    default: {
      const unhandled: never = facts.access;
      return unhandled;
    }
  }
};

const toolCallLimit: Rule = (_call, facts) =>
  facts.run.toolCalls >= facts.limits.maxToolCallsPerRun ? refuse('tool_call_limit_reached') : null;

const checkLimit: Rule = (call, facts) =>
  isDraftCall(call) && facts.run.failedChecksInARow >= facts.limits.maxFailedChecksInARow
    ? refuse('check_limit_reached', 'Stop and show the last error to the person.')
    : null;

/** A draft is untrusted output (design §08 Agent basics rule 3): it may not hand itself the Builder's own tools. */
const noControlInDrafts: Rule = (call) =>
  isDraftCall(call) && call.input.body.definition.resources.connectors.includes(AW_CONTROL_SERVER)
    ? refuse('not_allowed_to_build')
    : null;

/** An agent that was not given the right to build agents builds nothing, not even a read. */
const notAllowedToBuild: Rule = (_call, facts) => {
  switch (facts.creator.kind) {
    case 'builder':
    case 'external':
      return null;
    case 'agent':
      return facts.creator.allowedToBuild ? null : refuse('not_allowed_to_build');
    default: {
      const unhandled: never = facts.creator;
      return unhandled;
    }
  }
};

/** An agent made by an agent may look, but not change or spend: builders do not build builders. */
const depthLimit: Rule = (call, facts) => {
  if (facts.creator.kind !== 'agent' || !facts.creator.madeByAgent) return null;
  const kind = BUILDER_TOOLS[call.tool].kind;
  switch (kind) {
    case 'read':
      return null;
    case 'write':
    case 'spend':
      return refuse('depth_limit');
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
};

/** Most paths a `creator_cannot_widen` refusal lists. */
const CREATOR_WIDENINGS_DETAILS_MAX = 50;

/** A refusal naming where `child` would be wider than `creator`, paths only; `null` when it is not. */
function wideningRefusal(child: AgentVersionBody, creator: AgentVersionBody) {
  const paths = widenings(child, creator).map((w) => w.path);
  return paths.length === 0
    ? null
    : {
        ...refuse('creator_cannot_widen'),
        details: paths.slice(0, CREATOR_WIDENINGS_DETAILS_MAX),
      };
}

/** A draft built by an agent may not give the new agent more than that agent has. Paths only. */
const creatorCannotWiden: Rule = (call, facts) =>
  isDraftCall(call) && facts.creator.kind === 'agent'
    ? wideningRefusal(call.input.body, facts.creator.body)
    : null;

/**
 * An agent may run or evaluate only an agent no wider than itself, even one it made: a person may
 * have widened that child since, and running a wider agent would lend it power the creator lacks.
 * A target that could not be resolved is refused, so a missing answer never skips the rule.
 */
const creatorTargetCannotWiden: Rule = (call, facts) => {
  if (facts.creator.kind !== 'agent') return null;
  if (call.tool !== 'trial_run' && call.tool !== 'evals_run') return null;
  if (facts.target === null) return refuse('creator_cannot_widen');
  return wideningRefusal(facts.target.body, facts.creator.body);
};

/** Only a save of a new agent counts against the workspace's daily creation quota. */
const quota: Rule = (call, facts) =>
  call.tool === 'draft_save' &&
  call.input.agentId === undefined &&
  facts.creationsToday >= facts.limits.creationsPerWorkspacePerDay
    ? refuse('quota_exceeded')
    : null;

/**
 * What a tool asks the person before it runs, or `null` for a tool that never asks. The shell
 * claims and spends an approval for exactly the tools this names, so asking and spending cannot drift.
 */
export function approvalQuestion(tool: BuilderToolName): BuilderApprovalQuestion | null {
  switch (tool) {
    case 'draft_save':
      return 'approve_save';
    case 'evals_run':
      return 'approve_evals';
    case 'trial_run':
      return 'approve_trial';
    case 'catalog_list':
    case 'examples_get':
    case 'draft_check':
      return null;
    default: {
      const unhandled: never = tool;
      return unhandled;
    }
  }
}

/** A save, an evaluation or a trial happens only after the person approved that exact call. */
const approval: Rule = (call, facts) => {
  if (facts.approval === 'granted') return null;
  const question = approvalQuestion(call.tool);
  return question === null ? null : { kind: 'ask', question };
};

/** The `details` line of a `pointer_moved` refusal: where `local` is now. */
export const pointerMovedDetails = (current: number | null): readonly string[] => [
  `current:${current ?? 'none'}`,
];

/** A draft built on an old `local` is refused, so a person's later change is never overwritten. */
const pointerMoved: Rule = (call, facts) =>
  call.tool === 'draft_save' &&
  call.input.agentId !== undefined &&
  facts.local.version !== call.input.baseVersion
    ? {
        ...refuse('pointer_moved'),
        details: pointerMovedDetails(facts.local.version),
      }
    : null;

/** The rules. The order is part of the contract: the first rule to answer wins. */
export const RULES: readonly Rule[] = [
  featureOff,
  // First after the feature switch, so an agent that may not build learns nothing from any other rule.
  notAllowedToBuild,
  noCallerForWrites,
  externalReadsOnly,
  access,
  toolCallLimit,
  checkLimit,
  noControlInDrafts,
  // Refusals the person can do nothing about come before the question, so they are never asked to
  // approve a call that is then refused.
  depthLimit,
  creatorCannotWiden,
  creatorTargetCannotWiden,
  quota,
  approval,
  pointerMoved,
];
