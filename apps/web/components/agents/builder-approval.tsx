import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';

import {
  BUILDER_DEFAULT_LIMITS,
  BuilderToolInputSchemas,
  type BuilderToolInputs,
} from '@indx-workspace/contracts/builder';
import type { AgentEvent } from '@indx-workspace/sdk/events';
import { diffBodies, uncoveredKeys, type DefinitionChange } from '@indx-workspace/sdk/portable';

import { browserClient } from '../../lib/browser-client';
import { BTN, BTN_DEFAULT, CARD } from './agent-form';
import { builderToolName } from './definition-from-run';

/** The tool calls the Builder pauses on (design §04); every card is built from the call's input. */
type ApprovalCall =
  | { readonly tool: 'draft_save'; readonly input: BuilderToolInputs['draft_save'] }
  | { readonly tool: 'trial_run'; readonly input: BuilderToolInputs['trial_run'] }
  | { readonly tool: 'evals_run'; readonly input: BuilderToolInputs['evals_run'] };

function readCall(toolName: string, canonicalCall: string): ApprovalCall | null {
  const tool = builderToolName(toolName);
  if (tool !== 'draft_save' && tool !== 'trial_run' && tool !== 'evals_run') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalCall);
  } catch {
    return null;
  }
  const wrapper = z.object({ input: z.unknown() }).safeParse(parsed);
  if (!wrapper.success) return null;
  const { input } = wrapper.data;
  switch (tool) {
    case 'draft_save': {
      const read = BuilderToolInputSchemas.draft_save.safeParse(input);
      return read.success ? { tool, input: read.data } : null;
    }
    case 'trial_run': {
      const read = BuilderToolInputSchemas.trial_run.safeParse(input);
      return read.success ? { tool, input: read.data } : null;
    }
    case 'evals_run': {
      const read = BuilderToolInputSchemas.evals_run.safeParse(input);
      return read.success ? { tool, input: read.data } : null;
    }
  }
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'save';
      readonly title: string;
      readonly changes: readonly DefinitionChange[];
      readonly warnings: readonly string[];
      readonly also: readonly string[];
      readonly summary: string | undefined;
    }
  | {
      readonly kind: 'trial';
      readonly name: string;
      readonly version: number;
      readonly input: string;
    }
  | {
      readonly kind: 'evals';
      readonly name: string;
      readonly version: number;
      readonly cases: readonly string[];
    };

/** Bidirectional and zero-width controls, which could reorder or hide the text around them. */
const HIDDEN = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const plain = (text: string): string => text.replace(HIDDEN, '');

const UNREADABLE: View = { kind: 'unreadable' };
const CAP = `$${BUILDER_DEFAULT_LIMITS.trialBudgetUsd.toFixed(2)}`;
const TRIAL_CAP = `This runs the draft once with at most a ${CAP} budget. Its tools may change real systems.`;
const EVALS_CAP = `Each check runs the draft with at most a ${CAP} budget. Its tools may change real systems.`;

async function viewOf(call: ApprovalCall | null): Promise<View> {
  if (call === null) return UNREADABLE;
  // The versions list is what the history screen reads; there is no get-by-number route.
  const versionOf = async (agentId: string, number: number | undefined) => {
    const { items } = await browserClient().agents.versions.list(agentId);
    return items.find((item) => item.number === number)?.body;
  };
  try {
    if (call.tool === 'draft_save') {
      const { agentId, baseVersion, body, summary } = call.input;
      const base = agentId === undefined ? null : ((await versionOf(agentId, baseVersion)) ?? null);
      if (agentId !== undefined && base === null) return UNREADABLE;
      const changes = diffBodies(base, body);
      const fromPreset = changes.some(
        ({ path, before }) => path === `${TOOLS}.base` && before === 'claude_code_preset',
      );
      const name = JSON.stringify(plain(body.definition.agent.name));
      return {
        kind: 'save',
        title:
          base === null
            ? `Save a new agent named ${name}`
            : `Save changes to ${name} on top of version ${String(baseVersion)}`,
        changes,
        warnings: [...new Set(changes.flatMap((change) => lowersGuard(change, fromPreset) ?? []))],
        also: uncoveredKeys(base, body).map(plain),
        summary: summary === undefined ? undefined : plain(summary),
      };
    }
    const { agentId, version } = call.input;
    const name = (await versionOf(agentId, version))?.definition.agent.name;
    if (name === undefined) return UNREADABLE;
    return call.tool === 'trial_run'
      ? { kind: 'trial', name, version, input: plain(call.input.input) }
      : { kind: 'evals', name, version, cases: call.input.cases.map((item) => plain(item.name)) };
  } catch {
    // Fail closed: a card that cannot be built offers Reject only.
    return UNREADABLE;
  }
}

const show = (value: unknown): string => plain(JSON.stringify(value) ?? '(removed)');

const TOOLS = 'definition.policy.tools';
const SKIPS = 'This change lets the agent skip permission checks.';

