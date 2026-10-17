/**
 * Issue #973: the Platforms tab. The model's rules run directly; the screen's parts are rendered
 * statically with props, as `versions.test.ts` does (this repository has no jsdom, so the fetch
 * effect never runs here — `tests/browser/agent-platforms.spec.mjs` covers the journey).
 */
import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
} from '@indx-workspace/contracts/agents';
import type {
  AgentVersionListResponse,
  AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import {
  PLATFORM_CAPABILITY_KEYS,
  PLATFORM_EXPORT_PROBLEM_CODES,
  type FieldVerdict,
  type PlatformCapabilities,
  type PlatformDescriptor,
  type PlatformExportResponse,
} from '@indx-workspace/contracts/platforms';
import { ApiProblemError } from '@indx-workspace/sdk';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentTabs, PlatformMatrix, PlatformResult, VerdictTable } from './platforms';
import { platformRefusalText, platformsStrings } from './platforms-messages';
import {
  agentCardUrl,
  agentTab,
  capabilityFields,
  checkFailure,
  defaultExportVersion,
  isHostedPlatform,
  publishCommand,
  verdictCounts,
  type PlatformCheck,
} from './platforms-model';

const AT = '2026-10-04T00:00:00.000Z';
const EN = platformsStrings('en');
const JA = platformsStrings('ja');

function version(number: number): AgentVersionResource {
  return {
    id: `id-${String(number)}`,
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    number,
    summary: `Summary ${String(number)}`,
    via: 'ui',
    body: {
      definition: {
        apiVersion: AGENT_DEFINITION_API_VERSION,
        kind: AGENT_DEFINITION_KIND,
        agent: {
          name: 'support-bot',
          instructions: 'Help.',
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
          model: 'claude-a',
          modelConnectionName: null,
          runtimeProfileName: null,
        },
        policy: {
          engine: 'claude-agent-sdk',
          tools: {
            base: 'claude_code_preset',
            autoApprove: [],
            deny: [],
            permissionMode: 'default',
            allowDangerouslySkipPermissions: false,
          },
          skills: { mode: 'allowlist', names: [] },
          limits: { maxTurns: 20, maxBudgetUsd: null },
        },
        policySource: 'stored',
        resources: { files: [], skills: [], connectors: [] },
      },
      surfaces: [],
    },
    createdByPrincipalId: 'principal-1',
    createdAt: AT,
  };
}

function listing(
  numbers: readonly number[],
  pointers: Readonly<Record<string, number>>,
): AgentVersionListResponse {
  return {
    items: numbers.map(version),
    pointers: Object.entries(pointers).flatMap(([environment, number]) =>
      environment === 'local' || environment === 'production'
        ? [{ environment, number, updatedAt: AT }]
        : [],
    ),
    materialised: null,
    moves: [],
    evaluations: [],
  };
}

const NATIVE: PlatformCapabilities = {
  description: 'native',
  instructions: 'native',
  model: 'native',
  engine: 'native',
  permissions: 'native',
  mcpRemote: 'native',
  mcpStdio: 'native',
  codeTools: 'native',
  openapiTools: 'native',
  builtinTools: 'native',
  skills: 'native',
  knowledgeFiles: 'native',
  knowledgeUrls: 'native',
  knowledgeConnectors: 'native',
  subagents: 'native',
  limits: 'native',
};

const CLAUDE: PlatformDescriptor = {
  id: 'claude-managed-agents',
  displayName: 'Claude Managed Agents',
  docsUrl: 'https://docs.example/claude',
  capabilities: { ...NATIVE, mcpStdio: 'unsupported' },
};
const COPILOT: PlatformDescriptor = {
  id: 'copilot-studio',
  displayName: 'Copilot Studio',
  docsUrl: 'https://docs.example/copilot',
  capabilities: { ...NATIVE, skills: 'mapped' },
};
const EJECT: PlatformDescriptor = {
  id: 'eject-claude-agent-sdk',
  displayName: 'Claude Agent SDK project',
  docsUrl: 'https://docs.example/eject',
  capabilities: NATIVE,
};

const REPORT: FieldVerdict[] = [
  { path: 'agent.instructions', verdict: 'native', note: 'Sent as is.' },
  { path: 'agent.model', verdict: 'mapped', note: 'Mapped to the nearest model.' },
  { path: 'resources.skills', verdict: 'dropped', code: 'skills_unsupported', note: 'No skills.' },
];

