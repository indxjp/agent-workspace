'use client';

import Link from 'next/link';
import { createElement, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';

import type {
  AgentPermissionKey,
  AgentResource,
  AgentResourceAssignments,
} from '../../contracts/agents';
import { agentDetailStrings, type AgentDetailStrings } from './agent-detail-messages';
import { AgentEngineSection, useEngineCatalog } from './agent-detail-engine';
import { AgentModelSection } from './agent-detail-model-section';
import { problemText, SaveReportPanel } from './agent-detail-save-report';
import { PERMISSION_ORDER } from './new-agent-messages';
import { ProblemLine } from './problem-line';
import {
  resolveSaveOutcome,
  type RequestProblem,
  type SaveOutcome,
  type SaveReport,
} from './model';
import { browserClient } from '../../lib/browser-client';
import { loadAgent, saveAgentAssignments, saveAgentDefinition } from './agent-requests-model';
import { AgentResourcesEditor, useAgentProjects, useResourceCatalogs } from './resource-editor';
import type { ModelSelectionValue } from '../models/catalog';
import { useModelCatalog } from '../models/model-selector';
import type { VersionsLocale } from './versions-messages';

export { AgentModelSection } from './agent-detail-model-section';
export { AgentEngineSection } from './agent-detail-engine';

type Loaded = { agent: AgentResource; assignments: AgentResourceAssignments };

const CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';

/** The model override the agent carries; `null` unless both halves of the pair are set. */
function modelSelectionOf(agent: AgentResource): ModelSelectionValue {
  if (agent.modelConnectionId === null || agent.model === null) return null;
  return { connectionId: agent.modelConnectionId, model: agent.model };
}

/** Everything the screen edits and reports, with the actions that change it. */
function useAgentEditor(agentId: string) {
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

  /**
   * Two requests, reported separately (see {@link SaveReport}'s own comment). The assignments
   * `PUT` is only ever sent once the definition `PATCH` has actually succeeded — sending it
   * unconditionally would let a failed definition save look like it succeeded, the moment the
   * resources half came back `200` on its own.
   */
  async function performSave(agent: AgentResource, draft: AgentResourceAssignments) {
    const client = browserClient();
    const definition = await saveAgentDefinition(client, agent);
    if (!definition.ok) {
      applySaveOutcome({ kind: 'definition-failed', problem: definition.problem });
      return;
    }
    const savedAgent = definition.value;
    setLoaded((current) => (current === null ? null : { ...current, agent: savedAgent }));

    const assignments = await saveAgentAssignments(client, agentId, draft);
    if (!assignments.ok) {
      applySaveOutcome({ kind: 'assignments-failed', problem: assignments.problem });
      return;
    }
    applySaveOutcome({ kind: 'both-saved', persistedAssignments: assignments.value });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loaded === null || assignmentsDraft === null || saving) return;
    setSaving(true);
    setProblem(null);
    setSaveReport(null);
    await performSave(loaded.agent, assignmentsDraft);
    setSaving(false);
  }

  return {
    loaded,
    assignmentsDraft,
    setAssignmentsDraft,
    problem,
    saveReport,
    saving,
    changeAgent,
    changeModel,
    changePermission,
    save,
  };
}

/** The agent's name and instructions. */
function DefinitionSection({
  agent,
  words,
  onChange,
}: Readonly<{
  agent: AgentResource;
  words: AgentDetailStrings;
  onChange: (patch: Partial<AgentResource>) => void;
}>) {
  return (
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
          value={agent.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label className="block text-[13px] font-semibold" htmlFor="agent-detail-instructions">
        {words.instructions}
        {createElement('textarea', {
          id: 'agent-detail-instructions',
          rows: 8,
          className: `${CONTROL} mt-1 min-h-[110px] resize-y`,
          value: agent.instructions,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ instructions: event.target.value }),
        })}
      </label>
    </section>
  );
}

/** One checkbox per permission the agent can be granted. */
function PermissionsSection({
  permissions,
  words,
  onChange,
}: Readonly<{
  permissions: AgentResource['permissions'];
  words: AgentDetailStrings;
  onChange: (key: AgentPermissionKey, value: boolean) => void;
}>) {
  return (
    <fieldset className="rounded-(--radius) border border-border bg-surface p-4">
      <legend className="px-1 text-[15px] font-semibold">{words.permissions}</legend>
      <p className="mb-3 text-[12px] text-muted">{words.permissionsHelp}</p>
      {PERMISSION_ORDER.map((key) => (
        <label className="flex items-center gap-2 py-1.5 text-[13px]" key={key}>
          <input
            type="checkbox"
            checked={permissions[key]}
            onChange={(event) => onChange(key, event.target.checked)}
          />
          {words.permissionLabels[key]}
        </label>
      ))}
    </fieldset>
  );
}

/** The failed-save alert shown above the per-half report. */
function SaveProblem({
  problem,
  locale,
  words,
}: Readonly<{ problem: RequestProblem; locale: VersionsLocale; words: AgentDetailStrings }>) {
  return (
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
  );
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
  const editor = useAgentEditor(agentId);
  const { loaded, assignmentsDraft, problem, saveReport, saving } = editor;

  const catalogState = useModelCatalog();
  const catalogsState = useResourceCatalogs();
  const projectsState = useAgentProjects();
  const engineCatalogState = useEngineCatalog();

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

  const { agent } = loaded;
  return (
    <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]" lang={locale}>
      <div className="mb-5 flex items-center gap-3">
        <div>
          <h1 className="text-[21px]">{agent.name}</h1>
          <p className="mt-1 text-[13px] text-muted">{words.subtitle}</p>
        </div>
        <Link className="ml-auto text-[13px] whitespace-nowrap text-accent" href="/agents">
          {words.backToAgents}
        </Link>
      </div>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          void editor.save(event);
        }}
      >
        <DefinitionSection agent={agent} words={words} onChange={editor.changeAgent} />
        <AgentModelSection
          catalogState={catalogState}
          value={modelSelectionOf(agent)}
          onChange={editor.changeModel}
          locale={locale}
        />
        <AgentEngineSection catalog={engineCatalogState} locale={locale} />
        <PermissionsSection
          permissions={agent.permissions}
          words={words}
          onChange={editor.changePermission}
        />
        {assignmentsDraft === null ? (
          <p className="text-[13px] text-muted">{words.loadingAssignments}</p>
        ) : (
          <AgentResourcesEditor
            agentId={agentId}
            assignments={assignmentsDraft}
            permissions={agent.permissions}
            catalogsState={catalogsState}
            projectsState={projectsState}
            onChange={editor.setAssignmentsDraft}
            locale={locale}
          />
        )}
        {problem === null ? null : <SaveProblem problem={problem} locale={locale} words={words} />}
        {saveReport === null ? null : (
          <SaveReportPanel report={saveReport} locale={locale} words={words} />
        )}
        <div className="flex justify-end">
          <button
            className="rounded bg-accent px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            disabled={saving || agent.name.trim() === '' || assignmentsDraft === null}
            type="submit"
          >
            {saving ? words.saving : words.save}
          </button>
        </div>
      </form>
    </main>
  );
}
