'use client';

import Link from 'next/link';
import { createElement, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';

import type {
  AgentPermissionKey,
  AgentResource,
  AgentResourceAssignments,
} from '../../contracts/agents';
import type { EngineDescriptor } from '../../contracts/engines';
import { agentDetailStrings, type AgentDetailStrings } from './agent-detail-messages';
import { PERMISSION_ORDER } from './new-agent-messages';
import { ProblemLine } from './problem-line';
import {
  describeHalf,
  resolveSaveOutcome,
  type RequestProblem,
  type SaveOutcome,
  type SaveReport,
} from './model';
import { browserClient } from '../../lib/browser-client';
import {
  loadAgent,
  loadEngines,
  saveAgentAssignments,
  saveAgentDefinition,
} from './agent-requests-model';
import { AgentResourcesEditor, useAgentProjects, useResourceCatalogs } from './resource-editor';
import { describeInheritance, type ModelSelectionValue } from '../models/catalog';
import { ModelSelector, ModelUnavailableNotice, useModelCatalog } from '../models/model-selector';
import type { VersionsLocale } from './versions-messages';

type Loaded = { agent: AgentResource; assignments: AgentResourceAssignments };

const CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';

/**
 * Issue #130's Acceptance Criteria: "Agent detail can change or clear an override." Extracted from
 * `AgentDetailScreen` for the same reason `agent-form.tsx` exports `ModelStep` separately — a
 * screen driven entirely by two `useEffect` fetches can only ever be asserted in its pre-fetch
 * "Loading…" state by a static render, so the actual editing behaviour is tested against this
 * component directly, with `catalogState` and `value` supplied by the test rather than by a mock
 * `fetch`.
 */
export function AgentModelSection({
  catalogState,
  value,
  onChange,
  locale = 'en',
}: Readonly<{
  catalogState: ReturnType<typeof useModelCatalog>;
  value: ModelSelectionValue;
  onChange: (value: ModelSelectionValue) => void;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = agentDetailStrings(locale);
  const catalogModels = catalogState.kind === 'ready' ? catalogState.catalog.models : [];
  const catalogUnavailable = catalogState.kind === 'ready' ? catalogState.catalog.unavailable : [];
  return (
    <section
      className="rounded-(--radius) border border-border bg-surface p-4"
      aria-labelledby="model-heading"
    >
      <h2 id="model-heading" className="mb-1 text-[15px] font-semibold">
        {words.model}
      </h2>
      <p className="mb-3 text-[12.5px] text-muted">{words.modelHelp}</p>
      {catalogState.kind === 'loading' ? (
        <p className="text-[13px] text-muted">{words.loadingModels}</p>
      ) : catalogState.kind === 'failed' ? (
        <p className="text-[13px] text-danger" role="alert">
          <ProblemLine
            locale={locale}
            english={catalogState.reason}
            lead={words.modelsFailed}
            detail={catalogState.detail}
          />
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ModelSelector
            id="agent-detail-model"
            label={words.override}
            models={catalogModels}
            value={value}
            onChange={onChange}
            inheritLabel={words.noOverride}
            ariaDescribedBy="model-inheritance-line"
            words={{ connection: words.connection, noModels: words.noModelsAvailable }}
          />
          <button
            type="button"
            className="text-[12px] text-accent underline disabled:pointer-events-none disabled:opacity-45"
            disabled={value === null}
            onClick={() => onChange(null)}
          >
            {words.clearOverride}
          </button>
        </div>
      )}
      <p id="model-inheritance-line" className="mt-1.5 text-[12px] text-muted">
        {value === null
          ? words.overrideNotSet
          : describeInheritance(words.agentOverride, value, catalogModels, words.staleModel)}
      </p>
      <ModelUnavailableNotice unavailable={catalogUnavailable} dismissLabel={words.dismiss} />
    </section>
  );
}

/** What `GET /api/engines` has told this screen so far. */
export type EngineCatalogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly engines: readonly EngineDescriptor[] }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Issue #319 (ENG-02c): the engine an agent runs on, shown and not offered as a choice.
 *
 * The section is **read-only on purpose**, and the reason is a fact about the deployment rather
 * than an unfinished control: an agent's engine is the discriminant of its policy, and switching it
 * rewrites the policy's engine-native half. ENG-09 (#308) published the second engine
 * (`openai-agents`) without a picker — that is a product decision the unit did not take — so the
 * arm is set deliberately with `aw agents update --engine`, and this list says what each installed
 * engine can honour. An engine that declares `skills: false` is marked as such, because a skill
 * assigned below is then refused (`422 engine_capability_unsupported`) rather than ignored; an
 * engine that declares `mcp: false` (`pi`, ENG-08 #307) is marked for its connectors the same way.
 * An engine that honours both (`mastra`, ENG-10 #309) carries no marker.
 *
 * The four states are the four `GET /api/engines` can produce, and there is no fifth: a
 * deployment with no installed engine is called out rather than rendered as an empty list, because
 * it is the one state in which no agent on this screen can run at all.
 *
 * Exported and pure, for the same reason `AgentModelSection` is: a screen driven by fetch effects
 * can only be asserted in its pre-fetch state by a static render, so the states that matter are
 * tested against this component with `catalog` supplied by the test.
 */
export function AgentEngineSection({
  catalog,
  locale = 'en',
}: Readonly<{
  catalog: EngineCatalogState;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = agentDetailStrings(locale);
  const installed = catalog.kind === 'ready' ? catalog.engines.filter((e) => e.installed) : [];
  return (
    <section
      className="rounded-(--radius) border border-border bg-surface p-4"
      aria-labelledby="engine-heading"
    >
      <h2 id="engine-heading" className="mb-1 text-[15px] font-semibold">
        {words.engine}
      </h2>
      <p className="mb-3 text-[12.5px] text-muted">{words.engineHelp}</p>
      {catalog.kind === 'loading' ? (
        <p className="text-[13px] text-muted">{words.loadingEngines}</p>
      ) : catalog.kind === 'failed' ? (
        <p className="text-[13px] text-danger" role="alert">
          <ProblemLine
            locale={locale}
            english={catalog.reason}
            lead={words.enginesFailed}
            detail={catalog.reason}
          />
        </p>
      ) : installed.length === 0 ? (
        <p className="text-[13px] text-danger" role="alert">
          {words.noEngine}
        </p>
      ) : (
        <>
          <ul className="text-[13px] text-text">
            {installed.map((engine) => (
              <li key={engine.id}>
                {engine.displayName} <span className="text-muted">({engine.id})</span>,{' '}
                {words.engineVersion(engine.version)}
                {engine.capabilities.skills ? null : (
                  <span className="text-muted">{words.skillsUnavailable}</span>
                )}
                {engine.capabilities.mcp ? null : (
                  <span className="text-muted">{words.connectorsUnavailable}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] text-muted">
            {words.engineReadOnlyBefore}
            <code>aw agents update --engine</code>
            {words.engineReadOnlyAfter}
          </p>
        </>
      )}
    </section>
  );
}

/** The one line a {@link RequestProblem} shows, whichever arm it is. */
function problemText(problem: RequestProblem): string {
  return problem.kind === 'api' ? problem.message : problem.reason;
}

/**
 * One half of the save report: saved, not attempted, or refused with the server's own reason.
 * English is `describeHalf`'s sentence, as before; another language marks the reason English.
 */
function halfLine(
  locale: VersionsLocale,
  words: AgentDetailStrings,
  label: string,
  outcome: SaveReport['definition'],
  problem: RequestProblem | null,
) {
  if (locale === 'en') return describeHalf(label, outcome, problem);
  if (outcome === 'saved') return words.halfSaved(label);
  if (outcome === 'not-attempted') return words.halfNotAttempted(label);
  return (
    <>
      {words.halfNotSaved(label)}{' '}
      <span lang="en">{problem === null ? '' : problemText(problem)}</span>
    </>
  );
}

/** `GET /api/engines`, read once per mount. */
function useEngineCatalog(): EngineCatalogState {
  const [state, setState] = useState<EngineCatalogState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void loadEngines(browserClient()).then((result) => {
      if (!active) return;
      setState(
        result.ok
          ? { kind: 'ready', engines: result.value }
          : { kind: 'failed', reason: problemText(result.problem) },
      );
    });
    return () => {
      active = false;
    };
  }, []);
  return state;
}

export function AgentDetailScreen({
  agentId,
  locale = 'en',
}: Readonly<{
  agentId: string;
  /** The reader's language (UX-15 in #2086); English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = agentDetailStrings(locale);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The editable working copy of `loaded.assignments`. Kept separate so a failed `PUT` (verifier
  // attack #3) never overwrites `loaded.assignments` with an optimistic view of what was
  // attempted — `loaded.assignments` only ever changes on a successful `GET` or `PUT`, so a reload
  // (a fresh `GET`, i.e. a fresh mount of this component) shows exactly the last state the server
  // actually confirmed, never a draft that failed to save.
  const [assignmentsDraft, setAssignmentsDraft] = useState<AgentResourceAssignments | null>(null);
  const [problem, setProblem] = useState<RequestProblem | null>(null);
  const [saveReport, setSaveReport] = useState<SaveReport | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void loadAgent(browserClient(), agentId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setProblem(result.problem);
        return;
      }
      setLoaded(result.value);
      setAssignmentsDraft(result.value.assignments);
    });
    return () => {
      active = false;
    };
  }, [agentId]);

  const catalogState = useModelCatalog();
  const catalogsState = useResourceCatalogs();
  const projectsState = useAgentProjects();
  const engineCatalogState = useEngineCatalog();

  const changeAgent = (patch: Partial<AgentResource>) => {
    setLoaded((current) =>
      current === null ? null : { ...current, agent: { ...current.agent, ...patch } },
    );
  };
  // Issue #130: "Agent detail can change or clear an override." `modelConnectionId` and `model`
  // are written and cleared together — never one without the other — the same pairing rule every
  // other layer of the resolution ladder holds to (`workspaces_default_model_pair`, `#129`'s own
  // run-override body parser).
  const changeModel = (value: ModelSelectionValue) => {
    changeAgent({
      modelConnectionId: value === null ? null : value.connectionId,
      model: value === null ? null : value.model,
    });
  };
  const changePermission = (key: AgentPermissionKey, value: boolean) => {
    if (loaded === null) return;
    changeAgent({ permissions: { ...loaded.agent.permissions, [key]: value } });
  };

  /**
   * Two requests, reported separately (see {@link SaveReport}'s own comment). The assignments
   * `PUT` is only ever sent once the definition `PATCH` has actually succeeded — sending it
   * unconditionally would let a failed definition save look like it succeeded, the moment the
   * resources half came back `200` on its own.
   */
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loaded === null || assignmentsDraft === null || saving) return;
    setSaving(true);
    setProblem(null);
    setSaveReport(null);

    const client = browserClient();
    const definition = await saveAgentDefinition(client, loaded.agent);
    if (!definition.ok) {
      applySaveOutcome({ kind: 'definition-failed', problem: definition.problem });
      setSaving(false);
      return;
    }
    const savedAgent = definition.value;
    setLoaded((current) => (current === null ? null : { ...current, agent: savedAgent }));

    const assignments = await saveAgentAssignments(client, agentId, assignmentsDraft);
    if (!assignments.ok) {
      applySaveOutcome({ kind: 'assignments-failed', problem: assignments.problem });
      setSaving(false);
      return;
    }
    applySaveOutcome({ kind: 'both-saved', persistedAssignments: assignments.value });
    setSaving(false);
  }

  /**
   * `resolveSaveOutcome` (`./model.ts`) is the pure state machine — this is only the React side of
   * applying its answer. `persistedAssignments: null` (a failed or not-attempted `PUT`) touches
   * neither `loaded.assignments` nor `assignmentsDraft`: leaving both exactly as they were is what
   * makes a reload (a fresh `GET`, i.e. a fresh mount of this component) show the same state this
   * save attempt just reported, never an optimistic view of what was merely attempted (verifier
   * attack #3). Only `'both-saved'` resyncs the draft — to what the server actually persisted
   * (which may have normalised the request, e.g. narrowing a `'read-write'` grant this agent's own
   * `writeFiles` permission does not allow), not to what was merely requested.
   */
  function applySaveOutcome(outcome: SaveOutcome): void {
    const { report, persistedAssignments } = resolveSaveOutcome(outcome);
    setSaveReport(report);
    if (persistedAssignments === null) return;
    setLoaded((current) =>
      current === null ? null : { ...current, assignments: persistedAssignments },
    );
    setAssignmentsDraft(persistedAssignments);
  }

  if (problem !== null && loaded === null) {
    return (
      <main className="w-full max-w-[760px] px-8 pt-[26px]" role="alert" lang={locale}>
        <ProblemLine
          locale={locale}
          english={problemText(problem)}
          lead={words.loadFailed}
          detail={problemText(problem)}
        />
      </main>
    );
  }
  if (loaded === null) {
    return (
      <main className="px-8 pt-[26px] text-muted" lang={locale}>
        {words.loadingAgent}
      </main>
    );
  }

  return (
    <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]" lang={locale}>
      <div className="mb-5 flex items-center gap-3">
        <div>
          <h1 className="text-[21px]">{loaded.agent.name}</h1>
          <p className="mt-1 text-[13px] text-muted">{words.subtitle}</p>
        </div>
        <Link className="ml-auto text-[13px] whitespace-nowrap text-accent" href="/agents">
          {words.backToAgents}
        </Link>
      </div>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <section
          className="rounded-(--radius) border border-border bg-surface p-4"
          aria-labelledby="definition-heading"
        >
          <h2 id="definition-heading" className="mb-4 text-[15px] font-semibold">
            {words.definition}
          </h2>
          <label className="mb-4 block text-[13px] font-semibold" htmlFor="agent-detail-name">
            {words.name}
            <input
              id="agent-detail-name"
              className={`${CONTROL} mt-1`}
              value={loaded.agent.name}
              onChange={(event) => changeAgent({ name: event.target.value })}
            />
          </label>
          <label className="block text-[13px] font-semibold" htmlFor="agent-detail-instructions">
            {words.instructions}
            {createElement('textarea', {
              id: 'agent-detail-instructions',
              rows: 8,
              className: `${CONTROL} mt-1 min-h-[110px] resize-y`,
              value: loaded.agent.instructions,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
                changeAgent({ instructions: event.target.value }),
            })}
          </label>
        </section>
        <AgentModelSection
          catalogState={catalogState}
          value={
            loaded.agent.modelConnectionId === null || loaded.agent.model === null
              ? null
              : { connectionId: loaded.agent.modelConnectionId, model: loaded.agent.model }
          }
          onChange={changeModel}
          locale={locale}
        />
        <AgentEngineSection catalog={engineCatalogState} locale={locale} />
        <fieldset className="rounded-(--radius) border border-border bg-surface p-4">
          <legend className="px-1 text-[15px] font-semibold">{words.permissions}</legend>
          <p className="mb-3 text-[12px] text-muted">{words.permissionsHelp}</p>
          {PERMISSION_ORDER.map((key) => (
            <label className="flex items-center gap-2 py-1.5 text-[13px]" key={key}>
              <input
                type="checkbox"
                checked={loaded.agent.permissions[key]}
                onChange={(event) => changePermission(key, event.target.checked)}
              />
              {words.permissionLabels[key]}
            </label>
          ))}
        </fieldset>
        {assignmentsDraft === null ? (
          <p className="text-[13px] text-muted">{words.loadingAssignments}</p>
        ) : (
          <AgentResourcesEditor
            agentId={agentId}
            assignments={assignmentsDraft}
            permissions={loaded.agent.permissions}
            catalogsState={catalogsState}
            projectsState={projectsState}
            onChange={setAssignmentsDraft}
            locale={locale}
          />
        )}
        {problem === null ? null : (
          <div
            role="alert"
            className="rounded border border-danger bg-danger-soft p-3 text-[13px] text-danger"
          >
            <ProblemLine
              locale={locale}
              english={problemText(problem)}
              lead={words.saveFailed}
              detail={problemText(problem)}
            />
          </div>
        )}
        {saveReport === null ? null : (
          <div
            role="alert"
            className={`rounded border p-3 text-[13px] ${
              saveReport.definition === 'saved' && saveReport.assignments === 'saved'
                ? 'border-border bg-surface text-text'
                : 'border-danger bg-danger-soft text-danger'
            }`}
          >
            <p>
              {halfLine(
                locale,
                words,
                words.definitionHalf,
                saveReport.definition,
                saveReport.definitionProblem,
              )}
            </p>
            <p>
              {halfLine(
                locale,
                words,
                words.assignmentsHalf,
                saveReport.assignments,
                saveReport.assignmentsProblem,
              )}
            </p>
          </div>
        )}
        <div className="flex justify-end">
          <button
            className="rounded bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            disabled={saving || loaded.agent.name.trim() === '' || assignmentsDraft === null}
            type="submit"
          >
            {saving ? words.saving : words.save}
          </button>
        </div>
      </form>
    </main>
  );
}