function exported(platform: PlatformDescriptor['id']): PlatformCheck {
  const response: PlatformExportResponse = {
    agentId: 'agent-1',
    version: 1,
    platform,
    files: [],
    report: REPORT,
  };
  return { kind: 'exported', platform, response };
}

const resultOf = (check: PlatformCheck): string =>
  renderToStaticMarkup(
    createElement(PlatformResult, {
      check,
      displayName: 'Some Platform',
      agentName: 'support-bot',
      origin: 'https://x.example',
      downloading: false,
      onDownload: () => undefined,
      strings: EN,
    }),
  );

describe('defaultExportVersion', () => {
  it('prefers the production pointer, then local, then the newest version', () => {
    expect(defaultExportVersion(listing([1, 2, 3], { production: 1, local: 3 }))).toBe(1);
    expect(defaultExportVersion(listing([1, 2, 3], { local: 2 }))).toBe(2);
    expect(defaultExportVersion(listing([1, 3, 2], {}))).toBe(3);
  });

  it('is null when nothing is saved', () => {
    expect(defaultExportVersion(listing([], {}))).toBeNull();
  });
});

describe('capabilityFields', () => {
  it('lists the union of capability keys in first-seen order', () => {
    expect(capabilityFields([CLAUDE, COPILOT])).toEqual([...PLATFORM_CAPABILITY_KEYS]);
    expect(capabilityFields([])).toEqual([]);
  });
});

describe('verdictCounts', () => {
  it('counts each verdict', () => {
    expect(verdictCounts(REPORT)).toEqual({ native: 1, mapped: 1, dropped: 1 });
    expect(verdictCounts([])).toEqual({ native: 0, mapped: 0, dropped: 0 });
  });
});

describe('agentCardUrl and agentTab', () => {
  it('encodes the agent name into the card URL', () => {
    expect(agentCardUrl('https://x.example', 'support bot')).toBe(
      'https://x.example/api/a2a/agents/support%20bot/.well-known/agent-card.json',
    );
  });

  it('falls back to Configuration for anything but the two other tabs', () => {
    expect(agentTab('platforms')).toBe('platforms');
    expect(agentTab('versions')).toBe('versions');
    expect(agentTab('bogus')).toBe('configuration');
    expect(agentTab(['platforms'])).toBe('configuration');
    expect(agentTab(undefined)).toBe('configuration');
  });
});

describe('publishCommand', () => {
  it('leaves a plain name bare and pins the CLI shape', () => {
    const command = publishCommand('claude-managed-agents', 'support-bot_1.2');
    expect(command).toBe(
      'aw platforms publish --platform claude-managed-agents --agent support-bot_1.2',
    );
  });

  it('single-quotes a name with a space or a quote and escapes the quote', () => {
    expect(publishCommand('copilot-studio', 'support bot')).toBe(
      "aw platforms publish --platform copilot-studio --agent 'support bot'",
    );
    expect(publishCommand('copilot-studio', "it's")).toBe(
      "aw platforms publish --platform copilot-studio --agent 'it'\\''s'",
    );
  });
});

describe('checkFailure', () => {
  it('reads a problem as a refusal with its code and details', () => {
    const error = new ApiProblemError({
      status: 422,
      problem: { code: 'platform_model_unsupported', message: 'm', details: ['model:x'] },
    });
    expect(checkFailure('copilot-studio', error)).toEqual({
      kind: 'refused',
      platform: 'copilot-studio',
      code: 'platform_model_unsupported',
      details: ['model:x'],
    });
  });

  it('reads anything else as a failure', () => {
    expect(checkFailure('copilot-studio', new TypeError('Failed to fetch'))).toEqual({
      kind: 'failed',
      platform: 'copilot-studio',
    });
  });
});

describe('isHostedPlatform', () => {
  it('is true for publish targets and false for eject targets', () => {
    expect(isHostedPlatform('aws-agentcore')).toBe(true);
    expect(isHostedPlatform('eject-claude-agent-sdk')).toBe(false);
  });
});

describe('platformRefusalText', () => {
  it('has English and Japanese text for every export problem code and the two RBAC codes', () => {
    for (const code of [
      ...Object.keys(PLATFORM_EXPORT_PROBLEM_CODES),
      'forbidden',
      'unauthenticated',
    ]) {
      for (const strings of [EN, JA]) {
        const text = platformRefusalText(code, strings);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(strings.unavailable);
      }
    }
  });

  it('says what a Viewer is told and falls back for a code it has no words for', () => {
    expect(platformRefusalText('forbidden', EN)).toBe(
      "Only the agent's owner or an admin can export it.",
    );
    expect(platformRefusalText('nonsense', EN)).toBe(EN.unavailable);
    expect(platformRefusalText('toString', JA)).toBe(JA.unavailable);
  });
});

