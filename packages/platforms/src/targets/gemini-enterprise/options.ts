import { z } from 'zod';

/** An origin and nothing else: no path, query, fragment or credentials. */
function isOriginOnly(value: string): boolean {
  const url = new URL(value);
  return (
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/** `extensions.platforms['gemini-enterprise']` of the root agent. */
export const GeminiEnterpriseOptionsSchema = z.strictObject({
  /** GCP project id that owns the Gemini Enterprise app. */
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  /** Gemini Enterprise app location; `global | us | eu` per the register page (2026-10-11). */
  location: z.enum(['global', 'us', 'eu']),
  /** The Gemini Enterprise app id (APP_ID in the REST path). */
  engineId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  /** https origin of the Agent Workspace deployment that serves the A2A endpoint (no path). */
  publicBaseUrl: z
    .url({ protocol: /^https$/u, abort: true })
    .refine(isOriginOnly, 'must be an https origin without a path, query, fragment or credentials'),
  /** Shown in Gemini Enterprise; default = the agent's `name`. */
  displayName: z.string().min(1).max(128).optional(),
  /** Card `version`. */
  agentVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/u)
    .default('1.0.0'),
  /** Id of an existing Gemini Enterprise authorization resource (OAuth), if any. */
  authorizationId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u)
    .optional(),
  /** Example prompts advertised on the card's skill, at most 10. */
  examples: z.array(z.string().min(1).max(500)).max(10).optional(),
});
export type GeminiEnterpriseOptions = z.output<typeof GeminiEnterpriseOptionsSchema>;
