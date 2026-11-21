import { describe, expect, it } from 'vitest';

import {
  DEMO_FALLBACK_REASONS,
  DEMO_RUN_START_PROBLEM_CODES,
  DEMO_RUN_WINDOW_SECONDS,
  DEMO_RUNS_PER_CLIENT_PER_DAY,
  DEMO_RUNS_PER_PERSON_PER_DAY,
  DEMO_SEND_RESULT,
  DemoEntrySlugSchema,
  demoFallbackReason,
  DEMO_ALLOWANCE_PROBLEM_CODES,
  DemoAllowanceSchema,
  StorePrivacyFactsSchema,
  demoTemplateWorkspaceSlug,
} from './demo.js';
import { OUTPUT_SCHEMA_UNSATISFIED, RUN_BUDGET_REACHED, RUN_START_PROBLEM_CODES } from './runs.js';

describe('the demo caps', () => {
  it('pins the spec’s 20 runs per person and the 24-hour window', () => {
    expect(DEMO_RUNS_PER_PERSON_PER_DAY).toBe(20);
    expect(DEMO_RUN_WINDOW_SECONDS).toBe(86_400);
    expect(DEMO_RUNS_PER_CLIENT_PER_DAY).toBe(60);
  });

  it('answers each refusal with its status, and every one is a run-start code', () => {
    expect(DEMO_RUN_START_PROBLEM_CODES).toEqual({
      demo_person_runs_reached: 429,
      demo_client_runs_reached: 429,
      demo_site_cost_reached: 429,
      demo_caps_unconfigured: 503,
      demo_expired: 409,
    });
    for (const [code, status] of Object.entries(DEMO_RUN_START_PROBLEM_CODES)) {
      expect(RUN_START_PROBLEM_CODES).toHaveProperty(code, status);
    }
  });
});

describe('demoFallbackReason', () => {
  it('names a reason for every demo refusal and for the per-run caps', () => {
    expect(demoFallbackReason('demo_person_runs_reached')).toBe('count');
    expect(demoFallbackReason('demo_client_runs_reached')).toBe('load');
    expect(demoFallbackReason('demo_site_cost_reached')).toBe('cost');
    expect(demoFallbackReason('demo_caps_unconfigured')).toBe('unavailable');
    expect(demoFallbackReason('demo_expired')).toBe('unavailable');
    expect(demoFallbackReason(RUN_BUDGET_REACHED)).toBe('cost');
    expect(demoFallbackReason('max_turns')).toBe('count');
    expect(demoFallbackReason(OUTPUT_SCHEMA_UNSATISFIED)).toBe('format');
    for (const code of Object.keys(DEMO_RUN_START_PROBLEM_CODES)) {
      expect(DEMO_FALLBACK_REASONS).toContain(demoFallbackReason(code));
    }
  });

  it('names none for anything that is not a cap, inherited keys included', () => {
    for (const code of [
      'daily_cost_cap_reached',
      'model_unavailable',
      'toString',
      '__proto__',
      '',
    ]) {
      expect(demoFallbackReason(code)).toBeNull();
    }
  });
});

describe('the demo entry and its template', () => {
  it('accepts a catalog slug and names its template workspace', () => {
    expect(DemoEntrySlugSchema.parse('ringi-review')).toBe('ringi-review');
    expect(demoTemplateWorkspaceSlug('ringi-review')).toBe('demo-template-ringi-review');
  });

  it('refuses anything that is not a slug', () => {
    for (const value of ['Ringi', 'ringi_review', '-x', 'x-', '', 'a'.repeat(65)]) {
      expect(DemoEntrySlugSchema.safeParse(value).success).toBe(false);
    }
  });

  it('says in both languages that nothing was sent', () => {
    expect(DEMO_SEND_RESULT.en).toBe('Sent (demo only, nothing was actually sent)');
    expect(DEMO_SEND_RESULT.ja).toContain('デモ');
  });
});

describe('the demo allowance', () => {
  it('carries the runs per day, the runs left and the end of the demo workspace', () => {
    const allowance = { runsPerDay: 20, runsLeft: 18, expiresAt: '2026-11-17T09:00:00.000Z' };
    expect(DemoAllowanceSchema.parse(allowance)).toEqual(allowance);
    expect(DemoAllowanceSchema.safeParse({ ...allowance, runsLeft: 0 }).success).toBe(true);
  });

  it('refuses a negative or fractional count, a missing end and an extra field', () => {
    const allowance = { runsPerDay: 20, runsLeft: 18, expiresAt: '2026-11-17T09:00:00.000Z' };
    for (const body of [
      { ...allowance, runsLeft: -1 },
      { ...allowance, runsPerDay: 0 },
      { ...allowance, runsLeft: 1.5 },
      { runsPerDay: 20, runsLeft: 18 },
      { ...allowance, email: 'visitor@example.com' },
    ]) {
      expect(DemoAllowanceSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('pins each refusal to its status', () => {
    expect(DEMO_ALLOWANCE_PROBLEM_CODES).toEqual({
      unauthenticated: 401,
      demo_workspace_not_found: 404,
    });
  });
});

describe('the store privacy facts', () => {
  it('carries the lead retention period, or null while it is not decided', () => {
    for (const facts of [
      { leadRetentionDays: 365, demoWorkspaceHours: 24 },
      { leadRetentionDays: null, demoWorkspaceHours: 24 },
    ]) {
      expect(StorePrivacyFactsSchema.parse(facts)).toEqual(facts);
    }
  });

  it('refuses a period of zero days, a missing field and an extra field', () => {
    for (const body of [
      { leadRetentionDays: 0, demoWorkspaceHours: 24 },
      { demoWorkspaceHours: 24 },
      { leadRetentionDays: 30, demoWorkspaceHours: 24, contact: 'x' },
    ]) {
      expect(StorePrivacyFactsSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
