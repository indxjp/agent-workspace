import { z } from 'zod';

import { AGENT_NAME_MAX_LENGTH } from './agents.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { NAME_KEY_PATTERN } from './project-file.js';
import { SURFACE_ATTACHMENT_MAX_BYTES } from './attachment-limits.js';
import { RUN_START_PROBLEM_CODES } from './runs.js';
import { HEX_COLOUR_PATTERN, SURFACE_TITLE_MAX_LENGTH, SURFACE_TITLE_PATTERN } from './setup.js';
import { BROWSER_TOKEN_PATTERN } from './tokens.js';

/**
 * Issue #440 (S1-02): a surface as code — what `defineSurface()` returns (C3), what a version's
 * body carries next to its agent definition (ADR-0101), and what the hosted widget at
 * `/p/s/<name>` reads its look from. It accepts rungs ① (look) and ② (layout and parts) of
 * ADR-0108; rung ② is complete since issue #537 (ADR-0108 SD10): history, feedback, the agent
 * switcher, a full tool trace and built-in tool-result components. Allowed origins and limits
 * embed a surface on a customer's own site (issue #622). Attachments (`parts.attachments`,
 * ADR-0146; issue #1308) join the parts. Audience arrives in a later unit, and until then a strict
 * object refuses it rather than accepting and ignoring it.
 *
 * Every schema here is plain structure: no default and no transform, so the parsed value is the
 * value written, and `z.toJSONSchema` can emit an editor schema from the same definitions.
 */
export const SURFACE_LAYOUTS = ['dock', 'side', 'page', 'inline'] as const;
export type SurfaceLayout = (typeof SURFACE_LAYOUTS)[number];
/** Where a surface sits on the page (ADR-0108 rung ②; issue #440). */
export const SurfaceLayoutSchema = z.enum(SURFACE_LAYOUTS);

/** The colour schemes a surface may follow (ADR-0108 rung ①; issue #440). */
export const SURFACE_THEME_MODES = ['light', 'dark', 'system'] as const;
export type SurfaceThemeMode = (typeof SURFACE_THEME_MODES)[number];
/** {@link SURFACE_THEME_MODES} as a schema (ADR-0108; issue #440). */
export const SurfaceThemeModeSchema = z.enum(SURFACE_THEME_MODES);

/** How tightly a surface spaces its content (ADR-0108 rung ①; issue #440). */
export const SURFACE_DENSITIES = ['compact', 'comfortable'] as const;
export type SurfaceDensity = (typeof SURFACE_DENSITIES)[number];
/** {@link SURFACE_DENSITIES} as a schema (ADR-0108; issue #440). */
export const SurfaceDensitySchema = z.enum(SURFACE_DENSITIES);

/** The languages a surface's own chrome is shown in (ADR-0108 rung ①; issue #440). */
export const SURFACE_LOCALES = ['en', 'ja'] as const;
export type SurfaceLocale = (typeof SURFACE_LOCALES)[number];
/** {@link SURFACE_LOCALES} as a schema (ADR-0108; issue #440). */
export const SurfaceLocaleSchema = z.enum(SURFACE_LOCALES);

/**
 * How a surface shows the agent's tool calls (ADR-0108 rung ②; issue #440). `full` completes
 * rung ② (ADR-0108 SD10; issue #537).
 */
export const SURFACE_TOOL_TRACE_MODES = ['hidden', 'collapsed', 'full'] as const;
export type SurfaceToolTraceMode = (typeof SURFACE_TOOL_TRACE_MODES)[number];
/** {@link SURFACE_TOOL_TRACE_MODES} as a schema (ADR-0108; issue #440). */
export const SurfaceToolTraceModeSchema = z.enum(SURFACE_TOOL_TRACE_MODES);

/** The largest corner radius a theme may set, in CSS pixels (ADR-0108; issue #440). */
export const SURFACE_RADIUS_MAX = 32;

/** The most suggested prompts a surface may show (ADR-0108; issue #440). */
export const SURFACE_SUGGESTED_PROMPTS_MAX = 6;

/** The longest greeting, in characters (ADR-0108; issue #440). */
export const SURFACE_GREETING_MAX_LENGTH = 500;

