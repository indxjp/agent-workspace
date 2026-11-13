import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';

import {
  BUILDER_DEFAULT_LIMITS,
  BuilderToolInputSchemas,
  type BuilderToolInputs,
} from '@indx-workspace/contracts/builder';
import type { AgentEvent } from '@indx-workspace/sdk/events';
import {
  diffBodies,
  revealInvisible,
  uncoveredKeys,
  type DefinitionChange,
} from '@indx-workspace/sdk/portable';

import { browserClient } from '../../lib/browser-client';
import { BTN, BTN_DEFAULT, CARD } from './agent-form';
import { changeInWords } from './builder-approval-words';
import { builderStrings, type BuilderStrings } from './builder-messages';
import { builderToolName } from './definition-from-run';
import type { VersionsLocale } from './versions-messages';

/** The code a decision that never reached the server carries; its sentence is this screen's own. */
export const NOT_SENT_CODE = 'request_failed';

/** Why a decision was not accepted: the server's sentence, and its code for a support request. */
export interface DecisionProblem {
  readonly message: string;
  readonly code: string;
}

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
      readonly cases: readonly {
        readonly name: string;
        readonly input: string;
        readonly expect: string;
      }[];
    };

/**
 * Model-written text with every character that draws nothing or reorders the text around it shown
 * as its code point, so it is seen and two strings that differ only by one never look equal.
 */
const plain = revealInvisible;

const UNREADABLE: View = { kind: 'unreadable' };
const CAP = `$${BUILDER_DEFAULT_LIMITS.trialBudgetUsd.toFixed(2)}`;

async function viewOf(call: ApprovalCall | null, strings: BuilderStrings): Promise<View> {
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
          base === null ? strings.saveNew(name) : strings.saveChanges(name, String(baseVersion)),
        changes,
        warnings: [
          ...new Set(changes.flatMap((change) => lowersGuard(change, fromPreset, strings) ?? [])),
        ],
        also: uncoveredKeys(base, body).map(plain),
        summary: summary === undefined ? undefined : plain(summary),
      };
    }
    const { agentId, version } = call.input;
    const name = (await versionOf(agentId, version))?.definition.agent.name;
    if (name === undefined) return UNREADABLE;
    if (call.tool === 'trial_run') {
      return { kind: 'trial', name: plain(name), version, input: plain(call.input.input) };
    }
    const cases = call.input.cases.map((item) => ({
      name: plain(item.name),
      input: plain(item.input),
      expect: plain(JSON.stringify(item.expect)),
    }));
    return { kind: 'evals', name: plain(name), version, cases };
  } catch {
    // Fail closed: a card that cannot be built offers Reject only.
    return UNREADABLE;
  }
}

const show = (value: unknown, removed: string): string => plain(JSON.stringify(value) ?? removed);

const TOOLS = 'definition.policy.tools';

