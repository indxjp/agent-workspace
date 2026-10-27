import { describe, expect, it } from 'vitest';

import { RUN_START_PROBLEM_CODES } from './runs.js';
import {
  SURFACE_AGENT_SWITCHER_MAX,
  SURFACE_ALLOWED_ORIGINS_MAX,
  SURFACE_ATTACHMENT_MAX_BYTES,
  SURFACE_ATTACHMENT_PROBLEM_CODES,
  SURFACE_ATTACHMENTS_MAX_FILES,
  SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES,
  SURFACE_DENSITIES,
  SURFACE_LAYOUTS,
  SURFACE_LOCALES,
  SURFACE_LOGO_URL_MAX_LENGTH,
  SURFACE_RADIUS_MAX,
  SURFACE_SESSION_PROBLEM_CODES,
  SURFACE_SESSION_TTL_SECONDS,
  SURFACE_SUGGESTED_PROMPTS_MAX,
  SURFACE_THEME_MODES,
  SURFACE_TOOL_RESULT_COMPONENTS,
  SURFACE_TOOL_RESULTS_MAX_ENTRIES,
  SURFACE_TOOL_TRACE_MODES,
  SURFACE_TURNS_PER_CONVERSATION_MAX,
  SurfaceAttachmentResponseSchema,
  SurfaceDefinitionSchema,
  SurfaceLogoSchema,
  SurfaceSessionRequestSchema,
  SurfaceSessionResponseSchema,
  toolResultFor,
  type SurfaceDefinition,
} from './surfaces.js';
import { BROWSER_TOKEN_MAX_TTL_SECONDS } from './tokens.js';

const minimal: SurfaceDefinition = { name: 'main', agent: 'assistant' };

const full: SurfaceDefinition = {
  name: 'support-widget',
  agent: 'Support triage',
  title: 'Support',
  theme: {
    colour: '#2f5fd0',
    radius: 12,
    mode: 'system',
    density: 'comfortable',
    locale: 'ja',
    logo: { url: 'https://example.com/logo.svg' },
  },
  layout: 'dock',
  parts: {
    greeting: 'Hello!\nHow can I help?',
    suggestedPrompts: ['Track my order', 'Reset my password'],
    disclaimer: 'Answers may be wrong.\tCheck before acting.',
    toolTrace: 'collapsed',
  },
};

function issuesOf(value: unknown): readonly { path: readonly PropertyKey[]; code: string }[] {
  const parsed = SurfaceDefinitionSchema.safeParse(value);
  if (parsed.success) throw new Error('expected the surface to be refused');
  return parsed.error.issues;
}

function paths(value: unknown): readonly string[] {
  return issuesOf(value).map((issue) => issue.path.map(String).join('.'));
}