/** The longest disclaimer, in characters (ADR-0108; issue #440). */
export const SURFACE_DISCLAIMER_MAX_LENGTH = 1000;

/** The longest suggested prompt, in characters (ADR-0108; issue #440). */
export const SURFACE_SUGGESTED_PROMPT_MAX_LENGTH = 200;

/** The longest https logo URL, in characters (ADR-0108; issue #440). */
export const SURFACE_LOGO_URL_MAX_LENGTH = 2048;

/** The longest surface name, in characters; the name-key grammar's own bound (issue #440). */
export const SURFACE_NAME_MAX_LENGTH = 64;

/** The most agents a surface's agent switcher may offer (ADR-0108 SD10; issue #537). */
export const SURFACE_AGENT_SWITCHER_MAX = 6;

/**
 * The built-in components a tool's result may render as (ADR-0108 SD10; issue #537). A tool not
 * named in `toolResults` renders as `text`.
 */
export const SURFACE_TOOL_RESULT_COMPONENTS = ['text', 'card', 'table'] as const;
export type SurfaceToolResultComponent = (typeof SURFACE_TOOL_RESULT_COMPONENTS)[number];
/** {@link SURFACE_TOOL_RESULT_COMPONENTS} as a schema (ADR-0108 SD10; issue #537). */
export const SurfaceToolResultComponentSchema = z.enum(SURFACE_TOOL_RESULT_COMPONENTS);

/**
 * A `toolResults` key: a tool name as a run's `agent.tool.call` frame carries it, up to the
 * 64-character model-visible cap, so engine-prefixed names such as `mcp__<key>__<op>` fit; how a
 * prefixed name is matched is {@link toolResultFor}'s (ADR-0108 SD10; issues #537, #1276).
 */
export const SURFACE_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** The most entries `toolResults` may hold (ADR-0108 SD10; issue #537). */
export const SURFACE_TOOL_RESULTS_MAX_ENTRIES = 64;

/** The most origins `allowedOrigins` may list (issue #622). */
export const SURFACE_ALLOWED_ORIGINS_MAX = 20;

/** The most turns `limits.turnsPerConversation` may allow (issue #622). */
export const SURFACE_TURNS_PER_CONVERSATION_MAX = 1000;

/**
 * Free text a surface shows: line feeds and tabs are allowed, and so are the three format
 * characters emoji and some scripts need — ZERO WIDTH NON-JOINER (U+200C), ZERO WIDTH JOINER
 * (U+200D) and the tag characters (U+E0020–U+E007F, the subdivision flags). Nothing else that is
 * a control (`Cc`), format (`Cf`: other zero-width characters and every bidirectional control),
 * lone surrogate (`Cs`) or line or paragraph separator (`Zl`, `Zp`) character is accepted — what
 * the person reads is what the version holds. Unassigned code points (`Cn`) are not refused,
 * because that set shrinks with every Unicode release and would refuse new emoji; private-use
 * code points (`Co`) are not refused, because icon fonts draw them.
 */
const SURFACE_FREE_TEXT_PATTERN =
  /^(?:[\t\n]|\u200C|\u200D|[\u{E0020}-\u{E007F}]|[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}])+$/u;

/**
 * Text whose first and last characters are visible: not whitespace, and not one of the joiners
 * {@link SURFACE_FREE_TEXT_PATTERN} admits inside the text. A tag character may end the text,
 * since U+E007F (CANCEL TAG) is how a subdivision flag ends.
 */
const VISIBLE_EDGES_PATTERN =
  /^(?!\s|\u200C|\u200D|[\u{E0020}-\u{E007F}])[\s\S]*(?<!\s|\u200C|\u200D)$/u;

/**
 * A bounded free-text field. The length check aborts before the patterns run, so an over-long
 * value is refused without the patterns scanning it.
 */
function surfaceFreeText(maxLength: number): z.ZodString {
  return z
    .string()
    .min(1, { abort: true })
    .max(maxLength, { abort: true })
    .regex(SURFACE_FREE_TEXT_PATTERN, {
      abort: true,
      error: 'must not contain control or invisible characters',
    })
    .regex(
      VISIBLE_EDGES_PATTERN,
      'must not start or end with whitespace or an invisible character',
    );
}