/** What a change lets the agent do that it could not, in words; only the exact policy paths count. */
function lowersGuard(
  { path, after }: DefinitionChange,
  fromPreset: boolean,
  strings: BuilderStrings,
): string | null {
  if (path === `${TOOLS}.allowDangerouslySkipPermissions`) {
    return after === true ? strings.warnSkips : null;
  }
  if (path === `${TOOLS}.permissionMode`) {
    return after === 'bypassPermissions' ? strings.warnSkips : null;
  }
  if (path === `${TOOLS}.base` && after === 'claude_code_preset') return strings.warnPreset;
  if (path.startsWith(`${TOOLS}.base[`) && after === true && !fromPreset) {
    return strings.warnAddsTool;
  }
  if (path.startsWith(`${TOOLS}.deny[`) && after === undefined) return strings.warnRemovesDeny;
  if (path.startsWith(`${TOOLS}.autoApprove[`) && after === true) return strings.warnWithoutAsking;
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

/** The changes exactly as the tool input has them: the path, the value before and after. */
function ExactChanges({
  changes,
  strings,
}: Readonly<{ changes: readonly DefinitionChange[]; strings: BuilderStrings }>) {
  return (
    <table className="mt-2 w-full text-left text-[12px]">
      <tbody>
        {changes.map((change, index) => (
          <tr key={`${change.path}:${String(index)}`} className="align-top">
            <td className="pr-3 [overflow-wrap:anywhere]">
              <code>{plain(change.path)}</code>
            </td>
            <td className="[overflow-wrap:anywhere]">
              {'before' in change ? show(change.before, strings.exactRemoved) : strings.exactNone} →{' '}
              {show(change.after, strings.exactRemoved)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Body({
  view,
  strings,
  locale,
}: Readonly<{ view: View; strings: BuilderStrings; locale: VersionsLocale }>) {
  switch (view.kind) {
    case 'loading':
      return <p className="text-muted">{strings.cardLoading}</p>;
    case 'unreadable':
      return <p role="alert">{strings.cardUnreadable}</p>;
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
            <p className="mt-2 text-muted">{strings.noChanges}</p>
          ) : (
            <>
              <dl className="mt-2 grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-x-3 gap-y-1">
                {view.changes.map((change, index) => {
                  const { label, value } = changeInWords(change, locale);
                  return (
                    <Fragment key={`${change.path}:${String(index)}`}>
                      <dt className="text-muted [overflow-wrap:anywhere]">{label}</dt>
                      <dd className="m-0 min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
                        {value}
                      </dd>
                    </Fragment>
                  );
                })}
              </dl>
              <details className="mt-2">
                <summary className="cursor-pointer text-muted">{strings.showExact}</summary>
                <ExactChanges changes={view.changes} strings={strings} />
              </details>
            </>
          )}
          {view.also.length === 0 ? null : (
            <p className="mt-2">{strings.alsoChanges(view.also.join(', '))}</p>
          )}
          {view.summary === undefined ? null : (
            <p className="mt-2">{strings.summary(show(view.summary, strings.exactRemoved))}</p>
          )}
        </>
      );
    case 'trial':
      return (
        <>
          <dl className="m-0 grid grid-cols-[90px_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Detail label={strings.agent}>{view.name}</Detail>
            <Detail label={strings.version}>{String(view.version)}</Detail>
            <Detail label={strings.input}>{view.input}</Detail>
          </dl>
          <p className="mt-2">{strings.trialCap(CAP)}</p>
        </>
      );
    case 'evals':
      return (
        <>
          <dl className="m-0 grid grid-cols-[90px_minmax(0,1fr)] gap-x-3 gap-y-1">
            <Detail label={strings.agent}>{view.name}</Detail>
            <Detail label={strings.version}>{String(view.version)}</Detail>
            <Detail label={strings.checks}>{String(view.cases.length)}</Detail>
          </dl>
          <ul className="mt-1 list-disc pl-5">
            {view.cases.map(({ name, input, expect }, index) => (
              <li key={`${String(index)}:${name}`} className="[overflow-wrap:anywhere]">
                {name}
                <br />
                <span className="text-muted">{strings.inputColon}</span>
                <span className="whitespace-pre-wrap">{input}</span>
                <br />
                <span className="text-muted">{strings.expectColon}</span>
                {expect}
              </li>
            ))}
          </ul>
          <p className="mt-2">{strings.evalsCap(CAP)}</p>
        </>
      );
  }
}

/**
 * What the person is asked to allow when the Builder pauses on `draft_save`, `trial_run` or
 * `evals_run`. It is built from the tool input (design §08 Agent basics rule 10); every
 * model-written string is a text child, never HTML or markdown. `onDecide` answers why the server
 * refused the decision, or `null`.
 */
export function BuilderApproval({
  events,
  onDecide,
  locale = 'en',
}: Readonly<{
  events: readonly AgentEvent[];
  onDecide: (decision: 'approve' | 'reject') => Promise<DecisionProblem | null>;
  /** The reader's language (UX-15 in #2086); English when absent. */
  locale?: VersionsLocale;
}>) {
  const strings = builderStrings(locale);
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
  const [problem, setProblem] = useState<DecisionProblem | null>(null);

  useEffect(() => {
    let active = true;
    setView({ kind: 'loading' });
    void viewOf(call, strings).then((next) => {
      if (active) setView(next);
    });
    return () => {
      active = false;
    };
  }, [call, strings]);

  if (asked === undefined) return null;

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setProblem(await onDecide(decision));
    setBusy(false);
  }
  const ready = view.kind !== 'loading' && view.kind !== 'unreadable';
  return (
    <section
      aria-label={strings.cardLabel}
      lang={locale}
      className={`${CARD} mt-6 p-4 text-[13px]`}
    >
      <Body view={view} strings={strings} locale={locale} />
      {problem === null ? null : (
        <p role="alert" className="mt-2">
          {strings.notAccepted}{' '}
          {/* The server's own sentence stays in its language; ours is already the reader's. */}
          <span {...(problem.code === NOT_SENT_CODE ? {} : { lang: 'en' })}>
            {problem.message}
          </span>{' '}
          <span className="text-muted">
            {strings.code} <code>{problem.code}</code>
          </span>
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
            {strings.approve}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('reject')}
          className={`${BTN} ${BTN_DEFAULT} disabled:opacity-[.45]`}
        >
          {strings.reject}
        </button>
      </div>
    </section>
  );
}
