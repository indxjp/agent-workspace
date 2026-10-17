/**
 * Issue #393, at the composer: which agent a first message runs as, what the screen says it will
 * run on before it is sent, which models it offers, and where a failed run's reason appears.
 *
 * Rendered to a string with `react-dom/server`, as the rest of this application's screens are
 * tested (`../run/run-view.test.ts` explains why there is no DOM library here). The `data-testid`s
 * asserted are the stable hooks the generated-project E2E reads.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  beginRun,
  userMessage,
  withFailure,
  failureNoticeFrom,
} from '@indx-workspace/react/run-model';
import type { CatalogModel } from '../models/catalog';
import { isAgentCapableModel, modelsDrivableBy } from '../models/engine-models';
import { HomeChat } from './home-chat';
import {
  initialSession,
  lastAgentStorageKey,
  projectStartRefusal,
  preferredAgent,
  runTargetIn,
  runTargetLine,
  runTargetWarns,
  type ComposerAgent,
  type ComposerRunTarget,
} from './model';

const USER = { initials: 'A', name: 'alex@example.com' };

function agent(id: string, name: string, runTarget: ComposerRunTarget): ComposerAgent {
  return {
    id,
    name,
    detail: '',
    files: [],
    connectors: [],
    sandbox: 'Standard Sandbox · read-only',
    runTarget,
    drivableProviders: ['anthropic', 'anthropic-compatible'],
  };
}

/** Oldest first, as the store lists them: the seeded General, then the wizard's agent. */
const GENERAL_INHERITING = agent('general', 'General', {
  kind: 'runnable',
  source: 'workspace',
  connectionName: 'openai default',
  model: 'gpt-5.1',
});
const GENERAL_UNRUNNABLE = agent('general', 'General', {
  kind: 'unrunnable',
  code: 'agent_runtime_profile_missing',
  reason: 'agent "General" has no runtime profile.',
});
const WIZARD = agent('wizard', 'Assistant', {
  kind: 'runnable',
  source: 'agent',
  connectionName: 'anthropic default',
  model: 'claude-sonnet-4-5',
});

describe('preferredAgent (issue #393)', () => {
  it('prefers the agent with its own model over the oldest agent that inherits the default', () => {
    expect(preferredAgent([GENERAL_INHERITING, WIZARD], null)?.id).toBe('wizard');
    expect(initialSession([GENERAL_INHERITING, WIZARD])?.agentId).toBe('wizard');
  });

  it('skips an agent that cannot run', () => {
    const inheriting = { ...WIZARD, runTarget: GENERAL_INHERITING.runTarget };
    expect(preferredAgent([GENERAL_UNRUNNABLE, inheriting], null)?.id).toBe('wizard');
  });

  it('honours the remembered agent while it can run, and not once it cannot', () => {
    expect(preferredAgent([GENERAL_INHERITING, WIZARD], 'general')?.id).toBe('general');
    expect(preferredAgent([GENERAL_UNRUNNABLE, WIZARD], 'general')?.id).toBe('wizard');
  });

  it('still opens on an agent when none can run, so the screen can say why', () => {
    expect(preferredAgent([GENERAL_UNRUNNABLE], null)?.id).toBe('general');
    expect(preferredAgent([], null)).toBeNull();
  });
});

describe('preferredAgent and the setup agent (PR #403 review)', () => {
  const SECOND_OWN = agent('second', 'Researcher', {
    kind: 'runnable',
    source: 'agent',
    connectionName: 'Team',
    model: 'claude-opus-4-1',
  });

  it('prefers the agent setup recorded over an older agent with its own model', () => {
    expect(preferredAgent([SECOND_OWN, WIZARD], null, 'wizard')?.id).toBe('wizard');
    expect(initialSession([SECOND_OWN, WIZARD], null, 'wizard')?.agentId).toBe('wizard');
  });

  it('still lets the remembered agent win, and skips a setup agent that cannot run', () => {
    expect(preferredAgent([SECOND_OWN, WIZARD], 'second', 'wizard')?.id).toBe('second');
    const wizardBroken = { ...WIZARD, runTarget: GENERAL_UNRUNNABLE.runTarget };
    expect(preferredAgent([wizardBroken, SECOND_OWN], null, 'wizard')?.id).toBe('second');
    // A recorded id no listed agent carries (a deleted agent) changes nothing.
    expect(preferredAgent([GENERAL_INHERITING, WIZARD], null, 'deleted')?.id).toBe('wizard');
  });
});