describe('SurfaceDefinitionSchema', () => {
  it('parses a minimal surface unchanged', () => {
    expect(SurfaceDefinitionSchema.parse(minimal)).toEqual(minimal);
  });

  it('parses a full rung-1 and rung-2 surface unchanged', () => {
    expect(SurfaceDefinitionSchema.parse(full)).toEqual(full);
    expect(SurfaceDefinitionSchema.parse({ ...full, theme: { logo: { text: 'ACME' } } })).toEqual({
      ...full,
      theme: { logo: { text: 'ACME' } },
    });
  });

  it('freezes the parsed value', () => {
    const parsed = SurfaceDefinitionSchema.parse(full);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.theme)).toBe(true);
    expect(Object.isFrozen(parsed.parts?.suggestedPrompts)).toBe(true);
  });

  it.each([
    ['audience', 'public'],
    ['unknown', true],
  ])('refuses a surface with %s at the top level', (key, value) => {
    const issues = issuesOf({ ...minimal, [key]: value });
    expect(issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', path: [], keys: [key] }),
    ]);
  });

  it('accepts the demo of #622: allowedOrigins and limits.turnsPerConversation', () => {
    const surface = {
      ...minimal,
      allowedOrigins: ['https://shop.example.com', 'http://127.0.0.1:4000', 'http://[::1]:8080'],
      limits: { turnsPerConversation: 30 },
    };
    expect(SurfaceDefinitionSchema.parse(surface)).toEqual(surface);
  });

  it.each([
    'https://shop.example.com/',
    'https://shop.example.com/path',
    'https://*.example.com',
    'http://shop.example.com',
    'https://user@shop.example.com',
    'https://Shop.example.com',
    'https://shop.example.com:443',
    'null',
    'shop.example.com',
  ])('refuses the allowed origin %j', (origin) => {
    expect(paths({ ...minimal, allowedOrigins: [origin] })).toEqual(['allowedOrigins.0']);
  });

  it('refuses an empty, repeated or over-long allowedOrigins list', () => {
    expect(paths({ ...minimal, allowedOrigins: [] })).toEqual(['allowedOrigins']);
    expect(
      paths({ ...minimal, allowedOrigins: ['https://a.example', 'https://a.example'] }),
    ).toEqual(['allowedOrigins.1']);
    const many = Array.from(
      { length: SURFACE_ALLOWED_ORIGINS_MAX + 1 },
      (_, index) => `https://s${String(index)}.example`,
    );
    expect(paths({ ...minimal, allowedOrigins: many })).toEqual(['allowedOrigins']);
  });

  it.each([
    [{ turnsPerConversation: 0 }, ['limits.turnsPerConversation']],
    [{ turnsPerConversation: 1.5 }, ['limits.turnsPerConversation']],
    [
      { turnsPerConversation: SURFACE_TURNS_PER_CONVERSATION_MAX + 1 },
      ['limits.turnsPerConversation'],
    ],
    [{ messagesPerMinute: 10 }, ['limits']],
  ])('refuses the limits %j', (limits, expected) => {
    expect(paths({ ...minimal, limits })).toEqual(expected);
  });

  it('accepts parts.history and parts.feedback, and refuses a non-boolean', () => {
    const surface = { ...minimal, parts: { history: true, feedback: false } };
    expect(SurfaceDefinitionSchema.parse(surface)).toEqual(surface);
    expect(paths({ ...minimal, parts: { history: 'yes' } })).toEqual(['parts.history']);
  });

  it('accepts toolTrace full (#537) and refuses an unknown mode', () => {
    const surface = { ...minimal, parts: { toolTrace: 'full' } };
    expect(SurfaceDefinitionSchema.parse(surface)).toEqual(surface);
    expect(paths({ ...minimal, parts: { toolTrace: 'verbose' } })).toEqual(['parts.toolTrace']);
  });

  it('accepts parts.attachments (#1308) and refuses a non-boolean', () => {
    const surface = { ...minimal, parts: { attachments: true } };
    expect(SurfaceDefinitionSchema.parse(surface)).toEqual(surface);
    expect(paths({ ...minimal, parts: { attachments: 'yes' } })).toEqual(['parts.attachments']);
    expect(issuesOf({ ...minimal, parts: { attachments: true, uploads: true } })).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', path: ['parts'], keys: ['uploads'] }),
    ]);
  });

  it('accepts an agent switcher and freezes it', () => {
    const surface = {
      ...minimal,
      parts: { agentSwitcher: { agents: ['Support triage', 'Billing'] } },
    };
    const parsed = SurfaceDefinitionSchema.parse(surface);
    expect(parsed).toEqual(surface);
    expect(Object.isFrozen(parsed.parts?.agentSwitcher)).toBe(true);
    expect(Object.isFrozen(parsed.parts?.agentSwitcher?.agents)).toBe(true);
  });

  it('refuses an empty, over-long, repeated or padded agent switcher', () => {
    const tooMany = Array.from({ length: SURFACE_AGENT_SWITCHER_MAX + 1 }, (_, i) => `a${i}`);
    for (const agents of [[], tooMany]) {
      expect(paths({ ...minimal, parts: { agentSwitcher: { agents } } })).toEqual([
        'parts.agentSwitcher.agents',
      ]);
    }
    expect(paths({ ...minimal, parts: { agentSwitcher: { agents: ['a', 'a'] } } })).toEqual([
      'parts.agentSwitcher.agents.1',
    ]);
    expect(paths({ ...minimal, parts: { agentSwitcher: { agents: [' padded'] } } })).toEqual([
      'parts.agentSwitcher.agents.0',
    ]);
    expect(issuesOf({ ...minimal, parts: { agentSwitcher: { agents: ['a'], extra: 1 } } })).toEqual(
      [
        expect.objectContaining({
          code: 'unrecognized_keys',
          path: ['parts', 'agentSwitcher'],
          keys: ['extra'],
        }),
      ],
    );
  });

  it('accepts toolResults and refuses an unknown component, a bad name or too many entries', () => {
    const surface = {
      ...minimal,
      toolResults: { lookup_order: 'card', mcp__t_orders__list_orders: 'table', Read: 'text' },
    };
    expect(SurfaceDefinitionSchema.parse(surface)).toEqual(surface);
    expect(paths({ ...minimal, toolResults: { x: 'chart' } })).toEqual(['toolResults.x']);
    expect(paths({ ...minimal, toolResults: { 'a b': 'card' } })).toEqual(['toolResults.a b']);
    const long = 'a'.repeat(65);
    expect(paths({ ...minimal, toolResults: { [long]: 'card' } })).toEqual([`toolResults.${long}`]);
    expect(
      SurfaceDefinitionSchema.safeParse({ ...minimal, toolResults: { ['a'.repeat(64)]: 'card' } })
        .success,
    ).toBe(true);
    const tooMany = Object.fromEntries(
      Array.from({ length: SURFACE_TOOL_RESULTS_MAX_ENTRIES + 1 }, (_, i) => [`t${i}`, 'text']),
    );
    expect(paths({ ...minimal, toolResults: tooMany })).toEqual(['toolResults']);
  });

  describe('toolResultFor', () => {
    it('prefers the exact key over the bare-name suffix', () => {
      const toolResults = { mcp__x__find_files: 'card', find_files: 'table' } as const;
      expect(toolResultFor('mcp__x__find_files', toolResults)).toBe('card');
    });

    it('matches the part after the last double underscore', () => {
      expect(toolResultFor('mcp__x__find_files', { find_files: 'table' })).toBe('table');
      expect(toolResultFor('mcp__connector-0b1c__find_files', { find_files: 'table' })).toBe(
        'table',
      );
      expect(toolResultFor('find_files', { find_files: 'table' })).toBe('table');
    });

    it('matches neither a partial suffix nor a single-underscore prefix', () => {
      expect(toolResultFor('find_files_v2', { files: 'table' })).toBeUndefined();
      expect(toolResultFor('server_find_files', { find_files: 'table' })).toBeUndefined();
      expect(toolResultFor('mcp__x__find_files', { files: 'table' })).toBeUndefined();
    });

    it('returns undefined for an empty suffix, an inherited name or no toolResults', () => {
      expect(toolResultFor('mcp__x__', { x: 'table' })).toBeUndefined();
      expect(toolResultFor('constructor', {})).toBeUndefined();
      expect(toolResultFor('mcp__x__constructor', {})).toBeUndefined();
      expect(toolResultFor('find_files', undefined)).toBeUndefined();
    });
  });

  it('refuses locale fr', () => {
    expect(paths({ ...minimal, theme: { locale: 'fr' } })).toEqual(['theme.locale']);
  });

  it.each([-1, 33, 1.5])('refuses radius %s', (radius) => {
    expect(paths({ ...minimal, theme: { radius } })).toEqual(['theme.radius']);
  });

  it('accepts radius 0 and the maximum', () => {
    expect(SurfaceDefinitionSchema.safeParse({ ...minimal, theme: { radius: 0 } }).success).toBe(
      true,
    );
    expect(
      SurfaceDefinitionSchema.safeParse({ ...minimal, theme: { radius: SURFACE_RADIUS_MAX } })
        .success,
    ).toBe(true);
  });

  it.each(['#fff', 'red', '#2f5fd0 '])('refuses colour %j', (colour) => {
    expect(paths({ ...minimal, theme: { colour } })).toEqual(['theme.colour']);
  });

  it('refuses an http logo URL', () => {
    expect(
      SurfaceDefinitionSchema.safeParse({
        ...minimal,
        theme: { logo: { url: 'http://example.com/logo.svg' } },
      }).success,
    ).toBe(false);
  });

  function logoUrlIssues(url: string): readonly { code: string; message: string }[] {
    const parsed = SurfaceLogoSchema.safeParse({ url });
    // The url arm's issues surface directly, not wrapped in an invalid_union.
    if (parsed.success) throw new Error(`expected ${JSON.stringify(url)} to be refused`);
    return parsed.error.issues;
  }

  it.each([
    'https://example.com/logo.svg',
    'https://cdn.example.com/a/b%28c%29.png?v=2#x',
    'https://127.0.0.1/a.png',
    'https://example.com:8443/logo.png',
  ])('keeps the accepted logo URL %j exactly as written', (url) => {
    const parsed = SurfaceDefinitionSchema.parse({ ...minimal, theme: { logo: { url } } });
    expect(parsed.theme?.logo).toEqual({ url });
  });

  it.each([
    ' https://a.b/x.png',
    'https://a.b/x.png ',
    'https://a.b/x\n.png',
    'https://a\t.b/x.png',
    'https://a\r.b/x.png',
    '\u0001https://a.b/x.png',
    'https://a.b/x.png\u001f',
    'https:evil.com',
    'https:/evil.com',
    'https:\\evil.com/x.png',
    'HTTPS://x.example/',
    'https://x.example/a"b',
    "https://x.example/a'b",
    'https://x.example/a)b',
    'https://x.example/<b>',
    'https://x.example/a\u200bb',
  ])('refuses the logo URL %j rather than rewriting it', (url) => {
    expect(paths({ ...minimal, theme: { logo: { url } } })).toEqual(['theme.logo.url']);
  });

  it('refuses a logo URL that carries a user name or password', () => {
    expect(logoUrlIssues('https://u:p@x.example/a.png')).toEqual([
      expect.objectContaining({ message: 'must not carry a user name or password' }),
    ]);
    expect(logoUrlIssues('https://u@x.example/a.png')).toEqual([
      expect.objectContaining({ message: 'must not carry a user name or password' }),
    ]);
  });

  it('refuses a logo URL that is not in canonical form, naming the canonical form', () => {
    expect(logoUrlIssues('https://x.example')).toEqual([
      expect.objectContaining({
        message: 'must be written in canonical form: "https://x.example/"',
      }),
    ]);
    expect(logoUrlIssues('https://X.example/a.png')).toEqual([
      expect.objectContaining({
        message: 'must be written in canonical form: "https://x.example/a.png"',
      }),
    ]);
  });

  it('reports an over-long logo URL as too long, not as the wrong scheme', () => {
    const url = `https://example.com/${'a'.repeat(SURFACE_LOGO_URL_MAX_LENGTH - 19)}`;
    expect(url).toHaveLength(SURFACE_LOGO_URL_MAX_LENGTH + 1);
    expect(logoUrlIssues(url)).toEqual([
      expect.objectContaining({ code: 'too_big', message: 'must be at most 2048 characters' }),
    ]);
    const atLimit = url.slice(0, -1);
    expect(SurfaceLogoSchema.parse({ url: atLimit })).toEqual({ url: atLimit });
    expect(logoUrlIssues(`${atLimit} `)).toContainEqual(
      expect.objectContaining({ code: 'too_big', message: 'must be at most 2048 characters' }),
    );
  });

  it('refuses a logo with both text and url', () => {
    expect(
      SurfaceLogoSchema.safeParse({ text: 'ACME', url: 'https://example.com/logo.svg' }).success,
    ).toBe(false);
    expect(
      paths({ ...minimal, theme: { logo: { text: 'ACME', url: 'https://a.example' } } }),
    ).toEqual(['theme.logo']);
  });

  it('refuses more suggested prompts than the maximum', () => {
    const suggestedPrompts = Array.from(
      { length: SURFACE_SUGGESTED_PROMPTS_MAX + 1 },
      (_, index) => `Prompt ${index}`,
    );
    expect(suggestedPrompts).toHaveLength(7);
    expect(paths({ ...minimal, parts: { suggestedPrompts } })).toEqual(['parts.suggestedPrompts']);
  });

  it('refuses over-long and invisible free text', () => {
    expect(paths({ ...minimal, parts: { greeting: 'a'.repeat(501) } })).toEqual(['parts.greeting']);
    expect(paths({ ...minimal, parts: { disclaimer: 'a'.repeat(1001) } })).toEqual([
      'parts.disclaimer',
    ]);
    expect(paths({ ...minimal, parts: { suggestedPrompts: ['a'.repeat(201)] } })).toEqual([
      'parts.suggestedPrompts.0',
    ]);
    for (const greeting of ['Hi\u0007', 'Hi\u200b', 'Hi\u202e', 'Hi\u2028', 'Hi\u2029', 'Hi\r']) {
      expect(paths({ ...minimal, parts: { greeting } })).toEqual(['parts.greeting']);
    }
    expect(paths({ ...minimal, parts: { greeting: '' } })).toEqual(['parts.greeting']);
  });

  it.each([
    ['greeting', '   '],
    ['greeting', '\n'],
    ['greeting', ' Hi'],
    ['greeting', 'Hi\n'],
    ['greeting', 'Hi\u200d'],
    ['disclaimer', '\t'],
    ['disclaimer', 'Check '],
  ])('refuses %s %j, which starts or ends with whitespace or a joiner', (key, value) => {
    expect(paths({ ...minimal, parts: { [key]: value } })).toEqual([`parts.${key}`]);
  });

  it('refuses a whitespace-only or padded suggested prompt', () => {
    expect(paths({ ...minimal, parts: { suggestedPrompts: ['ok', '  '] } })).toEqual([
      'parts.suggestedPrompts.1',
    ]);
    expect(paths({ ...minimal, parts: { suggestedPrompts: [' Track'] } })).toEqual([
      'parts.suggestedPrompts.0',
    ]);
  });

  it('refuses an empty suggested-prompt list and a repeated prompt', () => {
    expect(paths({ ...minimal, parts: { suggestedPrompts: [] } })).toEqual([
      'parts.suggestedPrompts',
    ]);
    expect(paths({ ...minimal, parts: { suggestedPrompts: ['a', 'b', 'a'] } })).toEqual([
      'parts.suggestedPrompts.2',
    ]);
  });

  it.each([
    ['a ZWJ family emoji', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'],
    ['the flag of England', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
    ['a ZWNJ inside a word', 'می\u200cخواهم'],
    ['a variation selector', '\u2764\ufe0f'],
  ])('accepts %s in free text', (_label, text) => {
    const surface = { ...minimal, parts: { greeting: text, suggestedPrompts: [text] } };
    expect(SurfaceDefinitionSchema.parse(surface)).toEqual(surface);
  });

  it.each(['\u202e', '\u2066', '\u200e', '\u200f', '\u200b', '\u2060'])(
    'still refuses the invisible or bidirectional character %j inside free text',
    (character) => {
      expect(paths({ ...minimal, parts: { greeting: `a${character}b` } })).toEqual([
        'parts.greeting',
      ]);
    },
  );

  it.each(['Main', '-x', 'x-', '', 'a'.repeat(65)])('refuses the name %j', (name) => {
    expect(paths({ ...minimal, name })).toEqual(['name']);
  });

  it('accepts an agent name with spaces, and refuses an empty or over-long one', () => {
    expect(SurfaceDefinitionSchema.safeParse({ ...minimal, agent: 'Support triage' }).success).toBe(
      true,
    );
    expect(paths({ ...minimal, agent: '' })).toEqual(['agent']);
    expect(paths({ ...minimal, agent: 'a'.repeat(201) })).toEqual(['agent']);
  });

  it.each(['a\u0000b', '   ', ' assistant', 'assistant ', 'line\nbreak', 'zero\u200bwidth'])(
    'refuses the agent name %j',
    (agent) => {
      expect(paths({ ...minimal, agent })).toEqual(['agent']);
    },
  );

  it('refuses a title with a control character, padding or more than 60 characters', () => {
    for (const title of ['Help\u0000', 'Help\ndesk', ' Help', 'a'.repeat(61)]) {
      expect(paths({ ...minimal, title })).toEqual(['title']);
    }
  });

  it('exports the ADR-0108 slice-1 lists', () => {
    expect(SURFACE_LAYOUTS).toEqual(['dock', 'side', 'page', 'inline']);
    expect(SURFACE_THEME_MODES).toEqual(['light', 'dark', 'system']);
    expect(SURFACE_DENSITIES).toEqual(['compact', 'comfortable']);
    expect(SURFACE_LOCALES).toEqual(['en', 'ja']);
    expect(SURFACE_TOOL_TRACE_MODES).toEqual(['hidden', 'collapsed', 'full']);
    expect(SURFACE_TOOL_RESULT_COMPONENTS).toEqual(['text', 'card', 'table']);
    expect(SURFACE_AGENT_SWITCHER_MAX).toBe(6);
    expect(SURFACE_RADIUS_MAX).toBe(32);
    expect(SURFACE_SUGGESTED_PROMPTS_MAX).toBe(6);
  });
});

