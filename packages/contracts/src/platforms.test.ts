import { describe, expect, it } from 'vitest';

import { AGENT_VERSION_NUMBER_MAX, AGENT_VERSION_PROBLEM_CODES } from './agent-versions.js';
import {
  FieldVerdictSchema,
  HOSTED_PLATFORM_IDS,
  PLATFORM_CAPABILITY_KEYS,
  PLATFORM_DROP_CODES,
  PLATFORM_EXPORT_PROBLEM_CODES,
  PLATFORM_IDS,
  PLATFORM_REFUSAL_CODES,
  PLATFORM_SUPPORT,
  PLATFORM_VERDICTS,
  PlatformCapabilitiesSchema,
  PlatformDescriptorSchema,
  PlatformExportFileSchema,
  PlatformExportRequestSchema,
  PlatformExportResponseSchema,
  PlatformFileSchema,
  PlatformIdSchema,
  PlatformRefusalSchema,
} from './platforms.js';

describe('PLATFORM_IDS', () => {
  it('lists the nine hosts in wire order', () => {
    expect(PLATFORM_IDS).toStrictEqual([
      'claude-managed-agents',
      'copilot-studio',
      'm365-declarative-agent',
      'microsoft-foundry',
      'gemini-enterprise',
      'aws-agentcore',
      'eject-claude-agent-sdk',
      'eject-mastra',
      'eject-openai-agents',
    ]);
  });

  it.each(PLATFORM_IDS)('accepts %s', (id) => {
    expect(PlatformIdSchema.parse(id)).toBe(id);
  });

  it.each(['copilot', '', 'Copilot-Studio'])('refuses %j', (id) => {
    expect(PlatformIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('PlatformCapabilitiesSchema', () => {
  const full = Object.fromEntries(PLATFORM_CAPABILITY_KEYS.map((key) => [key, 'native']));

  it('accepts every key set to a support level', () => {
    expect(PlatformCapabilitiesSchema.safeParse(full).success).toBe(true);
    for (const level of PLATFORM_SUPPORT) {
      expect(PlatformCapabilitiesSchema.safeParse({ ...full, limits: level }).success).toBe(true);
    }
  });

  it.each(PLATFORM_CAPABILITY_KEYS)('requires %s', (key) => {
    const rest = Object.fromEntries(Object.entries(full).filter(([name]) => name !== key));
    expect(PlatformCapabilitiesSchema.safeParse(rest).success).toBe(false);
  });

  it('refuses an extra key and the value partial', () => {
    expect(PlatformCapabilitiesSchema.safeParse({ ...full, extra: 'native' }).success).toBe(false);
    expect(PlatformCapabilitiesSchema.safeParse({ ...full, limits: 'partial' }).success).toBe(
      false,
    );
  });
});

describe('FieldVerdictSchema', () => {
  const base = { path: 'a.instructions', note: 'kept' };

  it('accepts native and mapped without a code, and dropped with one', () => {
    expect(FieldVerdictSchema.safeParse({ ...base, verdict: 'native' }).success).toBe(true);
    expect(FieldVerdictSchema.safeParse({ ...base, verdict: 'mapped' }).success).toBe(true);
    expect(
      FieldVerdictSchema.safeParse({ ...base, verdict: 'dropped', code: 'field_unsupported' })
        .success,
    ).toBe(true);
  });

  it('refuses dropped without a code and native with one', () => {
    expect(FieldVerdictSchema.safeParse({ ...base, verdict: 'dropped' }).success).toBe(false);
    expect(
      FieldVerdictSchema.safeParse({ ...base, verdict: 'native', code: 'field_unsupported' })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown code and an extra key', () => {
    expect(
      FieldVerdictSchema.safeParse({ ...base, verdict: 'dropped', code: 'because' }).success,
    ).toBe(false);
    expect(FieldVerdictSchema.safeParse({ ...base, verdict: 'native', extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('PlatformFileSchema', () => {
  it.each(['../x', '/x', 'a\\b'])('refuses the path %j', (path) => {
    expect(PlatformFileSchema.safeParse({ path, content: 'x' }).success).toBe(false);
  });

  it('accepts string and Uint8Array content', () => {
    expect(PlatformFileSchema.safeParse({ path: 'a/b.json', content: '{}' }).success).toBe(true);
    expect(
      PlatformFileSchema.safeParse({ path: 'a/b.bin', content: new Uint8Array([1]) }).success,
    ).toBe(true);
    expect(PlatformFileSchema.safeParse({ path: 'a/b.bin', content: 1 }).success).toBe(false);
  });
});

describe('PlatformRefusalSchema', () => {
  it('accepts every refusal code and refuses an unknown one', () => {
    for (const code of PLATFORM_REFUSAL_CODES) {
      expect(PlatformRefusalSchema.safeParse({ code, message: 'no', details: [] }).success).toBe(
        true,
      );
    }
    expect(
      PlatformRefusalSchema.safeParse({ code: 'platform_sad', message: 'no', details: [] }).success,
    ).toBe(false);
  });
});

describe('ADR-0133 D8 vocabularies', () => {
  it('lists the drop codes in order', () => {
    expect(PLATFORM_DROP_CODES).toStrictEqual([
      'code_tool_needs_public_mcp',
      'stdio_mcp_unsupported',
      'subagents_unsupported',
      'skills_unsupported',
      'knowledge_unsupported',
      'builtin_unsupported',
      'limits_unsupported',
      'permissions_unsupported',
      'field_unsupported',
    ]);
  });

  it('lists the refusal codes in order', () => {
    expect(PLATFORM_REFUSAL_CODES).toStrictEqual([
      'platform_model_unsupported',
      'platform_limit_exceeded',
      'platform_options_invalid',
      'platform_agent_not_found',
    ]);
  });

  it('lists the verdicts in order', () => {
    expect(PLATFORM_VERDICTS).toStrictEqual(['native', 'mapped', 'dropped']);
  });

  it('HOSTED_PLATFORM_IDS is every id that is not an eject target', () => {
    expect(HOSTED_PLATFORM_IDS).toStrictEqual(
      PLATFORM_IDS.filter((id) => !id.startsWith('eject-')),
    );
  });
});

describe('PlatformExportRequestSchema', () => {
  const valid = { version: 3, platform: 'copilot-studio' };

  it('accepts a request with and without options', () => {
    expect(PlatformExportRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      PlatformExportRequestSchema.safeParse({ ...valid, options: { environment: 'x' } }).success,
    ).toBe(true);
  });

  it.each([
    ['an unknown key', { ...valid, extra: 1 }],
    ['version 0', { ...valid, version: 0 }],
    ['a fractional version', { ...valid, version: 1.5 }],
    ['a version above the bound', { ...valid, version: AGENT_VERSION_NUMBER_MAX + 1 }],
    ['an unknown platform', { ...valid, platform: 'nowhere' }],
    ['an eject target, which has no compiler here', { ...valid, platform: 'eject-mastra' }],
    ['non-object options', { ...valid, options: 'x' }],
    ['array options', { ...valid, options: [] }],
    ['no platform', { version: 1 }],
  ])('refuses %s', (_name, body) => {
    expect(PlatformExportRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('PlatformExportFileSchema', () => {
  it.each(['../x', 'a/../b', '/x', 'a\\b'])('refuses the path %j', (path) => {
    expect(
      PlatformExportFileSchema.safeParse({ path, encoding: 'utf8', content: '' }).success,
    ).toBe(false);
  });

  it('accepts both encodings and refuses another', () => {
    expect(
      PlatformExportFileSchema.safeParse({ path: 'a/b', encoding: 'base64', content: 'AA==' })
        .success,
    ).toBe(true);
    expect(
      PlatformExportFileSchema.safeParse({ path: 'a/b', encoding: 'hex', content: '' }).success,
    ).toBe(false);
  });
});

describe('PlatformExportResponseSchema', () => {
  it('accepts a response and refuses an extra key', () => {
    const response = {
      agentId: 'a',
      version: 1,
      platform: 'copilot-studio',
      files: [{ path: 'PLATFORM_REPORT.md', encoding: 'utf8', content: '# r' }],
      report: [{ path: 'a.name', verdict: 'native', note: 'kept' }],
    };
    expect(PlatformExportResponseSchema.safeParse(response).success).toBe(true);
    expect(PlatformExportResponseSchema.safeParse({ ...response, extra: 1 }).success).toBe(false);
  });
});

describe('PlatformDescriptorSchema', () => {
  it('refuses an options schema or another extra key', () => {
    const capabilities = Object.fromEntries(PLATFORM_CAPABILITY_KEYS.map((key) => [key, 'native']));
    const descriptor = {
      id: 'copilot-studio',
      displayName: 'Copilot Studio',
      docsUrl: 'https://example.com/docs',
      capabilities,
    };
    expect(PlatformDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(PlatformDescriptorSchema.safeParse({ ...descriptor, optionsSchema: {} }).success).toBe(
      false,
    );
  });
});

describe('PLATFORM_EXPORT_PROBLEM_CODES', () => {
  it('reads the statuses the version routes own from their table', () => {
    expect(PLATFORM_EXPORT_PROBLEM_CODES.agent_not_found).toBe(
      AGENT_VERSION_PROBLEM_CODES.agent_not_found,
    );
    expect(PLATFORM_EXPORT_PROBLEM_CODES.agent_version_not_found).toBe(404);
  });

  it('answers every compile refusal code with a client status', () => {
    for (const code of PLATFORM_REFUSAL_CODES) {
      expect(PLATFORM_EXPORT_PROBLEM_CODES[code]).toBeGreaterThanOrEqual(400);
    }
  });
});