describe('projectStartRefusal (PR #403 review)', () => {
  const noModelInProject = {
    ...WIZARD,
    runTargetByProject: {
      'project-1': {
        kind: 'unrunnable',
        code: 'model_connection_unresolved',
        reason: 'the project model connection is not ready.',
      },
    },
  } satisfies ComposerAgent;

  it('refuses a project start the run target already says cannot run, before any session', () => {
    expect(projectStartRefusal(noModelInProject, 'project-1', false)).toEqual({
      code: 'model_connection_unresolved',
      reason: 'the project model connection is not ready.',
    });
    expect(projectStartRefusal(GENERAL_UNRUNNABLE, 'project-2', true)).toMatchObject({
      code: 'agent_runtime_profile_missing',
    });
  });

  it('lets a runnable target, a model override, or no project through', () => {
    expect(projectStartRefusal(noModelInProject, 'project-2', false)).toBeNull();
    expect(projectStartRefusal(noModelInProject, 'project-1', true)).toBeNull();
    expect(projectStartRefusal(GENERAL_UNRUNNABLE, null, false)).toBeNull();
  });
});

describe('lastAgentStorageKey (PR #403 review)', () => {
  it('is scoped to the workspace and the user id, and carries no email address', () => {
    const key = lastAgentStorageKey('ws-1', 'user-1');
    expect(key).toBe('agent-workspace.composer.last-agent:ws-1:user-1');
    expect(lastAgentStorageKey('ws-2', 'user-1')).not.toBe(key);
    expect(key).not.toContain('@');
  });
});

describe('runTargetLine with a selected project (PR #403 review)', () => {
  const inProject = {
    ...GENERAL_INHERITING,
    runTargetByProject: {
      'project-1': {
        kind: 'runnable',
        source: 'project',
        connectionName: 'Team',
        model: 'claude-opus-4-1',
      },
    },
  } satisfies ComposerAgent;

  it('names the project default between the agent and the workspace default', () => {
    expect(runTargetLine(inProject, null, 'project-1')).toBe(
      'Runs as General on claude-opus-4-1 (Team, the project default).',
    );
    expect(runTargetLine(inProject, null, null)).toBe(
      'Runs as General on gpt-5.1 (openai default, the workspace default).',
    );
    // A project with no default of its own changes nothing.
    expect(runTargetIn(inProject, 'project-2')).toBe(inProject.runTarget);
  });
});

