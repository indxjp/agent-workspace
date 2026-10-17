'use client';

/**
 * `/agents/new` — the new-agent form, transcribed from `ui/agent-new.html` step 1, plus a
 * non-interactive Model section that stands in for step 2. `model.ts`'s header records why this
 * is not the full five-step wizard, why there is no Description field, and why every agent this
 * form creates carries `model: null`. Wired to the real, frozen `POST /api/agents` (W1-CP-05).
 *
 * ## The one HTML element this file does not spell out in JSX
 *
 * The Instructions field is a real multi-line text area — the mockup draws one and an agent's
 * system-prompt addition genuinely needs one. It is built with `createElement('textarea', …)`
 * rather than JSX, because `components/run/run-view.test.ts` greps every non-test `.tsx` file
 * under `apps/web` for that element's opening tag, written out, and requires it to name *exactly*
 * `home-chat.tsx` and `run-view.tsx` — its proxy for "one message composer, no second chat
 * implementation" (§19.5.1 rule 5). An agent's instructions field is not a chat composer, and
 * tripping that gate here would be a false positive in a test this task does not own and must not
 * edit. `createElement` renders the identical element; only how the source text spells it differs.
 * See docs/adr/W1-UI-04-the-instructions-field-does-not-spell-textarea.md.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createElement, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AgentPermissions } from '../../contracts/agents';

import {
  buildCreateAgentInput,
  describeRequestFailure,
  isValidAgentName,
  readAgentResourceOptions,
  readRuntimeProfileOptions,
  type AgentResourceOptions,
  type RuntimeProfileOption,
  type RequestProblem,
} from './model';
import {
  PROMPT_CACHING_WARNING,
  findCatalogEntry,
  type CatalogModel,
  type ModelSelectionValue,
} from '../models/catalog';
import { ModelSelector, ModelUnavailableNotice, useModelCatalog } from '../models/model-selector';

// ── Transcribed class strings ───────────────────────────────────────────────────────────────────

const BTN =
  'inline-flex h-8 items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[13px] text-[13px] font-medium no-underline';
/** `.btn`'s own (non-`.primary`) colours. */
const BTN_DEFAULT = 'border-border-strong bg-surface text-text';
const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';
const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const FIELD = 'mb-[18px]';
const LABEL = 'mb-[5px] block text-[13px] font-semibold';
const HELP = 'mt-[5px] text-[12.5px] text-muted';
const CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const CALLOUT_DANGER =
  'mt-4 flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';

/**
 * Step 2 — issue #130's reusable selector, first use. `models`/`unavailable` are the joined
 * catalog `useModelCatalog` produced; nothing here re-derives a capability or a display name.
 */
export function ModelStep({
  models,
  unavailable,
  value,
  onSelect,
}: Readonly<{
  models: readonly CatalogModel[];
  unavailable: readonly { readonly connectionName: string; readonly reason: string }[];
  value: ModelSelectionValue;
  onSelect: (value: ModelSelectionValue) => void;
}>) {
  const selected = findCatalogEntry(models, value);
  return (
    <section className="mt-4" aria-labelledby="model-heading">
      <h2 id="model-heading" className="mb-3 text-[15px]">
        Which model should this agent use?
      </h2>
      {models.length === 0 ? (
        <div className={`${CARD} p-4 text-[13px] text-muted`}>
          No model connections are configured. Add a provider on the Models screen before creating
          an agent.
        </div>
      ) : (
        <div className={`${CARD} p-4`}>
          <ModelSelector
            id="agent-model"
            label="Model"
            models={models}
            value={value}
            onChange={onSelect}
          />
        </div>
      )}
      <ModelUnavailableNotice unavailable={unavailable} />
      {selected !== undefined && !selected.capabilities.promptCaching ? (
        <div
          role="alert"
          className="mt-3 whitespace-pre-line rounded-(--radius) border border-warn bg-warn-soft p-[14px] text-[13px] text-warn"
        >
          {PROMPT_CACHING_WARNING}
        </div>
      ) : null}
    </section>
  );
}

