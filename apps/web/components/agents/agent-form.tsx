'use client';

/** The new-agent form and its form/chat mode entry point. */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createElement, type ChangeEvent, type ReactNode } from 'react';
import { ModelStep, PermissionsStep, RuntimeProfileStep } from './agent-form-steps';
import {
  BTN,
  BTN_DEFAULT,
  BTN_DISABLED,
  BTN_PRIMARY,
  CARD,
  CONTROL,
  FIELD,
  HELP,
  LABEL,
} from './agent-form-styles';
import { AgentModeSwitch, parseAgentMode } from './agent-mode-switch';
import { ResourcesStep } from './agent-resources-step';
import { useNewAgentForm } from './use-new-agent-form';
import { newAgentStrings, type NewAgentStrings } from './new-agent-messages';
import { AgentFormProblem } from './agent-form-problem';
import { ProblemLine } from './problem-line';
import type { VersionsLocale } from './versions-messages';

export function NewAgentScreen({
  chatEnabled,
  chat,
  locale = 'en',
}: Readonly<{
  /** Whether the caller's `/api/me` features include `builder`; the route reads it. */
  chatEnabled: boolean;
  /** The chat screen, given the mode switch to place; the route supplies it so imports stay acyclic. */
  chat?: (modeSwitch: ReactNode) => ReactNode;
  /** The reader's language (UX-15 in #2086); the route negotiates it from `Accept-Language`. */
  locale?: VersionsLocale;
}>) {
  const router = useRouter();
  const mode = parseAgentMode(useSearchParams().get('mode'), chatEnabled);
  const strings = newAgentStrings(locale);
  const form = useNewAgentForm(router, strings);

  const modeSwitch = chatEnabled ? (
    <AgentModeSwitch
      mode={mode}
      words={{
        label: strings.modeLabel,
        modes: { form: strings.modeForm, chat: strings.modeChat },
      }}
      onChange={(next) => router.replace(next === 'chat' ? '/agents/new?mode=chat' : '/agents/new')}
    />
  ) : null;
  if (mode === 'chat') {
    return chat?.(modeSwitch) ?? null;
  }

  return (
    <main lang={locale} className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">{strings.heading}</h1>
      </div>
      {modeSwitch}

      <AgentDefinitionForm form={form} strings={strings} locale={locale} />
    </main>
  );
}

export {
  ModelStep,
  PERMISSION_CHOICES,
  permissionChoices,
  PermissionsStep,
  RuntimeProfileStep,
} from './agent-form-steps';
export { BTN, BTN_DEFAULT, CARD } from './agent-form-styles';
export { AGENT_MODES, AgentModeSwitch, nextAgentMode, parseAgentMode } from './agent-mode-switch';
export type { AgentMode } from './agent-mode-switch';
export { ResourcesStep } from './agent-resources-step';