describe('runTargetLine', () => {
  it('names the agent, the model and where the model comes from', () => {
    expect(runTargetLine(WIZARD, null)).toBe(
      'Runs as Assistant on claude-sonnet-4-5 (anthropic default, the agent’s model).',
    );
    expect(runTargetLine(GENERAL_INHERITING, null)).toBe(
      'Runs as General on gpt-5.1 (openai default, the workspace default).',
    );
    expect(runTargetLine(WIZARD, { connectionName: 'Team', model: 'Claude Opus' })).toBe(
      'Runs as Assistant on Claude Opus (Team, this message only).',
    );
    expect(runTargetLine(GENERAL_UNRUNNABLE, null)).toContain('cannot run yet');
  });

  // Issue #506: an agent naming a connection but no model runs on the deployment default.
  it('names the deployment default when it supplies the model', () => {
    const scaffolded = agent('scaffolded', 'Scaffolded', {
      kind: 'runnable',
      source: 'deployment',
      connectionName: 'default',
      model: 'claude-sonnet-4-5',
    });
    expect(runTargetLine(scaffolded, null)).toBe(
      'Runs as Scaffolded on claude-sonnet-4-5 or its newest dated release (default, the deployment default).',
    );
    expect(runTargetWarns(scaffolded.runTarget, false)).toBe(false);
  });

  it('warns while the agent cannot run and no override can fix it', () => {
    expect(runTargetWarns(GENERAL_UNRUNNABLE.runTarget, true)).toBe(true);
    expect(runTargetWarns(GENERAL_UNRUNNABLE.runTarget, false)).toBe(true);
    const noModel: ComposerRunTarget = {
      kind: 'unrunnable',
      code: 'model_connection_unresolved',
      reason: 'no workspace default.',
    };
    expect(runTargetWarns(noModel, true)).toBe(false);
    expect(runTargetWarns(WIZARD.runTarget, false)).toBe(false);
  });

  // #403 follow-up: a model override cannot give an agent a runtime profile.
  it('keeps the missing-profile reason when a model override is chosen', () => {
    expect(
      runTargetLine(GENERAL_UNRUNNABLE, { connectionName: 'Team', model: 'Claude Opus' }),
    ).toBe('General cannot run yet — agent "General" has no runtime profile.');
    const noModel = agent('m', 'NoModel', {
      kind: 'unrunnable',
      code: 'model_connection_unresolved',
      reason: 'no workspace default is configured.',
    });
    expect(runTargetLine(noModel, { connectionName: 'Team', model: 'Claude Opus' })).toBe(
      'Runs as NoModel on Claude Opus (Team, this message only).',
    );
  });
});

describe('the composer before a message is sent', () => {
  it('opens on the runnable agent and shows which agent and model will be used', () => {
    const html = renderToStaticMarkup(
      <HomeChat
        agents={{ kind: 'agents', agents: [GENERAL_INHERITING, WIZARD] }}
        recent={[]}
        user={USER}
      />,
    );
    expect(html).toContain('Agent: Assistant');
    expect(html).toMatch(/data-testid="composer-run-target"[^>]*data-agent-id="wizard"/u);
    expect(html).toContain('Runs as Assistant on claude-sonnet-4-5');
    expect(html).toContain('data-testid="composer-send"');
    expect(html).toContain('data-testid="composer-agent-picker"');
  });

  it('says why an agent cannot run instead of letting a send fail silently', () => {
    const html = renderToStaticMarkup(
      <HomeChat
        agents={{ kind: 'agents', agents: [GENERAL_UNRUNNABLE] }}
        recent={[]}
        user={USER}
      />,
    );
    expect(html).toMatch(/data-testid="composer-run-target"[^>]*data-run-target="unrunnable"/u);
    expect(html).toContain('General cannot run yet');
    expect(html).toContain('Cannot run yet · agent_runtime_profile_missing');
  });
});

