'use client';

/**
 * The agent screen's Versions tab (issue #617, 80-10): the versions with their `local` and
 * `production` badges, a diff of any two, and Promote and Roll back, each showing the dry-run plan
 * `aw promote` prints before it acts. It is a view over the pointers, versions and history the
 * server already keeps; every call goes through the SDK client, never `fetch`.
 */
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import type {
  AgentVersionEvaluation,
  AgentVersionListResponse,
  AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import { useEffect, useState, type ReactNode } from 'react';

import {
  badgesFor,
  barText,
  connectorKeyNames,
  casesText,
  evaluationOf,
  failedCheck,
  fieldChanges,
  lineDiff,
  planText,
  promoteRequest,
  promoteTarget,
  readyCheck,
  rollbackRefusal,
  scoreText,
  type ConnectorNames,
  type MoveCheck,
} from './versions-model';
import { BUTTON, SECONDARY_BUTTON, TD, TH } from './table-styles';
import {
  refusalText,
  versionsStrings,
  type VersionsLocale,
  type VersionsStrings,
} from './versions-messages';

const sessionClient = (): AgentWorkspaceClient =>
  createClient({ baseUrl: window.location.origin, auth: { kind: 'session' } });

/** What a refused or failed move or dry run says, in the reader's language. */
function checkText(check: Exclude<MoveCheck, { kind: 'ready' }>, strings: VersionsStrings): string {
  switch (check.kind) {
    case 'not_evaluated':
      return strings.notEvaluated(check.version, barText(check.bar));
    case 'gate_failed':
      return strings.gateFailed(
        check.version,
        scoreText(check.score),
        barText(check.bar),
        casesText(check.cases),
      );
    case 'refused':
      return refusalText(check.code, strings);
  }
}

function scoreCellText(
  version: number,
  evaluations: readonly AgentVersionEvaluation[],
  strings: VersionsStrings,
): string {
  const evaluation = evaluationOf(version, evaluations);
  return evaluation === undefined
    ? strings.noScore
    : strings.scoreCell(scoreText(evaluation.score), evaluation.passed, evaluation.total);
}

export function VersionList({
  items,
  pointers,
  evaluations,
  selected,
  onToggle,
  strings,
  locale,
}: Readonly<{
  items: AgentVersionListResponse['items'];
  pointers: AgentVersionListResponse['pointers'];
  evaluations: AgentVersionListResponse['evaluations'];
  selected: readonly number[];
  onToggle: (version: number) => void;
  strings: VersionsStrings;
  locale: VersionsLocale;
}>) {
  if (items.length === 0) return <p className="text-[13px] text-muted">{strings.empty}</p>;
  const viaLabel = { ui: strings.viaUi, 'aw-push': strings.viaAwPush, api: strings.viaApi };
  const newestFirst = [...items].sort((a, b) => b.number - a.number);
  return (
    <div className="overflow-x-auto rounded-(--radius) border border-border bg-surface">
      <table className="w-full border-collapse text-[13px]" aria-label={strings.listLabel}>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              {strings.columnSelect}
            </th>
            <th scope="col" className={TH}>
              {strings.columnVersion}
            </th>
            <th scope="col" className={TH}>
              {strings.columnVia}
            </th>
            <th scope="col" className={TH}>
              {strings.columnAuthor}
            </th>
            <th scope="col" className={TH}>
              {strings.columnTime}
            </th>
            <th scope="col" className={TH}>
              {strings.columnSummary}
            </th>
            <th scope="col" className={TH}>
              {strings.columnScore}
            </th>
          </tr>
        </thead>
        <tbody>
          {newestFirst.map((version) => (
            <tr key={version.id} data-version={version.number}>
              <td className={TD}>
                <input
                  type="checkbox"
                  aria-label={strings.selectVersion(version.number)}
                  checked={selected.includes(version.number)}
                  onChange={() => {
                    onToggle(version.number);
                  }}
                />
              </td>
              <td className={`${TD} whitespace-nowrap`}>
                <span className="font-semibold">v{version.number}</span>{' '}
                {badgesFor(version.number, pointers).map((environment) => (
                  <span
                    key={environment}
                    className="ml-1 rounded-full border border-border-strong px-2 py-px text-[11.5px]"
                  >
                    {environment === 'production' ? strings.badgeProduction : strings.badgeLocal}
                  </span>
                ))}
              </td>
              <td className={TD}>{viaLabel[version.via]}</td>
              <td className={`${TD} font-mono text-[12px]`}>{version.createdByPrincipalId}</td>
              <td className={`${TD} whitespace-nowrap`}>
                {new Date(version.createdAt).toLocaleString(locale)}
              </td>
              <td className={TD}>{version.summary}</td>
              <td className={`${TD} whitespace-nowrap`} data-score={version.number}>
                {scoreCellText(version.number, evaluations, strings)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SIGN = { same: '  ', add: '+ ', del: '− ' } as const;
const LINE_CLASS = {
  same: 'text-muted',
  add: 'bg-ok-soft text-text',
  del: 'bg-danger-soft text-text',
} as const;

/** Instructions as `+`/`−` lines, every other field as a before/after table. */
export function VersionDiff({
  older,
  newer,
  strings,
  connectorNames,
}: Readonly<{
  older: AgentVersionResource;
  newer: AgentVersionResource;
  strings: VersionsStrings;
  connectorNames: ConnectorNames;
}>) {
  const lines = lineDiff(
    older.body.definition.agent.instructions,
    newer.body.definition.agent.instructions,
  );
  const changes = fieldChanges(older.body, newer.body, connectorNames);
  const missing = strings.diffMissing;
  return (
    <section aria-labelledby="versions-diff-heading" className="space-y-3">
      <h2 id="versions-diff-heading" className="text-[15px] font-semibold">
        {strings.diffHeading(older.number, newer.number)}
      </h2>
      <h3 className="text-[13px] font-semibold">{strings.diffInstructions}</h3>
      {lines.every((line) => line.kind === 'same') ? (
        <p className="text-[13px] text-muted">{strings.diffNoInstructionChanges}</p>
      ) : (
        <div className="rounded-(--radius) border border-border bg-surface py-2 font-mono text-[12.5px]">
          {lines.map((line, index) => (
            <div key={index} className={`px-3 whitespace-pre-wrap ${LINE_CLASS[line.kind]}`}>
              {SIGN[line.kind]}
              {line.text}
            </div>
          ))}
        </div>
      )}
      <h3 className="text-[13px] font-semibold">{strings.diffFields}</h3>
      {changes.length === 0 ? (
        <p className="text-[13px] text-muted">{strings.diffNoFieldChanges}</p>
      ) : (
        <div className="overflow-x-auto rounded-(--radius) border border-border bg-surface">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  {strings.diffField}
                </th>
                <th scope="col" className={TH}>
                  {strings.diffBefore}
                </th>
                <th scope="col" className={TH}>
                  {strings.diffAfter}
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.path}>
                  <td className={`${TD} font-mono text-[12px]`}>{change.path}</td>
                  <td className={`${TD} font-mono text-[12px]`}>{change.before ?? missing}</td>
                  <td className={`${TD} font-mono text-[12px]`}>{change.after ?? missing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type Move = 'promote' | 'rollback';

function MoveControl({
  move,
  check,
  evaluation,
  open,
  busy,
  onAsk,
  onConfirm,
  onCancel,
  strings,
}: Readonly<{
  move: Move;
  check: MoveCheck;
  evaluation: ReactNode;
  open: boolean;
  busy: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  strings: VersionsStrings;
}>) {
  const label = move === 'promote' ? strings.promote : strings.rollback;
  const confirmLabel = move === 'promote' ? strings.confirmPromote : strings.confirmRollback;
  const blurb = move === 'promote' ? strings.promoteBlurb : strings.rollbackBlurb;
  let verdict: ReactNode = null;
  if (check.kind === 'ready') {
    // A rollback is never gated, so only a promote shows the bar.
    if (move === 'promote') {
      verdict =
        check.move.bar === null ? strings.noBar : strings.passesBar(barText(check.move.bar));
    }
  } else {
    verdict = checkText(check, strings);
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={BUTTON}
          disabled={check.kind !== 'ready' || open || busy}
          onClick={onAsk}
        >
          {label}
        </button>
        <span className="text-[12.5px] text-muted">{blurb}</span>
        {check.kind === 'ready' ? (
          <code className="text-[12.5px]">{planText(check.move)}</code>
        ) : null}
      </div>
      {evaluation === null ? null : (
        <p className="text-[12.5px] text-muted" data-evaluation="">
          {evaluation}
        </p>
      )}
      {verdict === null ? null : (
        <p
          className={`text-[12.5px] ${check.kind === 'ready' ? 'text-muted' : 'text-danger'}`}
          data-verdict={check.kind}
        >
          {verdict}
        </p>
      )}
      {open && check.kind === 'ready' ? (
        <div
          role="group"
          aria-label={confirmLabel}
          className="space-y-2 rounded-(--radius) border border-border-strong bg-surface-2 p-3"
        >
          <code className="block text-[13px]">{planText(check.move)}</code>
          <div className="flex gap-2">
            <button type="button" className={BUTTON} disabled={busy} onClick={onConfirm}>
              {busy ? strings.working : confirmLabel}
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onCancel}>
              {strings.cancel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Promote and Roll back, each with its dry-run plan and, for a promote, the gate's verdict. */
export function ReleaseControls({
  promote,
  rollback,
  evaluations,
  asking,
  busy,
  onAsk,
  onConfirm,
  onCancel,
  strings,
}: Readonly<{
  promote: MoveCheck;
  rollback: MoveCheck;
  evaluations: AgentVersionListResponse['evaluations'];
  asking: Move | null;
  busy: boolean;
  onAsk: (move: Move) => void;
  onConfirm: (move: Move) => void;
  onCancel: () => void;
  strings: VersionsStrings;
}>) {
  const common = { busy, onCancel, strings };
  const target = promoteTarget(promote);
  const evaluation = target === null ? undefined : evaluationOf(target, evaluations);
  let promoteEvaluation: ReactNode = null;
  if (target !== null) {
    promoteEvaluation =
      evaluation === undefined
        ? strings.notEvaluatedYet(target)
        : strings.latestEvaluation(
            target,
            scoreText(evaluation.score),
            evaluation.passed,
            evaluation.total,
          );
  }
  return (
    <section
      aria-labelledby="versions-release-heading"
      className="space-y-4 rounded-(--radius) border border-border bg-surface p-4"
    >
      <h2 id="versions-release-heading" className="text-[15px] font-semibold">
        {strings.releaseHeading}
      </h2>
      <MoveControl
        {...common}
        move="promote"
        check={promote}
        evaluation={promoteEvaluation}
        open={asking === 'promote'}
        onAsk={() => {
          onAsk('promote');
        }}
        onConfirm={() => {
          onConfirm('promote');
        }}
      />
      <MoveControl
        {...common}
        move="rollback"
        check={rollback}
        evaluation={null}
        open={asking === 'rollback'}
        onAsk={() => {
          onAsk('rollback');
        }}
        onConfirm={() => {
          onConfirm('rollback');
        }}
      />
    </section>
  );
}

type Loaded = {
  readonly list: AgentVersionListResponse;
  readonly promote: MoveCheck;
  readonly rollback: MoveCheck;
  readonly connectorNames: ConnectorNames;
};

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | ({ readonly kind: 'ready' } & Loaded);

/** See {@link connectorKeyNames}. A viewer who cannot list connectors sees the stored form. */
async function connectorNamesOf(
  client: AgentWorkspaceClient,
  signal: AbortSignal,
): Promise<ConnectorNames> {
  try {
    return connectorKeyNames(await client.connectors.list({ signal }));
  } catch {
    return {};
  }
}

/** The list and both dry runs; the dry runs write nothing and a refusal is data, not an error. */
async function loadRelease(
  client: AgentWorkspaceClient,
  agentId: string,
  signal: AbortSignal,
): Promise<Loaded> {
  const [list, promote, rollback, connectorNames] = await Promise.all([
    client.agents.versions.list(agentId, { signal }),
    client.agents.pointers.checkPromote(agentId, {}, { signal }).then(readyCheck, failedCheck),
    client.agents.pointers.checkRollback(agentId, {}, { signal }).then(readyCheck, failedCheck),
    connectorNamesOf(client, signal),
  ]);
  return { list, promote, rollback, connectorNames };
}

export function AgentVersionsScreen({
  agentId,
  locale,
}: Readonly<{ agentId: string; locale: VersionsLocale }>) {
  const strings = versionsStrings(locale);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloads, setReloads] = useState(0);
  const [selected, setSelected] = useState<readonly number[]>([]);
  const [asking, setAsking] = useState<Move | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadRelease(sessionClient(), agentId, controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) setState({ kind: 'ready', ...loaded });
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: 'failed' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [agentId, reloads]);

  async function confirm(move: Move): Promise<void> {
    setBusy(true);
    setOutcome(null);
    const pointers = sessionClient().agents.pointers;
    try {
      if (move === 'rollback' && state.kind === 'ready') {
        // A rollback names no version, so it would follow whatever history says now; refuse it
        // when the plan the dialog showed is no longer the plan.
        const fresh = await pointers.checkRollback(agentId).then(readyCheck, failedCheck);
        const refusal = rollbackRefusal(state.rollback, fresh);
        if (refusal !== null) {
          setOutcome({
            ok: false,
            text: refusal === 'plan_changed' ? strings.planChanged : checkText(refusal, strings),
          });
          return;
        }
      }
      const moved = await (move === 'promote'
        ? pointers.promote(agentId, state.kind === 'ready' ? promoteRequest(state.promote) : {})
        : pointers.rollback(agentId));
      setOutcome({ ok: true, text: strings.moved(planText(moved)) });
    } catch (error) {
      const failed = failedCheck(error);
      setOutcome({
        ok: false,
        text: failed.kind === 'ready' ? strings.unavailable : checkText(failed, strings),
      });
    } finally {
      setReloads((count) => count + 1);
      setAsking(null);
      setBusy(false);
    }
  }

  const items = state.kind === 'ready' ? state.list.items : [];
  const chosen = items
    .filter((version) => selected.includes(version.number))
    .sort((a, b) => a.number - b.number);
  const [older, newer] = chosen;

  return (
    <main lang={locale} className="w-full max-w-[960px] space-y-5 px-8 pt-[26px] pb-[90px]">
      <h1 className="text-[21px]">{strings.heading}</h1>
      {state.kind === 'loading' ? <p className="text-muted">{strings.loading}</p> : null}
      {state.kind === 'failed' ? (
        <p role="alert" className="text-danger">
          {strings.loadFailed}
        </p>
      ) : null}
      {outcome === null ? null : (
        <p
          role={outcome.ok ? 'status' : 'alert'}
          className={outcome.ok ? 'text-text' : 'text-danger'}
        >
          {outcome.text}
        </p>
      )}
      {state.kind === 'ready' ? (
        <>
          <ReleaseControls
            promote={state.promote}
            rollback={state.rollback}
            evaluations={state.list.evaluations}
            asking={asking}
            busy={busy}
            onAsk={setAsking}
            onConfirm={(move) => {
              void confirm(move);
            }}
            onCancel={() => {
              setAsking(null);
            }}
            strings={strings}
          />
          <VersionList
            items={state.list.items}
            pointers={state.list.pointers}
            evaluations={state.list.evaluations}
            selected={selected}
            onToggle={(version) => {
              setSelected((current) =>
                current.includes(version)
                  ? current.filter((number) => number !== version)
                  : [...current, version].slice(-2),
              );
            }}
            strings={strings}
            locale={locale}
          />
          {older !== undefined && newer !== undefined ? (
            <VersionDiff
              older={older}
              newer={newer}
              strings={strings}
              connectorNames={state.kind === 'ready' ? state.connectorNames : {}}
            />
          ) : (
            <p className="text-[13px] text-muted">{strings.diffHint}</p>
          )}
        </>
      ) : null}
    </main>
  );
}