describe('SurfaceSessionRequestSchema (C18; #537)', () => {
  const resume = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    resumeKey: 'k'.repeat(43),
  };

  function requestPaths(value: unknown): readonly string[] {
    const parsed = SurfaceSessionRequestSchema.safeParse(value);
    if (parsed.success) throw new Error('expected the request to be refused');
    return parsed.error.issues.map((issue) => issue.path.map(String).join('.'));
  }

  it.each([
    {},
    { agent: 'Billing' },
    { resume, agent: 'Billing' },
    { resume, agent: 'Billing', environment: 'local' },
  ])('parses %j unchanged', (body) => {
    expect(SurfaceSessionRequestSchema.parse(body)).toEqual(body);
  });

  it('refuses an unknown top-level key', () => {
    const parsed = SurfaceSessionRequestSchema.safeParse({ agent: 'x', surface: 'main' });
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', path: [], keys: ['surface'] }),
    ]);
  });

  it.each(['production', 'preview', ''])('refuses the environment %j (#612)', (environment) => {
    expect(requestPaths({ environment })).toEqual(['environment']);
  });

  it.each([
    [{ ...resume, extra: 1 }, 'resume'],
    [{ ...resume, resumeKey: 'k'.repeat(42) }, 'resume.resumeKey'],
    [{ ...resume, sessionId: 'not-a-uuid' }, 'resume.sessionId'],
    [{ sessionId: resume.sessionId }, 'resume.resumeKey'],
  ])('refuses the resume %j at %s', (value, path) => {
    expect(requestPaths({ resume: value })).toEqual([path]);
  });
});

