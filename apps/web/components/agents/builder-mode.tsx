import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { Speaker } from '@indx-workspace/react/run-model';
import { ApiProblemError } from '@indx-workspace/sdk';
import type { AgentEvent } from '@indx-workspace/sdk/events';

import type { AgentResource } from '../../contracts/agents';
import { browserClient } from '../../lib/browser-client';
import { requestOutcome } from '../../lib/request-outcome';
import { HomeChat } from '../composer/home-chat';
import type { ComposerAgent } from '../composer/model';
import type { ComposerPrefill } from '../run/run-view';
import { initialsFrom } from '../shell/identity';
import { loadAgents } from './agent-requests-model';
import { BTN, BTN_DEFAULT } from './agent-form';
import { BuilderApproval, type DecisionProblem } from './builder-approval';
import { detailText, refusalText } from './builder-messages';
import { BuilderSaved } from './builder-saved';
import {
  builderRefusalIn,
  draftsFrom,
  type DraftView,
  type SavedDraft,
} from './definition-from-run';
import { diffBodies, type DefinitionSection } from '@indx-workspace/sdk/portable';
import { DefinitionPreview } from './definition-preview';
import type { RequestProblem } from './model';

const UNAVAILABLE = 'The Builder is not available in this workspace';
const NOT_SENT = 'The decision did not reach the server. Check your connection and try again.';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly problem: RequestProblem }
  | { readonly kind: 'ready'; readonly builder: AgentResource | undefined; readonly user: Speaker };

/** The built-in Builder, or `undefined`: no other agent stands in for it. */
function builderAgentIn(agents: readonly AgentResource[]): AgentResource | undefined {
  return agents.find((agent) => agent.builtin === 'builder');
}

function problemText(problem: RequestProblem): string {
  return problem.kind === 'api' ? problem.message : problem.reason;
}

interface RunEvent {
  readonly event: AgentEvent;
  readonly runId: string | undefined;
}

type BuilderIdentity = Pick<AgentResource, 'id' | 'name'>;

function composerAgentFor(builder: BuilderIdentity): ComposerAgent {
  return {
    id: builder.id,
    name: builder.name,
    detail: 'Builds an agent with you, one question at a time.',
    files: [],
    connectors: [],
    sandbox: 'Builder',
    runTarget: { kind: 'unknown' },
    drivableProviders: [],
  };
}

/**
 * The body the person last saw before the latest draft: the last earlier draft that reads
 * differently. The Builder checks a body and then saves that same body, and comparing the save with
 * its own check would hide every change just when the approval card asks about them (UX-11).
 */
function previousBody(drafts: readonly DraftView[], latest: DraftView): DraftView['body'] | null {
  for (let index = drafts.length - 2; index >= 0; index -= 1) {
    const draft = drafts[index];
    if (draft !== undefined && diffBodies(draft.body, latest.body).length > 0) return draft.body;
  }
  return null;
}

/**
 * The definition the Builder is writing. It follows the latest `draft_check` or `draft_save` input
 * in the run's events, never the assistant's text, and a failed check shows its code and details.
 * `saved`, the latest save of a run the person approved, adds the saved version and its links.
 */
