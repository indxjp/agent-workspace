/**
 * Issue #617 (80-10): the Versions tab. The model's rules run directly; the screen's parts are
 * rendered statically with props, the way `AgentEngineSection` is (this repository has no jsdom, so
 * the fetch effect never runs here — the browser spec `tests/browser/agent-versions.spec.mjs`
 * covers list → diff → promote → roll back).
 */
import { readFileSync } from 'node:fs';

import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  type AgentDefinition,
} from '@indx-workspace/contracts/agents';
import type {
  AgentPointerMoveResponse,
  AgentVersionEvaluation,
  AgentVersionPointer,
  AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import { ApiProblemError } from '@indx-workspace/sdk';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentVersionsScreen, ReleaseControls, VersionDiff, VersionList } from './versions';
import { refusalText, versionsLocaleOf, versionsStrings } from './versions-messages';
import {
  badgesFor,
  casesText,
  connectorKeyNames,
  failedCheck,
  fieldChanges,
  lineDiff,
  planText,
  promoteRequest,
  promoteTarget,
  readyCheck,
  rollbackRefusal,
  samePlan,
  scoreText,
} from './versions-model';

const AT = '2026-10-04T00:00:00.000Z';

function definitionOf(instructions: string, model: string, runCommands = false): AgentDefinition {
  return {
    apiVersion: AGENT_DEFINITION_API_VERSION,
    kind: AGENT_DEFINITION_KIND,
    agent: {
      name: 'Summariser',
      instructions,
      permissions: { readFiles: true, writeFiles: false, runCommands, unrestrictedNetwork: false },
      model,
      modelConnectionName: null,
      runtimeProfileName: null,
    },
    policy: {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: ['Bash'],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'allowlist', names: [] },
      limits: { maxTurns: 20, maxBudgetUsd: null },
    },
    policySource: 'stored',
    resources: { files: [], skills: [], connectors: [] },
  };
}

function version(number: number, definition: AgentDefinition): AgentVersionResource {
  return {
    id: `id-${String(number)}`,
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    number,
    summary: `Summary ${String(number)}`,
    via: 'ui',
    body: { definition, surfaces: [] },
    createdByPrincipalId: 'principal-1',
    createdAt: AT,
  };
}

const V1 = version(1, definitionOf('Alpha\nShared', 'claude-a'));
const V2 = version(2, definitionOf('Beta\nShared', 'claude-b', true));
const POINTERS: AgentVersionPointer[] = [
  { environment: 'local', number: 2, updatedAt: AT },
  { environment: 'production', number: 1, updatedAt: AT },
];

function problem(code: string, details: string[]): ApiProblemError {
  return new ApiProblemError({
    status: 409,
    problem: { code, message: `${code} message`, details },
  });
}

const EVALUATIONS: AgentVersionEvaluation[] = [{ version: 2, score: 0.9, passed: 9, total: 10 }];

const MOVE: AgentPointerMoveResponse = {
  environment: 'production',
  from: 1,
  to: 2,
  saved: false,
  bar: null,
};