/** What a change lets the agent do that it could not, in words; only the exact policy paths count. */
function lowersGuard({ path, after }: DefinitionChange, fromPreset: boolean): string | null {
  if (path === `${TOOLS}.allowDangerouslySkipPermissions`) return after === true ? SKIPS : null;
  if (path === `${TOOLS}.permissionMode`) return after === 'bypassPermissions' ? SKIPS : null;
  if (path === `${TOOLS}.base` && after === 'claude_code_preset') {
    return 'This change gives the agent the whole Claude Code tool set.';
  }
  if (path.startsWith(`${TOOLS}.base[`) && after === true && !fromPreset) {
    return 'This change adds a tool to the explicit tool set.';
  }
  if (path.startsWith(`${TOOLS}.deny[`) && after === undefined) {
    return 'This change removes a hard deny on a tool.';
  }
  if (path.startsWith(`${TOOLS}.autoApprove[`) && after === true) {
    return 'This change lets the agent use a tool without asking.';
  }
  return null;
}

function Detail({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{children}</dd>
    </>
  );
}

function Body({ view }: Readonly<{ view: View }>) {
  switch (view.kind) {
    case 'loading':
      return <p className="text-muted">Loading what the Builder asked for…</p>;
    case 'unreadable':
      return <p role="alert">The Builder asked for something this screen cannot show.</p>;
    case 'save':
      return (
        <>
          <p className="font-semibold">{view.title}</p>
          {view.warnings.map((warning) => (
            <p key={warning} role="alert" className="mt-2 font-semibold">
              {warning}
            </p>
          ))}
          {view.changes.length === 0 ? (
            <p className="mt-2 text-muted">No changes in the listed sections.</p>
          ) : (
            <table className="mt-2 w-full text-left">
              <tbody>
                {view.changes.map((change, index) => (
                  <tr key={`${change.path}:${String(index)}`} className="align-top">
                    <td className="pr-3">{change.section}</td>
                    <td className="pr-3 [overflow-wrap:anywhere]">
                      <code>{plain(change.path)}</code>
                    </td>
                    <td className="[overflow-wrap:anywhere]">
                      {'before' in change ? show(change.before) : '(none)'} → {show(change.after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view.also.length === 0 ? null : (
            <p className="mt-2">Also changes (not shown here): {view.also.join(', ')}</p>
          )}
          {view.summary === undefined ? null : (
            <p className="mt-2">Summary: {show(view.summary)}</p>
          )}
        </>
      );
    case 'trial':
      return (
        <>
          <dl className="m-0 grid grid-cols-[90px_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Detail label="Agent">{view.name}</Detail>
            <Detail label="Version">{String(view.version)}</Detail>
            <Detail label="Input">{view.input}</Detail>
          </dl>
          <p className="mt-2">{TRIAL_CAP}</p>
        </>
      );
    case 'evals':
      return (
        <>
          <dl className="m-0 grid grid-cols-[90px_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Detail label="Agent">{view.name}</Detail>
            <Detail label="Version">{String(view.version)}</Detail>
            <Detail label="Checks">{String(view.cases.length)}</Detail>
          </dl>
          <ul className="mt-1 list-disc pl-5">
            {view.cases.map((name, index) => (
              <li key={`${String(index)}:${name}`}>{name}</li>
            ))}
          </ul>
          <p className="mt-2">{EVALS_CAP}</p>
        </>
      );
  }
}

/**
 * What the person is asked to allow when the Builder pauses on `draft_save`, `trial_run` or
 * `evals_run`. It is built from the tool input (design §08 Agent basics rule 10); every
 * model-written string is a text child, never HTML or markdown. `onDecide` answers the problem code
 * when the server refuses the decision, or `null`.
 */
export function BuilderApproval({
  events,
  onDecide,
}: Readonly<{
  events: readonly AgentEvent[];
  onDecide: (decision: 'approve' | 'reject') => Promise<string | null>;
}>) {
  // The call the run is paused on: the latest `agent.approval.requested`, read from its tool input
  // and never from assistant text. Keyed on that event so later events do not rebuild the card.
  const asked = useMemo(
    () => events.findLast((event) => event.frame === 'agent.approval.requested'),
    [events],
  );
  const call = useMemo(
    () => (asked === undefined ? null : readCall(asked.toolName, asked.canonicalCall)),
    [asked],
  );
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setView({ kind: 'loading' });
    void viewOf(call).then((next) => {
      if (active) setView(next);
    });
    return () => {
      active = false;
    };
  }, [call]);

  if (asked === undefined) return null;

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setProblem(await onDecide(decision));
    setBusy(false);
  }
  const ready = view.kind !== 'loading' && view.kind !== 'unreadable';
  return (
    <section
      aria-label="The Builder is waiting for your decision"
      className={`${CARD} mt-6 p-4 text-[13px]`}
    >
      <Body view={view} />
      {problem === null ? null : (
        <p role="alert" className="mt-2">
          The decision was not accepted: <code>{problem}</code>
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {ready ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide('approve')}
            className={`${BTN} border-accent bg-accent text-white disabled:opacity-[.45] dark:text-[#10131c]`}
          >
            Approve
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('reject')}
          className={`${BTN} ${BTN_DEFAULT} disabled:opacity-[.45]`}
        >
          Reject
        </button>
      </div>
    </section>
  );
}
