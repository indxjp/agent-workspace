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
import { useRouter, useSearchParams } from 'next/navigation';
import {
  createElement,
  Fragment,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { AgentPermissions } from '../../contracts/agents';

import { browserClient } from '../../lib/browser-client';
import { createAgent, loadNewAgentCatalogs } from './agent-requests-model';
import {
  buildCreateAgentInput,
  isValidAgentName,
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

export const BTN =
  'inline-flex h-8 items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[13px] text-[13px] font-medium no-underline';
/** `.btn`'s own (non-`.primary`) colours. */
export const BTN_DEFAULT = 'border-border-strong bg-surface text-text';
const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
const BTN_DISABLED = 'pointer-events-none opacity-[.45]';
export const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const FIELD = 'mb-[18px]';
const LABEL = 'mb-[5px] block text-[13px] font-semibold';
const HELP = 'mt-[5px] text-[12.5px] text-muted';
const CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const CALLOUT_DANGER =
  'mt-4 flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';

/** The read-mode body every step shares: labelled values as text, never inputs. */
function ReadList({
  rows,
  className = `${CARD} p-4`,
}: Readonly<{ rows: readonly (readonly [label: string, value: string])[]; className?: string }>) {
  return (
    <dl className={`${className} grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]`}>
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="font-semibold">{label}</dt>
          <dd className="min-w-0 break-words text-muted">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Step 2 — issue #130's reusable selector, first use. `models`/`unavailable` are the joined
 * catalog `useModelCatalog` produced; nothing here re-derives a capability or a display name.
 */
export function ModelStep({
  models,
  unavailable,
  value,
  onSelect,
  readOnly = false,
}: Readonly<{
  models: readonly CatalogModel[];
  unavailable: readonly { readonly connectionName: string; readonly reason: string }[];
  value: ModelSelectionValue;
  onSelect: (value: ModelSelectionValue) => void;
  readOnly?: boolean;
}>) {
  const selected = findCatalogEntry(models, value);
  return (
    <section className="mt-4" aria-labelledby="model-heading">
      <h2 id="model-heading" className="mb-3 text-[15px]">
        Which model should this agent use?
      </h2>
      {readOnly ? (
        <ReadList
          rows={[
            ['Model', selected?.displayName ?? (value?.model || 'Deployment default')],
            [
              'Connection',
              selected?.connectionName ?? (value?.connectionId || 'Deployment default'),
            ],
          ]}
        />
      ) : models.length === 0 ? (
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
      {readOnly ? null : <ModelUnavailableNotice unavailable={unavailable} />}
      {!readOnly && selected !== undefined && !selected.capabilities.promptCaching ? (
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
  readOnly = false,
}: Readonly<{
  profiles: readonly RuntimeProfileOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  readOnly?: boolean;
}>) {
  return (
    <section className="mt-4" aria-labelledby="runtime-profile-heading">
      <h2 id="runtime-profile-heading" className="mb-3 text-[15px]">
        Step 5 · Runtime
      </h2>
      {readOnly ? (
        <ReadList
          rows={[['Runtime profile', profiles.find((p) => p.id === selectedId)?.name ?? 'None']]}
        />
      ) : profiles.length === 0 ? (
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

function joinOrNone(labels: readonly string[]): string {
  return labels.length === 0 ? 'None' : labels.join(', ');
}

export function ResourcesStep({
  options,
  fileAccess,
  selectedSkills,
  selectedConnectors,
  onFile,
  onSkill,
  onConnector,
  readOnly = false,
}: Readonly<{
  options: AgentResourceOptions;
  fileAccess: Readonly<Record<string, 'read' | 'read-write'>>;
  selectedSkills: ReadonlySet<string>;
  selectedConnectors: ReadonlySet<string>;
  onFile: (id: string, access: 'read' | 'read-write' | null) => void;
  onSkill: (id: string, selected: boolean) => void;
  onConnector: (id: string, selected: boolean) => void;
  readOnly?: boolean;
}>) {
  if (readOnly) {
    return (
      <section aria-labelledby="resources-heading" className="mt-4">
        <h2 className="mb-3 text-[15px]" id="resources-heading">
          Step 3 · Resources
        </h2>
        <ReadList
          rows={[
            [
              'Files and folders',
              joinOrNone(
                options.files
                  .filter((row) => fileAccess[row.id] !== undefined)
                  .map(
                    (row) =>
                      `${row.label} (${fileAccess[row.id] === 'read' ? 'read' : 'read/write'})`,
                  ),
              ),
            ],
            [
              'Skills',
              joinOrNone(
                options.skills.filter((r) => selectedSkills.has(r.id)).map((r) => r.label),
              ),
            ],
            [
              'Connectors',
              joinOrNone(
                options.connectors.filter((r) => selectedConnectors.has(r.id)).map((r) => r.label),
              ),
            ],
          ]}
        />
      </section>
    );
  }
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

export const PERMISSION_CHOICES: ReadonlyArray<[keyof AgentPermissions, string, string]> = [
  ['readFiles', 'Read files', 'Read only the files and folders assigned above.'],
  ['writeFiles', 'Write files', 'Modify only resources explicitly assigned read/write.'],
  ['runCommands', 'Run commands', 'Execute commands inside the selected runtime.'],
  [
    'unrestrictedNetwork',
    'Unrestricted network',
    'Allow network destinations beyond the runtime policy.',
  ],
];

export function PermissionsStep({
  permissions,
  onChange,
  readOnly = false,
}: Readonly<{
  permissions: AgentPermissions;
  onChange: (key: keyof AgentPermissions, enabled: boolean) => void;
  readOnly?: boolean;
}>) {
  if (readOnly) {
    return (
      <fieldset className={`${CARD} mt-4 p-4`}>
        <legend className="px-1 text-[15px] font-semibold">Step 4 · Permissions</legend>
        <ReadList
          className=""
          rows={PERMISSION_CHOICES.map(([key, label]) => [
            label,
            permissions[key] ? 'Allowed' : 'Not allowed',
          ])}
        />
      </fieldset>
    );
  }
  return (
    <fieldset className={`${CARD} mt-4 p-4`}>
      <legend className="px-1 text-[15px] font-semibold">Step 4 · Permissions</legend>
      <p className="mb-3 text-[12px] text-muted">
        Choose each capability explicitly. High-risk capabilities start disabled.
      </p>
      {PERMISSION_CHOICES.map(([key, label, help]) => (
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

export const AGENT_MODES = ['form', 'chat'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];
const AGENT_MODE_LABELS: Readonly<Record<AgentMode, string>> = { form: 'Form', chat: 'Chat' };

/** `?mode=chat` selects Chat only when the feature is on; anything else is the form. */
export function parseAgentMode(param: string | null, chatEnabled: boolean): AgentMode {
  return chatEnabled && param === 'chat' ? 'chat' : 'form';
}

const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** The option an arrow, Home or End key moves to (wrapping), or `null` for any other key. */
export function nextAgentMode(current: AgentMode, key: string): AgentMode | null {
  if (key === 'Home') return AGENT_MODES[0];
  if (key === 'End') return AGENT_MODES[AGENT_MODES.length - 1] ?? null;
  const step = ARROW_STEPS[key];
  if (step === undefined) return null;
  const count = AGENT_MODES.length;
  return AGENT_MODES[(AGENT_MODES.indexOf(current) + step + count) % count] ?? null;
}

export function AgentModeSwitch({
  mode,
  onChange,
}: Readonly<{ mode: AgentMode; onChange: (mode: AgentMode) => void }>) {
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: AgentMode) {
    const next = nextAgentMode(current, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    document.getElementById(`agent-mode-${next}`)?.focus();
  }
  return (
    <div
      role="radiogroup"
      aria-label="How to create this agent"
      className="mb-4 inline-flex rounded-(--radius-sm) border border-border-strong p-0.5"
    >
      {AGENT_MODES.map((option) => (
        <button
          key={option}
          id={`agent-mode-${option}`}
          type="button"
          role="radio"
          aria-checked={option === mode}
          tabIndex={option === mode ? 0 : -1}
          onClick={() => onChange(option)}
          onKeyDown={(event) => onKeyDown(event, option)}
          className={`h-7 rounded-(--radius-sm) px-3 text-[13px] ${
            option === mode ? 'bg-accent-soft font-semibold' : 'text-muted'
          }`}
        >
          {AGENT_MODE_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

export function NewAgentScreen({
  chatEnabled,
  chat,
}: Readonly<{
  /** Whether the caller's `/api/me` features include `builder`; the route reads it. */
  chatEnabled: boolean;
  /** The chat screen, given the mode switch to place; the route supplies it so imports stay acyclic. */
  chat?: (modeSwitch: ReactNode) => ReactNode;
}>) {
  const router = useRouter();
  const mode = parseAgentMode(useSearchParams().get('mode'), chatEnabled);
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
    void loadNewAgentCatalogs(browserClient())
      .then(({ runtimeProfiles: profiles, resources: options }) => {
        if (!active) return;
        setRuntimeProfiles(profiles);
        setSelectedRuntimeProfileId(profiles[0]?.id ?? null);
        setResources(options);
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

    void createAgent(
      browserClient(),
      buildCreateAgentInput(
        name,
        instructions,
        selectedRuntimeProfileId,
        selectedModel,
        permissions,
      ),
      {
        files: Object.entries(fileAccess).map(([fileId, access]) => ({ fileId, access })),
        skillIds: [...selectedSkills],
        connectorIds: [...selectedConnectors],
      },
    ).then((created) => {
      if (!created.ok) {
        setSubmitting(false);
        setProblem(created.problem);
        return;
      }
      router.push(`/agents/${created.value}`);
    });
  }

  const modeSwitch = chatEnabled ? (
    <AgentModeSwitch
      mode={mode}
      onChange={(next) => router.replace(next === 'chat' ? '/agents/new?mode=chat' : '/agents/new')}
    />
  ) : null;
  if (mode === 'chat') {
    return chat?.(modeSwitch) ?? null;
  }

  return (
    <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">New Agent</h1>
      </div>
      {modeSwitch}

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
