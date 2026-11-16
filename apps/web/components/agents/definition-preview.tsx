import type { ReactNode } from 'react';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

import {
  BTN,
  BTN_DEFAULT,
  CARD,
  ModelStep,
  PermissionsStep,
  ResourcesStep,
  RuntimeProfileStep,
} from './agent-form';
import { changeInWords } from './builder-approval-words';
import { builderStrings, type BuilderStrings } from './builder-messages';
import { newAgentStrings } from './new-agent-messages';
import type { VersionsLocale } from './versions-messages';
import {
  diffBodies,
  type DefinitionChange,
  type DefinitionSection,
} from '@indx-workspace/sdk/portable';

/** Every section, in display order. The `Record` makes a missing section a type error. */
const SECTION_RANK = {
  instructions: 0,
  description: 1,
  model: 2,
  runtime: 3,
  resources: 4,
  knowledge: 5,
  permissions: 6,
  policy: 7,
  tools: 8,
  subagents: 9,
} as const satisfies Record<DefinitionSection, number>;

const PREVIEW_ORDER = (Object.keys(SECTION_RANK) as DefinitionSection[]).sort(
  (a, b) => SECTION_RANK[a] - SECTION_RANK[b],
);

const IGNORE = () => undefined;

function SectionFrame({
  section,
  changes,
  onAskBuilder,
  strings,
  locale,
  children,
}: Readonly<{
  section: DefinitionSection;
  changes: readonly DefinitionChange[];
  onAskBuilder: (section: DefinitionSection) => void;
  strings: BuilderStrings;
  locale: VersionsLocale;
  children: ReactNode;
}>) {
  const changed = changes.length > 0;
  return (
    <div
      data-section={section}
      data-changed={changed ? 'true' : undefined}
      className={`rounded-(--radius) p-2 ${changed ? 'bg-accent-soft' : ''}`}
    >
      {changed ? (
        <p className="mb-1 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="rounded-(--radius-sm) border border-accent px-1.5 font-semibold">
            {strings.changed}
          </span>
          {/* What changed, in the words the approval card uses. */}
          <span>{changes.map((change) => changeInWords(change, locale).label).join(', ')}</span>
        </p>
      ) : null}
      {children}
      <button
        type="button"
        aria-label={strings.askToChange(strings.sections[section])}
        onClick={() => onAskBuilder(section)}
        className={`${BTN} ${BTN_DEFAULT} mt-2`}
      >
        {strings.askToChangeThis}
      </button>
    </div>
  );
}

function TextSection({ title, text }: Readonly<{ title: string; text: string }>) {
  return (
    <section className="mt-4" aria-label={title}>
      <h2 className="mb-3 text-[15px]">{title}</h2>
      <div className={`${CARD} p-4 text-[13px] whitespace-pre-wrap`}>{text}</div>
    </section>
  );
}

/**
 * The definition the Builder is writing, in the form's own sections in read mode. `previous` is
 * the body the person last saw: what differs from it is highlighted with a background and the word
 * "changed", so the meaning never rests on colour alone.
 */
export function DefinitionPreview({
  body,
  previous,
  onAskBuilder,
  locale = 'en',
}: Readonly<{
  body: AgentVersionBody;
  previous: AgentVersionBody | null;
  onAskBuilder: (section: DefinitionSection) => void;
  /** The reader's language (UX-15 in #2086); English when absent. */
  locale?: VersionsLocale;
}>) {
  const strings = builderStrings(locale);
  const steps = newAgentStrings(locale);
  const titles = strings.sections;
  const none = strings.change.none;
  const { agent, resources, policy } = body.definition;
  const changes = diffBodies(previous, body);
  const rows = (names: readonly string[]) => names.map((name) => ({ id: name, label: name }));
  const sections: Readonly<Record<DefinitionSection, ReactNode>> = {
    instructions: <TextSection title={titles.instructions} text={agent.instructions || none} />,
    model: (
      <ModelStep
        models={[]}
        unavailable={[]}
        value={
          agent.model === null && agent.modelConnectionName === null
            ? null
            : { connectionId: agent.modelConnectionName ?? '', model: agent.model ?? '' }
        }
        onSelect={IGNORE}
        readOnly
        words={steps}
        title={titles.model}
      />
    ),
    runtime: (
      <RuntimeProfileStep
        // No name means the workspace's default profile, not none (the contract's own words).
        profiles={[
          {
            id: agent.runtimeProfileName ?? '',
            name: agent.runtimeProfileName ?? strings.change.workspaceDefault,
            driver: '',
          },
        ]}
        selectedId={agent.runtimeProfileName ?? ''}
        onSelect={IGNORE}
        readOnly
        words={steps}
        title={titles.runtime}
      />
    ),
    resources: (
      <ResourcesStep
        options={{
          files: rows(resources.files.map((file) => file.path)),
          skills: rows(resources.skills),
          connectors: rows(resources.connectors),
        }}
        fileAccess={Object.fromEntries(resources.files.map((file) => [file.path, file.access]))}
        selectedSkills={new Set(resources.skills)}
        selectedConnectors={new Set(resources.connectors)}
        onFile={IGNORE}
        onSkill={IGNORE}
        onConnector={IGNORE}
        readOnly
        words={steps}
        title={titles.resources}
      />
    ),
    permissions: (
      <PermissionsStep
        permissions={agent.permissions}
        onChange={IGNORE}
        readOnly
        words={steps}
        title={titles.permissions}
      />
    ),
    tools: (
      <TextSection
        title={titles.tools}
        text={
          body.toolBundles === undefined || body.toolBundles.length === 0
            ? strings.noCodeTools
            : body.toolBundles.map((bundle) => bundle.tool).join(', ')
        }
      />
    ),
    policy: (
      <TextSection
        title={titles.policy}
        text={
          'tools' in policy
            ? [
                strings.permissionMode(policy.tools.permissionMode),
                strings.skipChecks(policy.tools.allowDangerouslySkipPermissions),
                strings.autoApproved(policy.tools.autoApprove.join(', ') || none),
                strings.denied(policy.tools.deny.join(', ') || none),
                strings.toolSet(
                  policy.tools.base === 'claude_code_preset'
                    ? strings.change.claudeCodePreset
                    : policy.tools.base.join(', ') || none,
                ),
              ].join('\n')
            : strings.noToolRules
        }
      />
    ),
    subagents: (
      <TextSection
        title={titles.subagents}
        text={(body.subagents ?? []).map(({ name }) => name).join(', ') || none}
      />
    ),
    knowledge: (
      <TextSection
        title={titles.knowledge}
        text={
          (body.knowledge ?? [])
            .map((source) => (source.kind === 'files' ? source.paths.join(', ') : source.name))
            .join('\n') || none
        }
      />
    ),
    description: <TextSection title={titles.description} text={body.description ?? none} />,
  };
  return (
    <div>
      {PREVIEW_ORDER.map((section) => (
        <SectionFrame
          key={section}
          section={section}
          changes={changes.filter((change) => change.section === section)}
          onAskBuilder={onAskBuilder}
          strings={strings}
          locale={locale}
        >
          {sections[section]}
        </SectionFrame>
      ))}
    </div>
  );
}
