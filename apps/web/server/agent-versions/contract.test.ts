import { describe, expect, it } from 'vitest';

import {
  AGENT_VERSION_SUMMARY_MAX_LENGTH,
  AGENT_VERSION_SURFACES_MAX,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
} from '@indx-workspace/contracts/agent-versions';
import {
  AGENT_DEFINITION_FILE_PATH_MAX_LENGTH,
  AGENT_DEFINITION_MAX_REFERENCES,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
} from '@indx-workspace/contracts/agents';
import { SKILL_NAME_MAX_LENGTH } from '@indx-workspace/contracts/skills';
import {
  SURFACE_DISCLAIMER_MAX_LENGTH,
  SURFACE_GREETING_MAX_LENGTH,
  SURFACE_LOGO_URL_MAX_LENGTH,
  SURFACE_NAME_MAX_LENGTH,
  SURFACE_SUGGESTED_PROMPT_MAX_LENGTH,
  SURFACE_SUGGESTED_PROMPTS_MAX,
} from '@indx-workspace/contracts/surfaces';

import { MAX_REQUEST_BODY_BYTES } from '../agents/http';
import { MAX_AGENT_VERSION_BODY_BYTES, MAX_CREATE_AGENT_BODY_BYTES } from './contract';
import { FIXTURE_PERMISSIONS, FIXTURE_POLICY } from './fixtures';

/** A control character: the one `JSON.stringify` escapes to six bytes, `\u0001`. */
const CONTROL = '\u0001';
/** A BMP character three UTF-8 bytes long, for fields that refuse control characters. */
const WIDE = '日';

/** `index` as a lower-case kebab name of exactly `length` characters. */
function nameKey(index: number, length: number): string {
  return `s${String(index)}`.padEnd(length, 'a');
}

/** Every bounded field of a version draft at its bound, escaped or widened to its worst case. */
function maximalDraft(): Record<string, unknown> {
  const agentName = WIDE.repeat(AGENT_NAME_MAX_LENGTH);
  const skills = Array.from({ length: AGENT_DEFINITION_MAX_REFERENCES }, (_, index) =>
    nameKey(index, SKILL_NAME_MAX_LENGTH),
  );
  const surfaces = Array.from({ length: AGENT_VERSION_SURFACES_MAX }, (_, index) => ({
    name: nameKey(index, SURFACE_NAME_MAX_LENGTH),
    agent: agentName,
    title: WIDE.repeat(60),
    theme: {
      logo: {
        url: 'https://example.com/'.padEnd(SURFACE_LOGO_URL_MAX_LENGTH, 'a'),
      },
    },
    parts: {
      greeting: WIDE.repeat(SURFACE_GREETING_MAX_LENGTH),
      suggestedPrompts: Array.from({ length: SURFACE_SUGGESTED_PROMPTS_MAX }, (_, prompt) =>
        `${String(prompt)}`.padEnd(SURFACE_SUGGESTED_PROMPT_MAX_LENGTH, WIDE),
      ),
      disclaimer: WIDE.repeat(SURFACE_DISCLAIMER_MAX_LENGTH),
    },
  }));
  return {
    summary: 'x'.repeat(AGENT_VERSION_SUMMARY_MAX_LENGTH),
    via: 'aw-push',
    body: {
      definition: {
        apiVersion: 'agentworkspace.dev/v1',
        kind: 'AgentDefinition',
        agent: {
          name: agentName,
          instructions: CONTROL.repeat(AGENT_INSTRUCTIONS_MAX_LENGTH),
          permissions: FIXTURE_PERMISSIONS,
          model: CONTROL.repeat(AGENT_MODEL_MAX_LENGTH),
          modelConnectionName: CONTROL.repeat(AGENT_NAME_MAX_LENGTH),
          runtimeProfileName: CONTROL.repeat(AGENT_NAME_MAX_LENGTH),
        },
        policy: { ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: skills } },
        policySource: 'stored',
        resources: {
          files: Array.from({ length: AGENT_DEFINITION_MAX_REFERENCES }, () => ({
            path: CONTROL.repeat(AGENT_DEFINITION_FILE_PATH_MAX_LENGTH),
            access: 'read-write',
          })),
          skills,
          connectors: Array.from({ length: AGENT_DEFINITION_MAX_REFERENCES }, () =>
            CONTROL.repeat(AGENT_NAME_MAX_LENGTH),
          ),
        },
      },
      surfaces,
    },
  };
}

/** The largest create-version request: the maximal draft, as a dry run. */
function maximalRequest(): unknown {
  return { ...maximalDraft(), dryRun: true };
}

describe('MAX_AGENT_VERSION_BODY_BYTES', () => {
  it('admits the largest body the contract accepts, pretty-printed', () => {
    const request = maximalRequest();
    const parsed = CreateAgentVersionRequestSchema.safeParse(request);
    expect(parsed.error?.issues ?? []).toEqual([]);
    const bytes = new TextEncoder().encode(JSON.stringify(request, null, 2)).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_AGENT_VERSION_BODY_BYTES);
  });

  it('stays a bound: a few megabytes, not unlimited', () => {
    expect(MAX_AGENT_VERSION_BODY_BYTES).toBeLessThan(16 * 1024 * 1024);
  });
});

describe('MAX_CREATE_AGENT_BODY_BYTES (S1-06 risk 2)', () => {
  it('admits the largest create-from-version body the contract accepts, pretty-printed', () => {
    const request = { version: maximalDraft(), dryRun: true };
    const parsed = CreateAgentFromVersionRequestSchema.safeParse(request);
    expect(parsed.error?.issues ?? []).toEqual([]);
    const bytes = new TextEncoder().encode(JSON.stringify(request, null, 2)).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_CREATE_AGENT_BODY_BYTES);
  });

  it('never narrows the legacy create bound', () => {
    expect(MAX_CREATE_AGENT_BODY_BYTES).toBeGreaterThanOrEqual(MAX_REQUEST_BODY_BYTES);
    expect(MAX_CREATE_AGENT_BODY_BYTES).toBeLessThan(16 * 1024 * 1024);
  });
});