/**
 * A logo URL as a person can type it: `https://` and then no whitespace, control character,
 * backslash, quote, backtick, angle bracket or parenthesis. Those characters are either rewritten
 * by the URL parser (so the stored value would differ from the written one) or break out of the
 * CSS `url()` or HTML attribute the widget places the URL in; a URL that needs one percent-encodes
 * it.
 */
const SURFACE_LOGO_URL_PATTERN = /^https:\/\/[^\s\p{Cc}\p{Cf}\p{Cs}\\"'`<>()]+$/u;

/**
 * Refuses a logo URL that the WHATWG parser reads differently from how it is written, or that
 * carries a user name or password — a credential in a committed `surfaces/*.ts` file would be
 * served to every viewer of the widget.
 */
function checkLogoUrl(value: string, context: z.RefinementCtx<string>): void {
  // The length and character checks report their own issues; parse only a value both accept.
  if (value.length > SURFACE_LOGO_URL_MAX_LENGTH || !SURFACE_LOGO_URL_PATTERN.test(value)) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'must be an https:// URL' });
    return;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    context.addIssue({ code: 'custom', message: 'must be an https:// URL' });
    return;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    context.addIssue({ code: 'custom', message: 'must not carry a user name or password' });
    return;
  }
  if (parsed.href !== value) {
    context.addIssue({
      code: 'custom',
      message: `must be written in canonical form: ${JSON.stringify(parsed.href)}`,
    });
  }
}

/**
 * A logo's `https://` URL. The length, the character pattern and the parse each report their own
 * message, and the parse runs only on a value the first two accept; nothing is trimmed or
 * rewritten, so the parsed value is the value written (ADR-0108 rung ①; issue #440). No check
 * aborts, so a refusal inside the logo union is reported at `logo.url` rather than as a union
 * mismatch.
 */
const SurfaceLogoUrlSchema = z
  .string()
  .max(SURFACE_LOGO_URL_MAX_LENGTH, `must be at most ${SURFACE_LOGO_URL_MAX_LENGTH} characters`)
  .regex(
    SURFACE_LOGO_URL_PATTERN,
    'must be an https:// URL with no whitespace, control character, backslash, quote, backtick, angle bracket or parenthesis',
  )
  .superRefine(checkLogoUrl);

/**
 * The agent a surface names: the agent-name bound of `AgentDefinitionAgentSchema.name`, on one
 * line, with no control or invisible character and a visible first and last character.
 */
const SurfaceAgentNameSchema = z
  .string()
  .min(1, { abort: true })
  .max(AGENT_NAME_MAX_LENGTH, { abort: true })
  .regex(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u, {
    abort: true,
    error: 'must not contain control or invisible characters',
  })
  .regex(VISIBLE_EDGES_PATTERN, 'must not start or end with whitespace');

/** Refuses a list entry equal to an earlier one, at the repeated entry's own index. */
function refuseRepeats(message: string) {
  return (values: readonly string[], context: z.RefinementCtx<string[]>): void => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) context.addIssue({ code: 'custom', path: [index], message });
      seen.add(value);
    }
  };
}

/** The surface-title grammar of S1-01's setup question (`SURFACE_TITLE_PATTERN`). */
const SurfaceTitleSchema = z
  .string()
  .max(SURFACE_TITLE_MAX_LENGTH, { abort: true })
  .regex(
    SURFACE_TITLE_PATTERN,
    'must be 1-60 characters, no control or invisible characters, no space at either end',
  );

/**
 * A surface's logo: either a short text mark in the surface-title grammar or an `https://` image
 * URL — never both, so a logo carrying both keys is refused by each strict arm (ADR-0108 rung ①;
 * issue #440).
 */
export const SurfaceLogoSchema = z.union([
  z.object({ text: SurfaceTitleSchema }).strict().readonly(),
  z
    .object({
      url: SurfaceLogoUrlSchema,
    })
    .strict()
    .readonly(),
]);
export type SurfaceLogo = z.infer<typeof SurfaceLogoSchema>;