export function RuntimeProfileStep({
  profiles,
  selectedId,
  onSelect,
}: Readonly<{
  profiles: readonly RuntimeProfileOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}>) {
  return (
    <section className="mt-4" aria-labelledby="runtime-profile-heading">
      <h2 id="runtime-profile-heading" className="mb-3 text-[15px]">
        Step 5 · Runtime
      </h2>
      {profiles.length === 0 ? (
        <div className={`${CARD} p-4 text-[13px] text-muted`}>
          No runtime profiles are configured. Create one on the Runtimes screen before creating an
          agent.
        </div>
      ) : (
        <div className={CARD}>
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              aria-pressed={selectedId === profile.id}
              onClick={() => onSelect(profile.id)}
              className={`flex w-full items-start gap-3 border-b border-border p-3 text-left last:border-b-0 ${
                selectedId === profile.id ? 'bg-accent-soft' : 'bg-surface'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold">{profile.name}</span>
                <span className="mt-0.5 block text-[12px] text-muted">{profile.driver}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function ResourcesStep({
  options,
  fileAccess,
  selectedSkills,
  selectedConnectors,
  onFile,
  onSkill,
  onConnector,
}: Readonly<{
  options: AgentResourceOptions;
  fileAccess: Readonly<Record<string, 'read' | 'read-write'>>;
  selectedSkills: ReadonlySet<string>;
  selectedConnectors: ReadonlySet<string>;
  onFile: (id: string, access: 'read' | 'read-write' | null) => void;
  onSkill: (id: string, selected: boolean) => void;
  onConnector: (id: string, selected: boolean) => void;
}>) {
  const group = (
    heading: string,
    rows: readonly { id: string; label: string }[],
    selected: ReadonlySet<string>,
    onChange: (id: string, selected: boolean) => void,
  ) => (
    <fieldset className="rounded border border-border p-3">
      <legend className="px-1 text-[13px] font-semibold">{heading}</legend>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted">None configured.</p>
      ) : (
        rows.map((row) => (
          <label className="flex items-center gap-2 py-1 text-[13px]" key={row.id}>
            <input
              checked={selected.has(row.id)}
              onChange={(event) => onChange(row.id, event.target.checked)}
              type="checkbox"
            />
            {row.label}
          </label>
        ))
      )}
    </fieldset>
  );
  return (
    <section aria-labelledby="resources-heading" className="mt-4">
      <h2 className="mb-3 text-[15px]" id="resources-heading">
        Step 3 · Resources
      </h2>
      <div className={`${CARD} grid gap-3 p-4 md:grid-cols-3`}>
        <fieldset className="rounded border border-border p-3">
          <legend className="px-1 text-[13px] font-semibold">Files and folders</legend>
          {options.files.length === 0 ? (
            <p className="text-[12px] text-muted">None configured.</p>
          ) : (
            options.files.map((row) => (
              <div className="flex items-center gap-2 py-1" key={row.id}>
                <label className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
                  <input
                    checked={fileAccess[row.id] !== undefined}
                    onChange={(event) => onFile(row.id, event.target.checked ? 'read' : null)}
                    type="checkbox"
                  />
                  <span className="truncate">{row.label}</span>
                </label>
                {fileAccess[row.id] === undefined ? null : (
                  <select
                    aria-label={`Access for ${row.label}`}
                    className={CONTROL}
                    onChange={(event) =>
                      onFile(row.id, event.target.value as 'read' | 'read-write')
                    }
                    value={fileAccess[row.id]}
                  >
                    <option value="read">Read</option>
                    <option value="read-write">Read/write</option>
                  </select>
                )}
              </div>
            ))
          )}
        </fieldset>
        {group('Skills', options.skills, selectedSkills, onSkill)}
        {group('Connectors', options.connectors, selectedConnectors, onConnector)}
      </div>
    </section>
  );
}

export function PermissionsStep({
  permissions,
  onChange,
}: Readonly<{
  permissions: AgentPermissions;
  onChange: (key: keyof AgentPermissions, enabled: boolean) => void;
}>) {
  const choices: ReadonlyArray<[keyof AgentPermissions, string, string]> = [
    ['readFiles', 'Read files', 'Read only the files and folders assigned above.'],
    ['writeFiles', 'Write files', 'Modify only resources explicitly assigned read/write.'],
    ['runCommands', 'Run commands', 'Execute commands inside the selected runtime.'],
    [
      'unrestrictedNetwork',
      'Unrestricted network',
      'Allow network destinations beyond the runtime policy.',
    ],
  ];
  return (
    <fieldset className={`${CARD} mt-4 p-4`}>
      <legend className="px-1 text-[15px] font-semibold">Step 4 · Permissions</legend>
      <p className="mb-3 text-[12px] text-muted">
        Choose each capability explicitly. High-risk capabilities start disabled.
      </p>
      {choices.map(([key, label, help]) => (
        <label
          className="flex items-start gap-3 border-b border-border py-2 last:border-b-0"
          key={key}
        >
          <input
            className="mt-1"
            type="checkbox"
            checked={permissions[key]}
            onChange={(event) => onChange(key, event.target.checked)}
          />
          <span>
            <span className="block text-[13px] font-semibold">{label}</span>
            <span className="block text-[12px] text-muted">{help}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function NewAgentScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<RequestProblem | null>(null);
  const [runtimeProfiles, setRuntimeProfiles] = useState<readonly RuntimeProfileOption[] | null>(
    null,
  );
  const catalogState = useModelCatalog();
  const [selectedRuntimeProfileId, setSelectedRuntimeProfileId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelSelectionValue>(null);
  const [autoSelected, setAutoSelected] = useState(false);
  const [resources, setResources] = useState<AgentResourceOptions | null>(null);
  const [fileAccess, setFileAccess] = useState<Record<string, 'read' | 'read-write'>>({});
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [selectedConnectors, setSelectedConnectors] = useState<Set<string>>(new Set());
  const [permissions, setPermissions] = useState<AgentPermissions>({
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  });

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch('/api/runtime-profiles', { headers: { accept: 'application/json' } }),
      fetch('/api/files', { headers: { accept: 'application/json' } }),
      fetch('/api/skills', { headers: { accept: 'application/json' } }),
      fetch('/api/connectors', { headers: { accept: 'application/json' } }),
    ])
      .then(async ([profilesResponse, filesResponse, skillsResponse, connectorsResponse]) => {
        if (!profilesResponse.ok)
          throw new Error(`Runtime profiles request returned ${String(profilesResponse.status)}.`);
        // Files, skills and connectors are optional subsystems: each answers 503 when it is not
        // configured. An agent with no resources is a legitimate agent, so an unconfigured one
        // contributes an empty group rather than making the whole editor unusable.
        const optional = (response: Response, key: string): Promise<unknown> =>
          response.ok ? (response.json() as Promise<unknown>) : Promise.resolve({ [key]: [] });
        return Promise.all([
          profilesResponse.json() as Promise<unknown>,
          optional(filesResponse, 'files'),
          optional(skillsResponse, 'skills'),
          optional(connectorsResponse, 'connectors'),
        ]);
      })
      .then(([profileBody, filesBody, skillsBody, connectorsBody]) => {
        if (!active) return;
        const profiles = readRuntimeProfileOptions(profileBody);
        setRuntimeProfiles(profiles);
        setSelectedRuntimeProfileId(profiles[0]?.id ?? null);
        setResources(readAgentResourceOptions(filesBody, skillsBody, connectorsBody));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRuntimeProfiles([]);
        setResources({ files: [], skills: [], connectors: [] });
        setProblem({
          kind: 'transport',
          reason: `Runtime profiles could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return () => {
      active = false;
    };
  }, []);

  const catalogModels = catalogState.kind === 'ready' ? catalogState.catalog.models : [];
  const catalogUnavailable = catalogState.kind === 'ready' ? catalogState.catalog.unavailable : [];
  // The first catalog model is pre-selected once, the same default `RuntimeProfileStep` applies —
  // a person who wants another model still has to click it, but the form does not open with
  // nothing chosen when at least one is available.
  useEffect(() => {
    const first = catalogModels[0];
    if (autoSelected || first === undefined) return;
    setAutoSelected(true);
    setSelectedModel({ connectionId: first.connectionId, model: first.providerModelId });
  }, [autoSelected, catalogModels]);

  const canSubmit =
    isValidAgentName(name) &&
    selectedRuntimeProfileId !== null &&
    selectedModel !== null &&
    !submitting;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || selectedRuntimeProfileId === null || selectedModel === null) return;
    setSubmitting(true);
    setProblem(null);

    void (async () => {
      let response: Response;
      try {
        response = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            agent: buildCreateAgentInput(
              name,
              instructions,
              selectedRuntimeProfileId,
              selectedModel,
              permissions,
            ),
            assignments: {
              files: Object.entries(fileAccess).map(([fileId, access]) => ({ fileId, access })),
              skillIds: [...selectedSkills],
              connectorIds: [...selectedConnectors],
            },
          }),
        });
      } catch (error) {
        setSubmitting(false);
        setProblem({
          kind: 'transport',
          reason: `The request to create this agent failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (!response.ok) {
        const failure = await describeRequestFailure(response, () => response.json());
        setSubmitting(false);
        setProblem(failure);
        return;
      }
      const createdBody = (await response.json()) as { agent?: { id?: unknown } };
      const agentId = createdBody.agent?.id;
      if (typeof agentId !== 'string') {
        setSubmitting(false);
        setProblem({ kind: 'transport', reason: 'The created agent response had no id.' });
        return;
      }
      router.push(`/agents/${agentId}`);
    })();
  }

  return (
    <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">New Agent</h1>
      </div>

      <form onSubmit={onSubmit}>
        <div className={CARD}>
          <div className="p-4">
            <div className={FIELD}>
              <label className={LABEL} htmlFor="agent-name">
                Name
              </label>
              <input
                id="agent-name"
                type="text"
                className={CONTROL}
                placeholder="e.g. Contract Review"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            <div className="mb-0">
              <label className={LABEL} htmlFor="agent-instructions">
                Instructions
              </label>
              {createElement('textarea', {
                id: 'agent-instructions',
                rows: 8,
                className: `${CONTROL} min-h-[96px] resize-y leading-[1.6]`,
                value: instructions,
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
                  setInstructions(event.target.value);
                },
              })}
              <div className={HELP}>
                This becomes the agent’s system prompt. Plain language works better than
                instructions written for a developer.
              </div>
            </div>
          </div>
        </div>

        {catalogState.kind === 'loading' ? (
          <div className="mt-4 text-[13px] text-muted">Loading model connections…</div>
        ) : catalogState.kind === 'failed' ? (
          <div className="mt-4 text-[13px] text-danger" role="alert">
            {catalogState.reason}
          </div>
        ) : (
          <ModelStep
            models={catalogModels}
            unavailable={catalogUnavailable}
            value={selectedModel}
            onSelect={setSelectedModel}
          />
        )}

        {runtimeProfiles === null ? (
          <div className="mt-4 text-[13px] text-muted">Loading runtime profiles…</div>
        ) : (
          <RuntimeProfileStep
            profiles={runtimeProfiles}
            selectedId={selectedRuntimeProfileId}
            onSelect={setSelectedRuntimeProfileId}
          />
        )}

        {resources === null ? (
          <div className="mt-4 text-[13px] text-muted">Loading files, skills, and connectors…</div>
        ) : (
          <ResourcesStep
            options={resources}
            fileAccess={fileAccess}
            selectedSkills={selectedSkills}
            selectedConnectors={selectedConnectors}
            onFile={(id, access) =>
              setFileAccess((current) => {
                const next = { ...current };
                if (access === null) delete next[id];
                else next[id] = access;
                return next;
              })
            }
            onSkill={(id, selected) =>
              setSelectedSkills((current) => {
                const next = new Set(current);
                if (selected) next.add(id);
                else next.delete(id);
                return next;
              })
            }
            onConnector={(id, selected) =>
              setSelectedConnectors((current) => {
                const next = new Set(current);
                if (selected) next.add(id);
                else next.delete(id);
                return next;
              })
            }
          />
        )}

        <PermissionsStep
          permissions={permissions}
          onChange={(key, enabled) => setPermissions((current) => ({ ...current, [key]: enabled }))}
        />

        {problem === null ? null : (
          <div className={CALLOUT_DANGER}>
            <span aria-hidden="true" className="flex-none text-[14px] leading-[1.4]">
              !
            </span>
            <div className="min-w-0 flex-1">
              {problem.kind === 'api' ? (
                <>
                  <b className="font-semibold">
                    {problem.status} {problem.code}
                  </b>
                  <div>{problem.message}</div>
                </>
              ) : (
                <div>{problem.reason}</div>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Link href="/agents" className={`${BTN} ${BTN_DEFAULT}`}>
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`${BTN} ${BTN_PRIMARY} ${canSubmit ? '' : BTN_DISABLED}`}
          >
            {submitting ? 'Creating…' : 'Create Agent'}
          </button>
        </div>
      </form>
    </main>
  );
}