export function BuilderPreviewPanel({
  events,
  saved = null,
  onAskBuilder,
}: Readonly<{
  events: readonly AgentEvent[];
  saved?: SavedDraft | null;
  onAskBuilder: (section: DefinitionSection) => void;
}>) {
  const drafts = draftsFrom(events);
  const latest = drafts.at(-1);
  const header = saved === null ? null : <BuilderSaved saved={saved} />;
  if (latest === undefined) {
    return (
      <>
        {header}
        <p className="text-[13px] text-muted">
          The definition appears here once the Builder checks a draft.
        </p>
      </>
    );
  }
  const failure = latest.result?.ok === false ? latest.result : null;
  return (
    <>
      {header}
      {failure === null ? null : (
        <div
          role="alert"
          className="mb-3 rounded-(--radius) border border-border-strong bg-danger-soft p-3 text-[13px]"
        >
          <p className="font-semibold">
            {latest.source === 'save' ? 'The last save failed.' : 'The last check failed.'}{' '}
            {failure.message ?? ''}
          </p>
          {failure.details.length === 0 ? null : (
            <ul className="mt-1 list-disc pl-5">
              {failure.details.map((detail, index) => (
                // Two details may read the same; the position keeps their keys apart.
                <li key={`${String(index)}:${detail}`}>{detailText(detail)}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[12px] text-muted">
            Code: <code>{failure.code}</code>
          </p>
        </div>
      )}
      <DefinitionPreview
        body={latest.body}
        previous={previousBody(drafts, latest)}
        onAskBuilder={onAskBuilder}
      />
    </>
  );
}

export function BuilderChat({
  builder,
  user,
  filesEnabled = true,
}: Readonly<{ builder: BuilderIdentity; user: Speaker; filesEnabled?: boolean }>) {
  const [entries, setEntries] = useState<readonly RunEvent[]>([]);
  const [decided, setDecided] = useState<readonly string[]>([]);
  // The continuation runs the person approved: only their saves count as saved.
  const [approved, setApproved] = useState<readonly string[]>([]);
  const [follow, setFollow] = useState<{ runId: string; nonce: number } | undefined>(undefined);
  const [prefill, setPrefill] = useState<ComposerPrefill | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const events = useMemo(() => entries.map((entry) => entry.event), [entries]);
  const refusal = builderRefusalIn(events);
  const saved =
    draftsFrom(
      entries
        .filter((entry) => entry.runId !== undefined && approved.includes(entry.runId))
        .map((entry) => entry.event),
    ).findLast((draft) => draft.saved !== null)?.saved ?? null;
  // The card belongs to the latest run's pause; a later run, or a decision, retires it.
  const asked = entries.findLast((entry) => entry.event.frame === 'agent.approval.requested');
  const waitingRun =
    asked?.runId !== undefined &&
    asked.runId === entries.at(-1)?.runId &&
    !decided.includes(asked.runId)
      ? asked.runId
      : null;

  async function decide(
    runId: string,
    decision: 'approve' | 'reject',
  ): Promise<DecisionProblem | null> {
    const runs = browserClient().runs;
    try {
      const { run } = await (decision === 'approve' ? runs.approve(runId) : runs.reject(runId));
      setDecided((current) => [...current, runId]);
      if (decision === 'approve') setApproved((current) => [...current, run.id]);
      setFollow((current) => ({ runId: run.id, nonce: (current?.nonce ?? 0) + 1 }));
      return null;
    } catch (error) {
      return error instanceof ApiProblemError
        ? { message: error.message, code: error.code }
        : { message: NOT_SENT, code: 'request_failed' };
    }
  }

  function askBuilder(section: DefinitionSection) {
    const title = `${section.charAt(0).toUpperCase()}${section.slice(1)}`;
    setPrefill((current) => ({ text: `Change ${title}: `, nonce: (current?.nonce ?? 0) + 1 }));
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <section aria-label="Definition" className="min-w-0 lg:order-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="builder-definition"
          onClick={() => setOpen((current) => !current)}
          className={`${BTN} ${BTN_DEFAULT} lg:hidden`}
        >
          Definition
        </button>
        <div
          id="builder-definition"
          className={`${open ? 'block' : 'hidden'} mt-3 lg:mt-0 lg:block`}
        >
          <BuilderPreviewPanel events={events} saved={saved} onAskBuilder={askBuilder} />
        </div>
      </section>
      <div className="min-w-0 lg:order-1">
        {refusal === null ? null : (
          <p role="alert" className="mb-3 text-[13px]">
            {UNAVAILABLE}. {refusalText(refusal)}{' '}
            <span className="text-muted">
              Code: <code>{refusal}</code>
            </span>
          </p>
        )}
        <HomeChat
          landmark={false}
          agents={{ kind: 'agents', agents: [composerAgentFor(builder)] }}
          recent={[]}
          user={user}
          filesEnabled={filesEnabled}
          agent={{ id: builder.id, locked: true }}
          {...(prefill === undefined ? {} : { prefill })}
          {...(follow === undefined ? {} : { follow })}
          onAgentEvent={(event, runId) => setEntries((current) => [...current, { event, runId }])}
          approval={
            waitingRun === null ? null : (
              <BuilderApproval
                key={waitingRun}
                events={events}
                onDecide={(decision) => decide(waitingRun, decision)}
              />
            )
          }
        />
      </div>
    </div>
  );
}

/** `/agents/new?mode=chat`: the chat with the built-in Builder beside the definition it writes. */
export function BuilderMode({
  modeSwitch,
  filesEnabled,
}: Readonly<{ modeSwitch: ReactNode; filesEnabled: boolean }>) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    const client = browserClient();
    void Promise.all([
      loadAgents(client),
      requestOutcome(
        client.me(),
        'The request to load your profile failed',
        'Your profile was not the published contract.',
      ),
    ]).then(([agents, me]) => {
      if (!active) return;
      if (!agents.ok) {
        setLoaded({ kind: 'failed', problem: agents.problem });
        return;
      }
      if (!me.ok) {
        setLoaded({ kind: 'failed', problem: me.problem });
        return;
      }
      setLoaded({
        kind: 'ready',
        builder: builderAgentIn(agents.value),
        user: { initials: initialsFrom(me.value.label), name: me.value.label },
      });
    });
    return () => {
      active = false;
    };
  }, []);

  // The page's one <main> in every state, as the form mode's, with the heading and mode switch
  // inside it; the chat it holds draws a plain <div> (`landmark={false}`). "Skip to content" lands
  // here (UX-23).
  return (
    <main className="w-full max-w-[1320px] px-5 pt-[26px] pb-[90px] sm:px-8">
      <h1 className="mb-[22px] text-[21px]">New Agent</h1>
      {modeSwitch}
      {loaded.kind === 'loading' ? (
        <p className="text-[13px] text-muted">Loading the Builder…</p>
      ) : loaded.kind === 'failed' ? (
        <p role="alert" className="text-[13px]">
          {problemText(loaded.problem)}
        </p>
      ) : loaded.builder === undefined ? (
        <p className="text-[13px] text-muted">{UNAVAILABLE}</p>
      ) : (
        <BuilderChat builder={loaded.builder} user={loaded.user} filesEnabled={filesEnabled} />
      )}
    </main>
  );
}