/**
 * A surface's look — ADR-0108's rung ①. Every key is optional; an unset key takes the widget's
 * own default when it renders, not here, so the parsed value is exactly what was written
 * (ADR-0108, ADR-0101; issue #440).
 */
export const SurfaceThemeSchema = z
  .object({
    /** The brand colour, `#rrggbb` — the grammar of S1-01's `embedder.brandColour` answer. */
    colour: z
      .string()
      .max(7, { abort: true })
      .regex(HEX_COLOUR_PATTERN, 'must be #rrggbb')
      .optional(),
    /** The corner radius in CSS pixels, a whole number from 0 to {@link SURFACE_RADIUS_MAX}. */
    radius: z.number().int().min(0).max(SURFACE_RADIUS_MAX).optional(),
    mode: SurfaceThemeModeSchema.optional(),
    density: SurfaceDensitySchema.optional(),
    locale: SurfaceLocaleSchema.optional(),
    logo: SurfaceLogoSchema.optional(),
  })
  .strict()
  .readonly();
export type SurfaceTheme = z.infer<typeof SurfaceThemeSchema>;

/**
 * The parts a surface shows — ADR-0108's rung ②, complete since issue #537 (SD10): history,
 * feedback and the agent switcher join the slice-1 parts, and attachments follow in ADR-0146
 * (ADR-0108, ADR-0101; issues #440, #537, #1308).
 */