type NewAgentForm = ReturnType<typeof useNewAgentForm>;
function AgentDefinitionForm({
  form,
  strings,
  locale,
}: {
  readonly form: NewAgentForm;
  readonly strings: NewAgentStrings;
  readonly locale: VersionsLocale;
}) {
  const { onSubmit, problem, canSubmit, submitting } = form;
  return (
    <form onSubmit={onSubmit}>
      <NameInstructionsStep form={form} strings={strings} />

      <AgentCatalogSteps form={form} strings={strings} locale={locale} />

      <AgentResourceSteps form={form} strings={strings} />

      <AgentFormProblem problem={problem} strings={strings} locale={locale} />

      <div className="mt-4 flex items-center justify-end gap-2">
        <Link href="/agents" className={`${BTN} ${BTN_DEFAULT}`}>
          {strings.cancel}
        </Link>
        <button
          type="submit"
          disabled={!canSubmit}
          className={`${BTN} ${BTN_PRIMARY} ${canSubmit ? '' : BTN_DISABLED}`}
        >
          {submitting ? strings.creating : strings.create}
        </button>
      </div>
    </form>
  );
}
function NameInstructionsStep({
  form,
  strings,
}: {
  readonly form: Pick<NewAgentForm, 'name' | 'setName' | 'instructions' | 'setInstructions'>;
  readonly strings: NewAgentStrings;
}) {
  const { name, setName, instructions, setInstructions } = form;
  return (
    <>
      {' '}
      <h2 className="mb-3 text-[15px]">{strings.step1}</h2>
      <div className={CARD}>
        <div className="p-4">
          <div className={FIELD}>
            <label className={LABEL} htmlFor="agent-name">
              {strings.name}
            </label>
            <input
              id="agent-name"
              type="text"
              className={CONTROL}
              placeholder={strings.namePlaceholder}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <div className="mb-0">
            <label className={LABEL} htmlFor="agent-instructions">
              {strings.instructions}
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
            <div className={HELP}>{strings.instructionsHelp}</div>
          </div>
        </div>
      </div>
    </>
  );
}
function AgentCatalogSteps({
  form,
  strings,
  locale,
}: {
  readonly strings: NewAgentStrings;
  readonly locale: VersionsLocale;
  readonly form: Pick<
    NewAgentForm,
    | 'catalogState'
    | 'catalogModels'
    | 'catalogUnavailable'
    | 'selectedModel'
    | 'setSelectedModel'
    | 'runtimeProfiles'
    | 'selectedRuntimeProfileId'
    | 'setSelectedRuntimeProfileId'
  >;
}) {
  const {
    catalogState,
    catalogModels,
    catalogUnavailable,
    selectedModel,
    setSelectedModel,
    runtimeProfiles,
    selectedRuntimeProfileId,
    setSelectedRuntimeProfileId,
  } = form;
  return (
    <>
      {' '}
      {catalogState.kind === 'loading' ? (
        <div className="mt-4 text-[13px] text-muted">{strings.loadingModels}</div>
      ) : catalogState.kind === 'failed' ? (
        <div className="mt-4 text-[13px] text-danger" role="alert">
          <ProblemLine
            locale={locale}
            english={catalogState.reason}
            lead={strings.modelsFailed}
            detail={catalogState.detail}
          />
        </div>
      ) : (
        <ModelStep
          models={catalogModels}
          unavailable={catalogUnavailable}
          value={selectedModel}
          onSelect={setSelectedModel}
          words={strings}
        />
      )}
      {runtimeProfiles === null ? (
        <div className="mt-4 text-[13px] text-muted">{strings.loadingRuntimes}</div>
      ) : (
        <RuntimeProfileStep
          profiles={runtimeProfiles}
          selectedId={selectedRuntimeProfileId}
          onSelect={setSelectedRuntimeProfileId}
          words={strings}
        />
      )}
    </>
  );
}
function AgentResourceSteps({
  form,
  strings,
}: {
  readonly strings: NewAgentStrings;
  readonly form: Pick<
    NewAgentForm,
    | 'resources'
    | 'fileAccess'
    | 'setFileAccess'
    | 'selectedSkills'
    | 'setSelectedSkills'
    | 'selectedConnectors'
    | 'setSelectedConnectors'
    | 'permissions'
    | 'setPermissions'
  >;
}) {
  const {
    resources,
    fileAccess,
    setFileAccess,
    selectedSkills,
    setSelectedSkills,
    selectedConnectors,
    setSelectedConnectors,
    permissions,
    setPermissions,
  } = form;
  return (
    <>
      {' '}
      {resources === null ? (
        <div className="mt-4 text-[13px] text-muted">{strings.loadingResources}</div>
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
            setSelectedSkills((current) => withSelection(current, id, selected))
          }
          onConnector={(id, selected) =>
            setSelectedConnectors((current) => withSelection(current, id, selected))
          }
          words={strings}
        />
      )}
      <PermissionsStep
        permissions={permissions}
        onChange={(key, enabled) => setPermissions((current) => ({ ...current, [key]: enabled }))}
        words={strings}
      />
    </>
  );
}
function withSelection(current: ReadonlySet<string>, id: string, selected: boolean): Set<string> {
  const next = new Set(current);
  if (selected) next.add(id);
  else next.delete(id);
  return next;
}