describe('lineDiff', () => {
  it('marks added, deleted and unchanged lines', () => {
    expect(lineDiff('Alpha\nShared', 'Beta\nShared')).toEqual([
      { kind: 'del', text: 'Alpha' },
      { kind: 'add', text: 'Beta' },
      { kind: 'same', text: 'Shared' },
    ]);
  });

  it('adds every line to an empty text and deletes every line of a text that became empty', () => {
    expect(lineDiff('', 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
    expect(lineDiff('a', '')).toEqual([{ kind: 'del', text: 'a' }]);
    expect(lineDiff('', '')).toEqual([]);
  });

  it('finds an insertion in the middle without disturbing its neighbours', () => {
    expect(lineDiff('a\nc', 'a\nb\nc').map((line) => line.kind)).toEqual(['same', 'add', 'same']);
  });

  it('still answers for a text too large to compare line by line', () => {
    const big = Array.from({ length: 2500 }, (_, index) => `line ${String(index)}`).join('\n');
    const lines = lineDiff(big, `${big}\nmore`);
    expect(lines).toHaveLength(2500 + 2501);
    expect(lines.filter((line) => line.kind === 'same')).toEqual([]);
  });
});

describe('fieldChanges', () => {
  it('lists the model and a permission flip, and leaves the instructions to the line diff', () => {
    expect(fieldChanges(V1.body, V2.body)).toEqual([
      { path: 'agent.model', before: '"claude-a"', after: '"claude-b"' },
      { path: 'agent.permissions.runCommands', before: 'false', after: 'true' },
    ]);
  });

  it('lists a policy change under its own path', () => {
    const changed = version(3, {
      ...V1.body.definition,
      policy: { ...V1.body.definition.policy, limits: { maxTurns: 5, maxBudgetUsd: null } },
    });
    expect(fieldChanges(V1.body, changed.body)).toEqual([
      { path: 'policy.limits.maxTurns', before: '20', after: '5' },
    ]);
  });

  it('shows a field that exists on one side only', () => {
    const withSurface = {
      definition: V1.body.definition,
      surfaces: [{ name: 'support', agent: 'Summariser' }],
    } as unknown as typeof V1.body;
    expect(fieldChanges(V1.body, withSurface).map((change) => change.path)).toContain(
      'surfaces[0].agent',
    );
  });

  describe('connectorKeyNames (#1121)', () => {
    it("labels each connector-<id> with the connector's key, and drops a fallback key", () => {
      const a = '00000000-0000-4000-8000-0000000000a1';
      const b = '00000000-0000-4000-8000-0000000000b2';
      expect(
        connectorKeyNames([
          { id: a, name: 'file-finder' },
          { id: b, name: 'File Finder' },
        ]),
      ).toEqual({ [`connector-${a}`]: 'file-finder' });
    });
  });

  describe('a rule stored by connector id (#1121)', () => {
    const id = '00000000-0000-4000-8000-0000000000a1';
    const rule = `mcp__connector-${id}__delete`;
    const names = { [`connector-${id}`]: 'file-finder' };
    const denying = (deny: string[]) => {
      const { policy } = V1.body.definition;
      if (policy.engine !== 'claude-agent-sdk') throw new Error('fixture');
      return version(3, {
        ...V1.body.definition,
        policy: { ...policy, tools: { ...policy.tools, deny } },
      });
    };

    it("shows the connector's name next to the stored rule", () => {
      expect(fieldChanges(V1.body, denying(['Bash', rule]).body, names)).toEqual([
        {
          path: 'policy.tools.deny',
          before: '["Bash"]',
          after: `["Bash","${rule} (file-finder)"]`,
        },
      ]);
    });

    it('shows the stored form when no name is known', () => {
      expect(fieldChanges(V1.body, denying(['Bash', rule]).body)).toEqual([
        { path: 'policy.tools.deny', before: '["Bash"]', after: `["Bash","${rule}"]` },
      ]);
    });

    it('reports no change for the same rules, named or not', () => {
      const body = denying(['Bash', rule]).body;
      expect(fieldChanges(body, body, names)).toEqual([]);
    });
  });

  it('is empty for identical bodies, even when only the instructions differ', () => {
    expect(fieldChanges(V1.body, V1.body)).toEqual([]);
    expect(fieldChanges(V1.body, version(9, definitionOf('Other', 'claude-a')).body)).toEqual([]);
  });
});

describe('planText and badgesFor', () => {
  it('prints the plan the way aw promote does', () => {
    expect(planText(MOVE)).toBe('production: 1 -> 2');
    expect(planText({ ...MOVE, from: null })).toBe('production: none -> 2');
  });

  it('badges the versions the pointers name', () => {
    expect(badgesFor(2, POINTERS)).toEqual(['local']);
    expect(badgesFor(1, POINTERS)).toEqual(['production']);
    expect(badgesFor(3, POINTERS)).toEqual([]);
  });
});

describe('promoteTarget', () => {
  it('is the version the dry run is about, and none when it was refused before picking one', () => {
    expect(promoteTarget(readyCheck(MOVE))).toBe(2);
    expect(
      promoteTarget(failedCheck(problem('promotion_not_evaluated', ['version:3', 'bar:0.8']))),
    ).toBe(3);
    expect(
      promoteTarget(
        failedCheck(problem('promotion_gate_failed', ['version:4', 'score:0.5', 'bar:0.8'])),
      ),
    ).toBe(4);
    expect(promoteTarget(failedCheck(problem('no_pointer', [])))).toBeNull();
  });
});

describe('samePlan (a rollback re-checks its plan, issue #714)', () => {
  const shown = readyCheck({ ...MOVE, from: 2, to: 1 });

  it('holds only for the same environment, from and to', () => {
    expect(samePlan(shown, readyCheck({ ...MOVE, from: 2, to: 1 }))).toBe(true);
    expect(samePlan(shown, readyCheck({ ...MOVE, from: 2, to: 0 }))).toBe(false);
    expect(samePlan(shown, readyCheck({ ...MOVE, from: 3, to: 1 }))).toBe(false);
    expect(samePlan(shown, readyCheck({ ...MOVE, environment: 'local', from: 2, to: 1 }))).toBe(
      false,
    );
  });

  it('does not hold when either side is not ready', () => {
    const refused = failedCheck(problem('nothing_to_roll_back', []));
    expect(samePlan(shown, refused)).toBe(false);
    expect(samePlan(refused, shown)).toBe(false);
  });
});

describe('rollbackRefusal (Confirm re-checks a rollback, issue #714)', () => {
  const shown = readyCheck({ ...MOVE, from: 2, to: 1 });

  it('refuses a changed plan', () => {
    expect(rollbackRefusal(shown, readyCheck({ ...MOVE, from: 2, to: 0 }))).toBe('plan_changed');
  });

  it('surfaces a fresh refusal or a failed re-check as itself, not as a changed plan', () => {
    const refused = failedCheck(problem('nothing_to_roll_back', []));
    expect(rollbackRefusal(shown, refused)).toBe(refused);
    expect(rollbackRefusal(shown, failedCheck(new Error('offline')))).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
  });

  it('lets the same plan proceed', () => {
    expect(rollbackRefusal(shown, readyCheck({ ...MOVE, from: 2, to: 1 }))).toBeNull();
  });
});

describe('promoteRequest', () => {
  it('pins the promote to the version the dry run showed', () => {
    expect(promoteRequest(readyCheck(MOVE))).toEqual({ version: 2 });
  });

  it('sends no version when the dry run did not answer ready', () => {
    expect(promoteRequest(failedCheck(problem('no_pointer', [])))).toEqual({});
  });
});

describe('failedCheck (the promotion gate, issue #619)', () => {
  it('reads a not-evaluated refusal', () => {
    expect(failedCheck(problem('promotion_not_evaluated', ['version:3', 'bar:0.8']))).toEqual({
      kind: 'not_evaluated',
      version: 3,
      bar: 0.8,
    });
  });

  it('reads a failed gate with its failing cases in order', () => {
    expect(
      failedCheck(
        problem('promotion_gate_failed', [
          'version:3',
          'score:0.5714',
          'bar:0.8',
          'case:a',
          'case:b',
        ]),
      ),
    ).toEqual({ kind: 'gate_failed', version: 3, score: 0.5714, bar: 0.8, cases: ['a', 'b'] });
  });

  it('keeps any other problem as it is, and a non-problem as unavailable', () => {
    expect(failedCheck(problem('no_pointer', []))).toEqual({
      kind: 'refused',
      code: 'no_pointer',
    });
    expect(failedCheck(new Error('socket hang up'))).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
  });

  it('does not read a gate refusal whose details are missing', () => {
    expect(failedCheck(problem('promotion_gate_failed', ['version:3']))).toMatchObject({
      kind: 'refused',
      code: 'promotion_gate_failed',
    });
  });

  it('rounds a refused score down so it never prints at the bar', () => {
    expect(scoreText(0.8999)).toBe('0.89');
    expect(scoreText(0.5714)).toBe('0.57');
    expect(scoreText(0.57)).toBe('0.57');
  });

  it('elides failing cases after three', () => {
    expect(casesText(['a', 'b', 'c', 'd'])).toBe('"a", "b", "c", …');
  });
});

describe('versionsStrings', () => {
  it('has the same keys in English and Japanese', () => {
    expect(Object.keys(versionsStrings('ja')).sort()).toEqual(
      Object.keys(versionsStrings('en')).sort(),
    );
  });

  it('translates every sentence rather than repeating English', () => {
    const en = versionsStrings('en');
    const ja = versionsStrings('ja');
    // The environment names, and `aw push` / `API`, are the product's own words in both.
    const shared = new Set(['badgeLocal', 'badgeProduction', 'viaAwPush', 'viaApi', 'noScore']);
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      if (shared.has(key)) continue;
      const [a, b] = [en[key], ja[key]];
      if (typeof a === 'string') expect(b, key).not.toBe(a);
    }
    expect(ja.gateFailed(3, '0.57', '0.80', '"a"')).not.toBe(
      en.gateFailed(3, '0.57', '0.80', '"a"'),
    );
    for (const code of Object.keys(en.refusals) as (keyof typeof en.refusals)[]) {
      expect(ja.refusals[code], code).not.toBe(en.refusals[code]);
    }
  });

  it('negotiates the locale from the whole Accept-Language list by q-value', () => {
    const cases: [string | null, 'en' | 'ja'][] = [
      ['ja,en;q=0.8', 'ja'],
      ['ja-JP', 'ja'],
      ['JA-jp', 'ja'],
      ['en-US,ja;q=0.9', 'en'],
      ['fr, ja;q=0.8', 'ja'],
      ['en;q=0.5, ja', 'ja'],
      ['ja;q=0, en', 'en'],
      ['ja;q=abc', 'ja'],
      ['ja;q=2, en', 'ja'],
      ['en;q=0.8, ja;q=0.8', 'en'],
      ['de, fr', 'en'],
      ['*', 'en'],
      ['', 'en'],
      [null, 'en'],
    ];
    for (const [header, locale] of cases)
      expect(versionsLocaleOf(header), String(header)).toBe(locale);
  });
});

describe('refusalText', () => {
  it('words every known code in the page language', () => {
    for (const locale of ['en', 'ja'] as const) {
      const strings = versionsStrings(locale);
      expect(refusalText('surface_name_taken', strings)).toBe(strings.refusals.surface_name_taken);
      expect(refusalText('policy_cannot_widen', strings)).toBe(
        strings.refusals.policy_cannot_widen,
      );
    }
    expect(refusalText('agent_version_not_found', versionsStrings('ja'))).toContain('バージョン');
  });

  it('answers the localized generic sentence for an unknown, 5xx or inherited code', () => {
    for (const locale of ['en', 'ja'] as const) {
      const strings = versionsStrings(locale);
      for (const code of [
        'some_new_code',
        'internal_error',
        'unavailable',
        'toString',
        '__proto__',
      ])
        expect(refusalText(code, strings), code).toBe(strings.unavailable);
    }
  });
});

const EN = versionsStrings('en');
const JA = versionsStrings('ja');
const noop = (): void => undefined;

describe('VersionList', () => {
  it('puts the badges on the rows the pointers name, newest first', () => {
    const html = renderToStaticMarkup(
      createElement(VersionList, {
        items: [V1, V2],
        pointers: POINTERS,
        evaluations: EVALUATIONS,
        selected: [1],
        onToggle: noop,
        strings: EN,
        locale: 'en',
      }),
    );
    const rows = html.split('<tr').filter((row) => row.includes('data-version'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('data-version="2"');
    expect(rows[0]).toContain('>local<');
    expect(rows[0]).not.toContain('>production<');
    expect(rows[1]).toContain('>production<');
    expect(rows[1]).toContain('checked');
    expect(rows[1]).toContain('Summary 1');
    expect(rows[1]).toContain('principal-1');
  });

  it("shows each version's latest score, and a dash for one never evaluated (#714)", () => {
    const html = renderToStaticMarkup(
      createElement(VersionList, {
        items: [V1, V2],
        pointers: POINTERS,
        evaluations: EVALUATIONS,
        selected: [],
        onToggle: noop,
        strings: EN,
        locale: 'en',
      }),
    );
    expect(html).toContain(`>${EN.columnScore}<`);
    expect(html).toContain(
      '<td class="border-b border-border px-3 py-2 align-top whitespace-nowrap" data-score="2">0.90 (9/10)</td>',
    );
    expect(html).toContain(`data-score="1">${EN.noScore}</td>`);
  });

  it('says so when the agent has no versions', () => {
    const html = renderToStaticMarkup(
      createElement(VersionList, {
        items: [],
        pointers: [],
        evaluations: [],
        selected: [],
        onToggle: noop,
        strings: EN,
        locale: 'en',
      }),
    );
    expect(html).toContain(EN.empty);
  });
});

describe('VersionDiff', () => {
  it('shows the instruction lines and the changed fields of two versions', () => {
    const html = renderToStaticMarkup(
      createElement(VersionDiff, { older: V1, newer: V2, strings: EN, connectorNames: {} }),
    );
    expect(html).toContain('Version 1 to version 2');
    expect(html).toContain('− Alpha');
    expect(html).toContain('+ Beta');
    expect(html).toContain('agent.model');
    expect(html).toContain('&quot;claude-b&quot;');
  });

  it('labels a rule stored by connector id with the connector name (#1121)', () => {
    const id = '00000000-0000-4000-8000-0000000000a1';
    const { policy } = V1.body.definition;
    if (policy.engine !== 'claude-agent-sdk') throw new Error('fixture');
    const newer = version(3, {
      ...V1.body.definition,
      policy: { ...policy, tools: { ...policy.tools, deny: [`mcp__connector-${id}__delete`] } },
    });
    const html = renderToStaticMarkup(
      createElement(VersionDiff, {
        older: V1,
        newer,
        strings: EN,
        connectorNames: { [`connector-${id}`]: 'file-finder' },
      }),
    );
    expect(html).toContain(`mcp__connector-${id}__delete (file-finder)`);
  });
});

describe('ReleaseControls', () => {
  const props = {
    asking: null,
    busy: false,
    evaluations: [] as AgentVersionEvaluation[],
    onAsk: noop,
    onConfirm: noop,
    onCancel: noop,
  };

  it('shows the plan beside each button and the bar when none is set', () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        promote: readyCheck(MOVE),
        rollback: readyCheck({ ...MOVE, from: 2, to: 1 }),
        strings: EN,
      }),
    );
    expect(html).toContain('production: 1 -&gt; 2');
    expect(html).toContain('production: 2 -&gt; 1');
    expect(html).toContain(EN.noBar);
    expect(html).not.toContain('disabled=""');
  });

  it('disables Promote and says why when the gate refuses', () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        promote: failedCheck(
          problem('promotion_gate_failed', ['version:3', 'score:0.5714', 'bar:0.8', 'case:greets']),
        ),
        rollback: failedCheck(problem('nothing_to_roll_back', [])),
        strings: EN,
      }),
    );
    expect(html).toContain('v3 scored 0.57 (bar 0.80). Failing cases: &quot;greets&quot;');
    expect(html).toContain(EN.refusals.nothing_to_roll_back);
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });

  it("shows the server's English message on neither page for an unmapped refusal", () => {
    for (const strings of [EN, JA]) {
      const html = renderToStaticMarkup(
        createElement(ReleaseControls, {
          ...props,
          promote: failedCheck(problem('some_new_code', [])),
          rollback: failedCheck(problem('nothing_to_roll_back', [])),
          strings,
        }),
      );
      expect(html).toContain(strings.unavailable);
      expect(html).toContain(strings.refusals.nothing_to_roll_back);
      expect(html).not.toContain('some_new_code message');
    }
  });

  it("shows the target version's latest evaluation above the gate verdict (#714)", () => {
    const evaluated = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        evaluations: EVALUATIONS,
        promote: readyCheck(MOVE),
        rollback: failedCheck(problem('nothing_to_roll_back', [])),
        strings: EN,
      }),
    );
    expect(evaluated).toContain(EN.latestEvaluation(2, '0.90', 9, 10));
    expect(evaluated.indexOf(EN.latestEvaluation(2, '0.90', 9, 10))).toBeLessThan(
      evaluated.indexOf(EN.noBar),
    );
    expect(evaluated.match(/data-evaluation/gu)).toHaveLength(1);

    const unevaluated = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        promote: failedCheck(problem('promotion_not_evaluated', ['version:3', 'bar:0.8'])),
        rollback: failedCheck(problem('nothing_to_roll_back', [])),
        strings: EN,
      }),
    );
    expect(unevaluated).toContain(EN.notEvaluatedYet(3));

    const failed = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        evaluations: [{ version: 3, score: 0.5714, passed: 4, total: 7 }],
        promote: failedCheck(
          problem('promotion_gate_failed', ['version:3', 'score:0.5714', 'bar:0.8', 'case:a']),
        ),
        rollback: failedCheck(problem('nothing_to_roll_back', [])),
        strings: EN,
      }),
    );
    expect(failed).toContain(EN.latestEvaluation(3, '0.57', 4, 7));
    expect(failed).toContain('v3 scored 0.57 (bar 0.80)');
  });

  it('shows no evaluation line when the promote was refused before picking a version (#714)', () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        evaluations: EVALUATIONS,
        promote: failedCheck(problem('no_pointer', [])),
        rollback: failedCheck(problem('nothing_to_roll_back', [])),
        strings: EN,
      }),
    );
    expect(html).not.toContain('data-evaluation');
  });

  it('opens the confirmation with the same plan text', () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        asking: 'promote',
        promote: readyCheck({ ...MOVE, from: null }),
        rollback: failedCheck(problem('nothing_to_roll_back', [])),
        strings: EN,
      }),
    );
    expect(html).toContain(`aria-label="${EN.confirmPromote}"`);
    expect(html.match(/production: none -&gt; 2/gu)).toHaveLength(2);
  });

  it('says it is working on the confirm button while the move runs', () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        asking: 'promote',
        busy: true,
        promote: readyCheck(MOVE),
        rollback: failedCheck(problem('nothing_to_roll_back', [])),
        strings: EN,
      }),
    );
    expect(html).toContain(EN.working);
  });

  it('speaks Japanese when asked to', () => {
    const html = renderToStaticMarkup(
      createElement(ReleaseControls, {
        ...props,
        promote: failedCheck(problem('promotion_not_evaluated', ['version:3', 'bar:0.8'])),
        rollback: readyCheck({ ...MOVE, from: 2, to: 1 }),
        strings: JA,
      }),
    );
    expect(html).toContain(JA.notEvaluated(3, '0.80'));
    expect(html).toContain(JA.notEvaluatedYet(3));
    expect(html).not.toContain(EN.notEvaluatedYet(3));
    expect(html).toContain(JA.rollback);
    expect(html).not.toContain(EN.rollback);
  });
});

describe('AgentVersionsScreen', () => {
  it('renders a language-tagged loading state before the SDK answers', () => {
    const html = renderToStaticMarkup(
      createElement(AgentVersionsScreen, { agentId: 'agent-1', locale: 'ja' }),
    );
    expect(html).toContain('lang="ja"');
    expect(html).toContain(JA.loading);
    expect(html).toContain(`<h1 class="text-[21px]">${JA.heading}</h1>`);
  });

  it('reaches the server only through the SDK client', () => {
    for (const file of ['versions.tsx', 'versions-model.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/\bfetch\s*\(/u);
    }
  });
});