export const SurfacePartsSchema = z
  .object({
    greeting: surfaceFreeText(SURFACE_GREETING_MAX_LENGTH).optional(),
    suggestedPrompts: z
      .array(surfaceFreeText(SURFACE_SUGGESTED_PROMPT_MAX_LENGTH))
      .min(1)
      .max(SURFACE_SUGGESTED_PROMPTS_MAX)
      .superRefine(refuseRepeats('repeats an earlier suggested prompt'))
      .readonly()
      .optional(),
    disclaimer: surfaceFreeText(SURFACE_DISCLAIMER_MAX_LENGTH).optional(),
    toolTrace: SurfaceToolTraceModeSchema.optional(),
    /** Whether the surface lists the visitor's earlier conversations (ADR-0108 SD10; #537). */
    history: z.boolean().optional(),
    /** Whether the surface asks for a thumbs-up or -down on each answer (ADR-0108 SD10; #537). */
    feedback: z.boolean().optional(),
    /**
     * Whether the composer offers a file input; the visitor's files go to
     * `POST /api/sessions/:id/attachments` and ride on the run as `attachments` (ADR-0146 D7;
     * issue #1308).
     */
    attachments: z.boolean().optional(),
    /**
     * The agents a visitor may switch between, by name, 1–{@link SURFACE_AGENT_SWITCHER_MAX} with
     * no repeat. Whether each is the surface owner's is a runtime check, not this schema's
     * (ADR-0108 SD10; issue #537).
     */
    agentSwitcher: z
      .object({
        agents: z
          .array(SurfaceAgentNameSchema)
          .min(1)
          .max(SURFACE_AGENT_SWITCHER_MAX)
          .superRefine(refuseRepeats('repeats an earlier agent'))
          .readonly(),
      })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type SurfaceParts = z.infer<typeof SurfacePartsSchema>;

/**
 * Which built-in component each named tool's result renders as: tool names in
 * {@link SURFACE_TOOL_NAME_PATTERN}, at most {@link SURFACE_TOOL_RESULTS_MAX_ENTRIES} entries
 * (ADR-0108 SD10; issue #537).
 */
// ponytail: zod's record drops an own "__proto__" key, so a tool of that name falls back to text; refuse it with project-file.ts's refusePrototypeKey pre-step if that ever matters
export const SurfaceToolResultsSchema = z
  .record(
    z
      .string()
      .regex(
        SURFACE_TOOL_NAME_PATTERN,
        'must be a tool name: A-Z, a-z, 0-9, _ or -, 1-64 characters',
      ),
    SurfaceToolResultComponentSchema,
  )
  .readonly()
  .refine(
    (entries) => Object.keys(entries).length <= SURFACE_TOOL_RESULTS_MAX_ENTRIES,
    `must hold at most ${String(SURFACE_TOOL_RESULTS_MAX_ENTRIES)} entries`,
  );

/**
 * The component `toolResults` names for a run's tool: the exact key first, else the key equal to
 * the part after the last `__`, so `find_files` matches Claude's `mcp__<connector>__find_files`
 * (issue #1276). A single `_` is never a separator: Mastra's `<server>_<tool>` is ambiguous.
 */
export function toolResultFor(
  toolName: string,
  toolResults: z.infer<typeof SurfaceToolResultsSchema> | undefined,
): SurfaceToolResultComponent | undefined {
  if (toolResults === undefined) return undefined;
  if (Object.hasOwn(toolResults, toolName)) return toolResults[toolName];
  const bare = toolName.slice(toolName.lastIndexOf('__') + 2);
  return toolName.includes('__') && Object.hasOwn(toolResults, bare)
    ? toolResults[bare]
    : undefined;
}

/** Hosts that may be named over plain `http`, so a local runtime and browser tests can embed. */
const LOOPBACK_ORIGIN_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether `value` is a canonical origin a surface may be embedded from: `https://`, or `http://`
 * on a loopback host, written exactly as the browser sends it in `Origin` — so no path, query,
 * userinfo, default port, upper case or wildcard (issue #622).
 */
function isEmbeddingOrigin(value: string): boolean {
  if (value.includes('*') || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.origin !== value) return false;
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_ORIGIN_HOSTNAMES.has(url.hostname))
  );
}

/**
 * The origins a surface may be embedded and opened from (issue #622): 1–
 * {@link SURFACE_ALLOWED_ORIGINS_MAX} canonical origins, none repeated. The control plane derives
 * the page's `frame-ancestors`, the session route's `Origin` check and its CORS answer from it.
 */
export const SurfaceAllowedOriginsSchema = z
  .array(
    z
      .string()
      .max(2048, { abort: true })
      .refine(
        isEmbeddingOrigin,
        'must be an origin such as https://shop.example.com: https (http only on localhost, ' +
          '127.0.0.1 or [::1]), no path, no trailing slash, no wildcard',
      ),
  )
  .min(1)
  .max(SURFACE_ALLOWED_ORIGINS_MAX)
  .superRefine(refuseRepeats('repeats an earlier origin'))
  .readonly();

/**
 * A surface's abuse limits (issue #622). `turnsPerConversation` caps the turns one visitor session
 * may send; a surface with `allowedOrigins` and no cap of its own gets the control plane's default.
 */
export const SurfaceLimitsSchema = z
  .object({
    turnsPerConversation: z.int().min(1).max(SURFACE_TURNS_PER_CONVERSATION_MAX).optional(),
  })
  .strict()
  .readonly();
export type SurfaceLimits = z.infer<typeof SurfaceLimitsSchema>;

/**
 * One surface as code: what `defineSurface()` returns (C3) and what each entry of a version's
 * `surfaces` holds (ADR-0101). It accepts ADR-0108's rungs ① and ②, rung ② complete with
 * `toolResults` (SD10; issue #537), and the embedding keys `allowedOrigins` and `limits` (issue
 * #622); `audience` and any other key are refused by the strict object (issues #440, #537).
 */
export const SurfaceDefinitionSchema = z
  .object({
    /** The surface's name-key, the `<name>` of `/p/s/<name>`: lower-case kebab, 1–64 characters. */
    name: z
      .string()
      .max(SURFACE_NAME_MAX_LENGTH, { abort: true })
      .regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters'),
    /**
     * The agent the surface talks to, by name — the bound of `AgentDefinitionAgentSchema.name`
     * (1–`AGENT_NAME_MAX_LENGTH` characters, so names such as "Support triage" fit), on one line
     * with no control or invisible character and no space at either end.
     */
    agent: SurfaceAgentNameSchema,
    /**
     * The title the widget shows, in the surface-title grammar. It is not in ADR-0108's slice-1
     * list or in plan contract C4; it exists because S1-01's merged setup question
     * `embedder.surfaceTitle` writes `surfaces/main.ts`, and without this key that answer would be
     * accepted and ignored. ADR-0108's rung ① ("look") is read as covering it; the deviation is
     * recorded in this package's CHANGELOG and the unit's PR so ADR-0108 and C4 can name it.
     */
    title: SurfaceTitleSchema.optional(),
    theme: SurfaceThemeSchema.optional(),
    layout: SurfaceLayoutSchema.optional(),
    parts: SurfacePartsSchema.optional(),
    toolResults: SurfaceToolResultsSchema.optional(),
    allowedOrigins: SurfaceAllowedOriginsSchema.optional(),
    limits: SurfaceLimitsSchema.optional(),
  })
  .strict()
  .readonly();
/** A parsed surface definition (ADR-0108, ADR-0101; issue #440). */
export type SurfaceDefinition = z.infer<typeof SurfaceDefinitionSchema>;
/** What {@link SurfaceDefinitionSchema} accepts; equal to its output, since nothing transforms. */
export type SurfaceDefinitionInput = z.input<typeof SurfaceDefinitionSchema>;

/**
 * How long a hosted surface page's local session token lives, in seconds (ADR-0105 slice 1;
 * S1-17, issue #455). It is the browser-token ceiling (`BROWSER_TOKEN_MAX_TTL_SECONDS`), so a
 * conversation outlives the default five-minute token; the chat opens a new session once when it
 * expires.
 */
export const SURFACE_SESSION_TTL_SECONDS = 3600;

/**
 * A resume key: the base64url of 32 random bytes, 43 characters — the shape of a browser token's
 * secret half (ADR-0105, C18; issue #537).
 */
export const SURFACE_RESUME_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The body of `POST /p/s/<name>/sessions` (C18; issue #537): optionally the session to resume and
 * the key it was opened with, and optionally which offered agent to talk to. An absent body is the
 * server's concern (S2-05b); `{}` parses. A wrong key, another agent's session and an unknown
 * session all answer `surface_session_not_resumable`. `environment: 'local'` is sent by the try
 * page (`/p/s/<name>/try`), which always serves the `local` working draft; without it a session
 * serves `production`, or `local` until the agent is promoted (issue #612).
 */
export const SurfaceSessionRequestSchema = z
  .object({
    resume: z
      .object({
        sessionId: UuidSchema,
        resumeKey: z.string().regex(SURFACE_RESUME_KEY_PATTERN),
      })
      .strict()
      .readonly()
      .optional(),
    agent: SurfaceAgentNameSchema.optional(),
    environment: z.literal('local').optional(),
  })
  .strict()
  .readonly();
/** A parsed {@link SurfaceSessionRequestSchema} (C18; issue #537). */
export type SurfaceSessionRequest = z.infer<typeof SurfaceSessionRequestSchema>;

/**
 * The `201` of `POST /p/s/<name>/sessions`, the hosted surface page's local session bootstrap
 * (ADR-0105 slice 1; S1-17, issue #455): a browser token scoped to one new session of the agent
 * that serves the surface, that session's id, the agent's id and when the token expires. The
 * token is accepted only by the routes a session-scoped browser token already reaches.
 * `resumeKey` is carried once, when a session opens, so it is optional (C18; issue #537).
 */
export const SurfaceSessionResponseSchema = z
  .object({
    token: z.string().regex(BROWSER_TOKEN_PATTERN),
    sessionId: UuidSchema,
    agentId: UuidSchema,
    expiresAt: IsoDateTimeSchema,
    resumeKey: z.string().regex(SURFACE_RESUME_KEY_PATTERN).optional(),
  })
  .strict()
  .readonly();
/** A parsed {@link SurfaceSessionResponseSchema} (ADR-0105; S1-17, issue #455). */
export type SurfaceSessionResponse = z.infer<typeof SurfaceSessionResponseSchema>;

/**
 * The abuse-limit refusals of a surface's visitor (issue #622). `surface_rate_limited` answers a
 * session, turn or rating past its per-minute limit and carries `Retry-After`;
 * `surface_turn_limit_reached` answers a turn past `limits.turnsPerConversation` and is final for
 * that conversation. Turns answer them on `POST /api/agents/:id/runs`, ratings on
 * `POST /api/runs/:id/feedback`.
 */
export const SURFACE_LIMIT_PROBLEM_CODES = {
  surface_rate_limited: 429,
  surface_turn_limit_reached: 429,
} as const;
/** A key of {@link SURFACE_LIMIT_PROBLEM_CODES} (issue #622). */
export type SurfaceLimitProblemCode = keyof typeof SURFACE_LIMIT_PROBLEM_CODES;

/**
 * The problem codes `POST /p/s/<name>/sessions` answers with, and each one's HTTP status (ADR-0105
 * slice 1; S1-17, issue #455). `surface_sessions_unavailable` means the surface lists no
 * `allowedOrigins` and one of ADR-0105's four local conditions failed — the flag, a loopback
 * listen host, a loopback request host, a same-origin request — and is a `404` so a deployment
 * that does not serve local sessions looks like one with no such route.
 * `surface_origin_not_allowed` means the surface lists origins and the request came from none of
 * them, nor from this origin (issue #622). A refused first run names its missing piece with the
 * run-start codes. `surface_session_not_resumable` and `surface_agent_not_offered` refuse a resume
 * and an agent the surface does not offer (C18; issue #537).
 */
export const SURFACE_SESSION_PROBLEM_CODES = {
  surface_sessions_unavailable: 404,
  surface_origin_not_allowed: 403,
  surface_rate_limited: SURFACE_LIMIT_PROBLEM_CODES.surface_rate_limited,
  surface_not_found: 404,
  invalid_body: 400,
  surface_sessions_not_configured: 503,
  surface_session_not_resumable: 404,
  surface_agent_not_offered: 404,
  ...RUN_START_PROBLEM_CODES,
} as const;
/** A key of {@link SURFACE_SESSION_PROBLEM_CODES} (ADR-0105; S1-17, issue #455). */
export type SurfaceSessionProblemCode = keyof typeof SURFACE_SESSION_PROBLEM_CODES;

/** The most bytes one surface attachment upload may carry, 10 MiB (ADR-0146 D6). */
export { SURFACE_ATTACHMENT_MAX_BYTES };

/** The most files one visitor session may store through the upload route (ADR-0146 D6). */
export const SURFACE_ATTACHMENTS_MAX_FILES = 20;

/** The most bytes one visitor session may store through the upload route, 50 MiB (ADR-0146 D6). */
export const SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** The longest attachment file name, in UTF-8 bytes (ADR-0146 D2). */
export const SURFACE_ATTACHMENT_NAME_MAX_BYTES = 255;

/**
 * The `201` of `POST /api/sessions/:id/attachments` (ADR-0146 D6; issue #1308): the `fileId` to send
 * as `attachments: [{ fileId }]` on `runs.start`, the store path the agent will read it at, and the
 * stored size in bytes.
 */
export const SurfaceAttachmentResponseSchema = z
  .object({
    fileId: z.string().min(1),
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
/** A parsed {@link SurfaceAttachmentResponseSchema} (issue #1308). */
export type SurfaceAttachmentResponse = z.infer<typeof SurfaceAttachmentResponseSchema>;

/**
 * The problem codes `POST /api/sessions/:id/attachments` answers with, and each one's HTTP status
 * (ADR-0146 D6; issue #1308). `file_not_found` is also the answer for a session whose surface does
 * not offer attachments, so the route is not visible without the part. `request_body_too_large`
 * is the 10 MiB cap and `attachments_quota_exceeded` the per-session 20 files or 50 MiB.
 */
export const SURFACE_ATTACHMENT_PROBLEM_CODES = {
  file_not_found: 404,
  invalid_attachment_name: 400,
  request_body_too_large: 413,
  attachments_quota_exceeded: 413,
  surface_rate_limited: SURFACE_LIMIT_PROBLEM_CODES.surface_rate_limited,
} as const;
/** A key of {@link SURFACE_ATTACHMENT_PROBLEM_CODES} (issue #1308). */
export type SurfaceAttachmentProblemCode = keyof typeof SURFACE_ATTACHMENT_PROBLEM_CODES;
