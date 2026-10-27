import type { ReactNode } from 'react';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

import {
  BTN,
  BTN_DEFAULT,
  CARD,
  ModelStep,
  PERMISSION_CHOICES,
  PermissionsStep,
  ResourcesStep,
  RuntimeProfileStep,
} from './agent-form';
import {
  diffBodies,
  type DefinitionChange,
  type DefinitionSection,
} from '@indx-workspace/sdk/portable';

const SECTION_TITLES: Readonly<Record<DefinitionSection, string>> = {
  instructions: 'Instructions',
  model: 'Model',
  runtime: 'Runtime',
  resources: 'Resources',
  permissions: 'Permissions',
  tools: 'Tools',
  policy: 'Tool policy',
  subagents: 'Subagents',
  knowledge: 'Knowledge',
  description: 'Description',
};

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

function changeLabel(change: DefinitionChange): string {
  const key = change.path.slice(change.path.lastIndexOf('.') + 1);
  const choice = PERMISSION_CHOICES.find(([permission]) => permission === key);
  return change.section === 'permissions' && choice !== undefined
    ? choice[1]
    : change.path.replace(/^definition\./u, '');
}

function SectionFrame({
  section,
  changes,
  onAskBuilder,
  children,
}: Readonly<{
  section: DefinitionSection;
  changes: readonly DefinitionChange[];
  onAskBuilder: (section: DefinitionSection) => void;
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
            changed
          </span>
          <span>{changes.map(changeLabel).join(', ')}</span>
        </p>
      ) : null}
      {children}
      <button
        type="button"
        aria-label={`Ask the Builder to change ${SECTION_TITLES[section]}`}
        onClick={() => onAskBuilder(section)}
        className={`${BTN} ${BTN_DEFAULT} mt-2`}
      >
        Ask the Builder to change this
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
}: Readonly<{
  body: AgentVersionBody;
  previous: AgentVersionBody | null;
  onAskBuilder: (section: DefinitionSection) => void;
}>) {
  const { agent, resources, policy } = body.definition;
  const changes = diffBodies(previous, body);
  const rows = (names: readonly string[]) => names.map((name) => ({ id: name, label: name }));
  const sections: Readonly<Record<DefinitionSection, ReactNode>> = {
    instructions: <TextSection title="Instructions" text={agent.instructions || 'None'} />,
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
      />
    ),
    runtime: (
      <RuntimeProfileStep
        profiles={
          agent.runtimeProfileName === null
            ? []
            : [{ id: agent.runtimeProfileName, name: agent.runtimeProfileName, driver: '' }]
        }
        selectedId={agent.runtimeProfileName}
        onSelect={IGNORE}
        readOnly
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
      />
    ),
    permissions: <PermissionsStep permissions={agent.permissions} onChange={IGNORE} readOnly />,
    tools: (
      <TextSection
        title="Tools"
        text={
          body.toolBundles === undefined || body.toolBundles.length === 0
            ? 'No code tools'
            : body.toolBundles.map((bundle) => bundle.tool).join(', ')
        }
      />
    ),
    policy: (
      <TextSection
        title="Tool policy"
        text={
          'tools' in policy
            ? [
                `Permission mode: ${policy.tools.permissionMode}`,
                `Skip permission checks: ${policy.tools.allowDangerouslySkipPermissions ? 'Yes' : 'No'}`,
                `Auto-approved: ${policy.tools.autoApprove.join(', ') || 'None'}`,
                `Denied: ${policy.tools.deny.join(', ') || 'None'}`,
                `Tool set: ${policy.tools.base === 'claude_code_preset' ? 'Claude Code preset' : policy.tools.base.join(', ') || 'None'}`,
              ].join('\n')
            : 'No tool rules'
        }
      />
    ),
    subagents: (
      <TextSection
        title="Subagents"
        text={(body.subagents ?? []).map(({ name }) => name).join(', ') || 'None'}
      />
    ),
    knowledge: (
      <TextSection
        title="Knowledge"
        text={
          (body.knowledge ?? [])
            .map((source) => (source.kind === 'files' ? source.paths.join(', ') : source.name))
            .join('\n') || 'None'
        }
      />
    ),
    description: <TextSection title="Description" text={body.description ?? 'None'} />,
  };
  return (
    <div>
      {PREVIEW_ORDER.map((section) => (
        <SectionFrame
          key={section}
          section={section}
          changes={changes.filter((change) => change.section === section)}
          onAskBuilder={onAskBuilder}
        >
          {sections[section]}
        </SectionFrame>
      ))}
    </div>
  );
}