describe('SurfaceSessionResponseSchema (ADR-0105 slice 1; S1-17, #455)', () => {
  const session = {
    token: `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`,
    sessionId: '11111111-1111-4111-8111-111111111111',
    agentId: '22222222-2222-4222-8222-222222222222',
    expiresAt: '2026-10-02T10:00:00.000Z',
  };

  it('accepts a minted session', () => {
    expect(SurfaceSessionResponseSchema.parse(session)).toEqual(session);
  });

  it('accepts a resume key, and still accepts none (#537)', () => {
    const withKey = { ...session, resumeKey: 'k'.repeat(43) };
    expect(SurfaceSessionResponseSchema.parse(withKey)).toEqual(withKey);
    expect(
      SurfaceSessionResponseSchema.safeParse({
        ...session,
        resumeKey: 'k'.repeat(44),
      }).error?.issues.map((issue) => issue.path.join('.')),
    ).toEqual(['resumeKey']);
  });

  it('is strict', () => {
    expect(SurfaceSessionResponseSchema.safeParse({ ...session, scope: 'session' }).success).toBe(
      false,
    );
  });

  it.each([
    ['token', 'ak_live_not-a-browser-token'],
    ['token', `awt_live_${'a'.repeat(21)}_${'b'.repeat(43)}`],
    ['sessionId', 'not-a-uuid'],
    ['agentId', ''],
    ['expiresAt', '2026-10-02'],
    ['expiresAt', 'tomorrow'],
  ])('refuses a bad %s (%j)', (key, value) => {
    const result = SurfaceSessionResponseSchema.safeParse({ ...session, [key]: value });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([key]);
  });

  it('lives exactly as long as the browser-token ceiling', () => {
    expect(SURFACE_SESSION_TTL_SECONDS).toBe(BROWSER_TOKEN_MAX_TTL_SECONDS);
  });

  it('maps each problem code to its status and reuses the run-start codes', () => {
    expect(SURFACE_SESSION_PROBLEM_CODES).toEqual({
      surface_sessions_unavailable: 404,
      surface_origin_not_allowed: 403,
      surface_rate_limited: 429,
      surface_not_found: 404,
      invalid_body: 400,
      surface_sessions_not_configured: 503,
      surface_session_not_resumable: 404,
      surface_agent_not_offered: 404,
      ...RUN_START_PROBLEM_CODES,
    });
    for (const [code, status] of Object.entries(RUN_START_PROBLEM_CODES)) {
      expect(SURFACE_SESSION_PROBLEM_CODES).toHaveProperty(code, status);
    }
  });
});

describe('the attachment upload contract (ADR-0146, #1308)', () => {
  const uploaded = { fileId: 'ZmlsZQ', path: '.attachments/s/u/a.pdf', size: 12 };

  it('parses the 201 body strictly', () => {
    expect(SurfaceAttachmentResponseSchema.parse(uploaded)).toEqual(uploaded);
    expect(SurfaceAttachmentResponseSchema.safeParse({ ...uploaded, extra: 1 }).success).toBe(
      false,
    );
    expect(SurfaceAttachmentResponseSchema.safeParse({ ...uploaded, size: -1 }).success).toBe(
      false,
    );
    expect(SurfaceAttachmentResponseSchema.safeParse({ ...uploaded, fileId: '' }).success).toBe(
      false,
    );
  });

  it('fixes the limits and the problem codes', () => {
    expect(SURFACE_ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(SURFACE_ATTACHMENTS_MAX_FILES).toBe(20);
    expect(SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES).toBe(50 * 1024 * 1024);
    expect(SURFACE_ATTACHMENT_PROBLEM_CODES).toEqual({
      file_not_found: 404,
      invalid_attachment_name: 400,
      request_body_too_large: 413,
      attachments_quota_exceeded: 413,
      surface_rate_limited: 429,
    });
  });
});