describe('PlatformMatrix', () => {
  const render = (platforms: readonly PlatformDescriptor[], checking: PlatformCheck) =>
    renderToStaticMarkup(
      createElement(PlatformMatrix, {
        platforms,
        checking,
        onCheck: () => undefined,
        strings: EN,
      }),
    );

  it('renders a row per platform with badge words and safe external links', () => {
    const html = render([CLAUDE, COPILOT], { kind: 'idle' });
    expect(html.match(/data-platform=/gu)).toHaveLength(2);
    expect(html).toContain('Claude Managed Agents');
    expect(html).toContain('Copilot Studio');
    expect(html).toContain('>native<');
    expect(html).toContain('>mapped<');
    expect(html).toContain('>unsupported<');
    expect(html).toContain('href="https://docs.example/claude"');
    expect(html.match(/rel="noreferrer"/gu)).toHaveLength(2);
    expect(html).toContain('<caption class="sr-only">');
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-label="Check Copilot Studio"');
  });

  it('offers no Check on an eject target, which the export route refuses', () => {
    const html = render([EJECT], { kind: 'idle' });
    expect(html).not.toContain('<button');
    expect(html).toContain(EN.noCheck);
  });

  it('disables every Check while one runs', () => {
    const html = render([CLAUDE, COPILOT], { kind: 'checking', platform: 'copilot-studio' });
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });
});

describe('VerdictTable', () => {
  it('shows field, verdict word, note and the drop code', () => {
    const html = renderToStaticMarkup(createElement(VerdictTable, { report: REPORT, strings: EN }));
    expect(html).toContain('agent.instructions');
    expect(html).toContain('>dropped<');
    expect(html).toContain('skills_unsupported');
    expect(html).toContain('No skills.');
  });
});

describe('PlatformResult', () => {
  it('summarises the verdicts and offers download and the publish command', () => {
    const html = resultOf(exported('copilot-studio'));
    expect(html).toContain('1 native · 1 mapped · 1 dropped');
    expect(html).toContain('Download bundle');
    expect(html).toContain('aw platforms publish --platform copilot-studio --agent support-bot');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-live="polite"');
  });

  it('shows the Agent Card URL for gemini-enterprise only', () => {
    const url = 'https://x.example/api/a2a/agents/support-bot/.well-known/agent-card.json';
    expect(resultOf(exported('gemini-enterprise'))).toContain(url);
    expect(resultOf(exported('gemini-enterprise'))).toContain('A2A Agent Card URL');
    expect(resultOf(exported('copilot-studio'))).not.toContain('agent-card.json');
  });

  it('shows a refusal sentence and its details instead of a verdict table', () => {
    const html = resultOf({
      kind: 'refused',
      platform: 'copilot-studio',
      code: 'platform_model_unsupported',
      details: ['model:claude-a'],
    });
    expect(html).toContain('This platform cannot run the version&#x27;s model.');
    expect(html).toContain('model:claude-a');
    expect(html).not.toContain('<table');
  });

  it('tells a Viewer that only the owner or an admin can export', () => {
    const html = resultOf({
      kind: 'refused',
      platform: 'copilot-studio',
      code: 'forbidden',
      details: [],
    });
    expect(html).toContain('Only the agent&#x27;s owner or an admin can export it.');
  });
});

describe('AgentTabs', () => {
  const render = (tab: string) =>
    renderToStaticMarkup(
      createElement(AgentTabs, { agentId: 'a1', current: agentTab(tab), locale: 'en' }),
    );

  it('marks the Platforms link current for tab=platforms', () => {
    const html = render('platforms');
    expect(html).toMatch(/aria-current="page"[^>]*>Platforms</u);
    expect(html.match(/aria-current/gu)).toHaveLength(1);
    expect(html).toContain('href="/agents/a1?tab=platforms"');
  });

  it('falls back to Configuration for an unknown tab', () => {
    expect(render('bogus')).toMatch(/aria-current="page"[^>]*>Configuration</u);
  });

  it('is bilingual', () => {
    const html = renderToStaticMarkup(
      createElement(AgentTabs, { agentId: 'a1', current: 'platforms', locale: 'ja' }),
    );
    expect(html).toContain('プラットフォーム');
  });
});