describe('the run view after a failed start', () => {
  it('shows the typed reason in the conversation, not only in the Runtime tab', () => {
    const run = withFailure(
      beginRun(
        {
          heading: { title: 'General', subtitle: '', status: null, actions: [] },
          followUp: { placeholder: '', actions: [], status: '' },
        },
        userMessage('m0-1', USER, 'hello'),
      ),
      failureNoticeFrom('agent "General" has no runtime profile.', 'agent_runtime_profile_missing'),
    );
    const html = renderToStaticMarkup(
      <HomeChat
        agents={{ kind: 'agents', agents: [GENERAL_UNRUNNABLE] }}
        recent={[]}
        user={USER}
        run={run}
      />,
    );
    expect(html).toMatch(
      /data-testid="run-failure"[^>]*data-failure-code="agent_runtime_profile_missing"/u,
    );
    expect(html).toContain('data-testid="run-failure-code"');
    expect(html).toContain('agent &quot;General&quot; has no runtime profile.');
  });

  it('splits a coded run error into its code and its sentence', () => {
    expect(
      failureNoticeFrom('model_connection_unresolved: no workspace default is configured.'),
    ).toEqual({
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
    expect(failureNoticeFrom('The runtime could not be reached.')).toEqual({
      code: null,
      message: 'The runtime could not be reached.',
    });
  });
});

describe('the model picker offers only models the engine can drive', () => {
  const model = (provider: CatalogModel['provider'], id: string): CatalogModel => ({
    connectionId: `${provider}-conn`,
    connectionName: `${provider} default`,
    provider,
    providerModelId: id,
    displayName: id,
    capabilities: {
      streaming: true,
      toolUse: true,
      thinking: false,
      promptCaching: false,
      structuredOutput: false,
      contextManagement: false,
      webSearch: false,
      tokenCounting: false,
    },
  });

  it('drops retired Claude generations and non-chat OpenAI models', () => {
    expect(isAgentCapableModel('anthropic', 'claude-sonnet-4-5')).toBe(true);
    expect(isAgentCapableModel('anthropic', 'claude-3-7-sonnet-20250219')).toBe(true);
    expect(isAgentCapableModel('anthropic', 'claude-3-haiku-20240307')).toBe(false);
    expect(isAgentCapableModel('anthropic', 'claude-2.1')).toBe(false);
    expect(isAgentCapableModel('openai', 'gpt-5.1')).toBe(true);
    expect(isAgentCapableModel('openai', 'text-embedding-3-large')).toBe(false);
    expect(isAgentCapableModel('openai', 'gpt-4o-realtime-preview')).toBe(false);
    expect(isAgentCapableModel('openai', 'whisper-1')).toBe(false);
    expect(isAgentCapableModel('openai', 'tts-1-hd')).toBe(false);
    expect(isAgentCapableModel('openai', 'gpt-4o-mini-transcribe')).toBe(false);
    expect(isAgentCapableModel('openai', 'omni-moderation-latest')).toBe(false);
    expect(isAgentCapableModel('openai', 'gpt-image-1')).toBe(false);
    expect(isAgentCapableModel('openai', 'dall-e-3')).toBe(false);
    expect(isAgentCapableModel('openai', 'gpt-4o-search-preview')).toBe(false);
    // Embedding ids that fuse the family with a prefix, a suffix or a version.
    expect(isAgentCapableModel('openai-compatible', 'snowflake-arctic-embed2')).toBe(false);
    expect(isAgentCapableModel('openai-compatible', 'embeddinggemma')).toBe(false);
    expect(isAgentCapableModel('openai-compatible', 'textembedding-gecko')).toBe(false);
    // Google's non-chat families.
    expect(isAgentCapableModel('openai-compatible', 'models/imagen-3.0-generate-002')).toBe(false);
    expect(isAgentCapableModel('openai-compatible', 'veo-3.0-generate-001')).toBe(false);
    expect(isAgentCapableModel('openai-compatible', 'imagegeneration@006')).toBe(false);
    expect(isAgentCapableModel('openai-compatible', 'chirp_2')).toBe(false);
    expect(isAgentCapableModel('openai-compatible', 'gemini-embedding-001')).toBe(false);
    expect(isAgentCapableModel('openai-compatible', 'text-multilingual-embedding-002')).toBe(false);
    // OpenAI's speech and completion-only families, in their current ids.
    expect(isAgentCapableModel('openai', 'gpt-4o-mini-tts')).toBe(false);
    expect(isAgentCapableModel('openai', 'davinci-002')).toBe(false);
    expect(isAgentCapableModel('openai', 'babbage-002')).toBe(false);
  });

  // #403 follow-up: a family is a whole token of the id, not any substring of it.
  it('keeps a deployment name that merely contains a non-chat family', () => {
    expect(isAgentCapableModel('openai-compatible', 'research-gpt4o')).toBe(true);
    expect(isAgentCapableModel('azure-openai', 'imagery-chat')).toBe(true);
    expect(isAgentCapableModel('openai-compatible', 'models/text-embedding-004')).toBe(false);
  });

  it('drops models on a provider the engine cannot reach', () => {
    const offered = modelsDrivableBy(
      ['anthropic'],
      [model('anthropic', 'claude-sonnet-4-5'), model('openai', 'gpt-5.1')],
    );
    expect(offered.map((entry) => entry.providerModelId)).toEqual(['claude-sonnet-4-5']);
  });
});
