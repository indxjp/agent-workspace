import { describe, expect, it } from 'vitest';

import {
  parseContainerIdleStopSeconds,
  parseDemoSettings,
  parseEmailLinkChallenge,
  parseEmailLinkBaseUrl,
  parseDemoSecret,
  parseEmailLinkSender,
  parseTrustedProxyHops,
  readWebSettings,
  SettingsError,
} from './settings';

/** The demo settings of an environment that sets none: the spec's two defaults, the rest unset. */
const UNSET_DEMO = {
  runsPerPersonPerDay: 20,
  runsPerClientPerDay: 60,
  maxTurnsPerRun: null,
  maxCostPerRunUsd: null,
  siteMaxCostPerDayUsd: null,
  leadRetentionDays: null,
};

describe('web settings (refactoring part 03)', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['  ', null],
    ['0', null],
    ['1', 1],
    [' 2 ', 2],
    ['16', 16],
  ])('accepts the proxy count %j as %j', (raw, value) => {
    expect(parseTrustedProxyHops(raw)).toEqual({ ok: true, value });
  });

  it.each(['several', '17', '-1', '1.5', '1e1', '0x2'])('refuses the proxy count %j', (raw) => {
    const parsed = parseTrustedProxyHops(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(`AW_TRUSTED_PROXY_HOPS is "${raw}"`);
  });

  it.each([
    [undefined, null],
    ['', null],
    ['  ', null],
    ['16', 16],
    ['900', 900],
  ])('accepts the idle stop %j as %j', (raw, value) => {
    expect(parseContainerIdleStopSeconds(raw)).toEqual({ ok: true, value });
  });

  it.each(['0', '15', '-900', '9.5', '1e3', 'soon'])('refuses the idle stop %j', (raw) => {
    const parsed = parseContainerIdleStopSeconds(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('above 15');
  });

  it('reads every setting from the environment', () => {
    expect(readWebSettings({})).toEqual({
      trustedProxyHops: null,
      containerIdleStopSeconds: null,
      emailLinkBaseUrl: null,
      emailLinkSender: null,
      emailLinkChallenge: null,
      demo: UNSET_DEMO,
      demoOperatorToken: null,
      demoAnthropicApiKey: null,
    });
    expect(
      readWebSettings({
        AW_TRUSTED_PROXY_HOPS: '1',
        AW_CONTAINER_IDLE_STOP_SECONDS: '900',
        AW_EMAIL_LINK_BASE_URL: 'https://store.example.test/signin',
        AW_EMAIL_LINK_SENDER: 'log',
        AW_EMAIL_LINK_CHALLENGE: 'fake',
        AW_DEMO_MAX_TURNS_PER_RUN: '12',
      }),
    ).toEqual({
      trustedProxyHops: 1,
      containerIdleStopSeconds: 900,
      emailLinkBaseUrl: 'https://store.example.test/signin',
      emailLinkSender: 'log',
      emailLinkChallenge: 'fake',
      demo: { ...UNSET_DEMO, maxTurnsPerRun: 12 },
      demoOperatorToken: null,
      demoAnthropicApiKey: null,
    });
  });

  it('reads the demo secrets, and refuses a short or spaced one without echoing it', () => {
    const token = 'o'.repeat(40);
    expect(
      readWebSettings({ AW_DEMO_OPERATOR_TOKEN: ` ${token} `, AW_DEMO_ANTHROPIC_API_KEY: '' }),
    ).toMatchObject({ demoOperatorToken: token, demoAnthropicApiKey: null });
    for (const raw of ['short-secret-value', `${'k'.repeat(20)} ${'k'.repeat(20)}`]) {
      const parsed = parseDemoSecret('AW_DEMO_ANTHROPIC_API_KEY', raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain('AW_DEMO_ANTHROPIC_API_KEY');
        expect(parsed.reason).not.toContain(raw);
      }
    }
  });

  it.each([
    [undefined, null],
    ['', null],
    [' https://store.example.test/signin ', 'https://store.example.test/signin'],
    ['http://localhost:3000/signin', 'http://localhost:3000/signin'],
  ])('accepts the link base URL %j as %j', (raw, value) => {
    expect(parseEmailLinkBaseUrl(raw)).toEqual({ ok: true, value });
  });

  it.each([
    'store.example.test/signin',
    'ftp://store.example.test/signin',
    'https://user:pw@store.example.test/signin',
    'https://store.example.test/signin?next=/',
    'https://store.example.test/signin#token',
  ])('refuses the link base URL %j', (raw) => {
    const parsed = parseEmailLinkBaseUrl(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('AW_EMAIL_LINK_BASE_URL is');
  });

  it('reads the sender name trimmed, or null when unset', () => {
    expect(parseEmailLinkSender(undefined)).toEqual({ ok: true, value: null });
    expect(parseEmailLinkSender('  ')).toEqual({ ok: true, value: null });
    expect(parseEmailLinkSender(' log ')).toEqual({ ok: true, value: 'log' });
  });

  it('names every refused variable in one error', () => {
    const read = () =>
      readWebSettings({ AW_TRUSTED_PROXY_HOPS: 'two', AW_CONTAINER_IDLE_STOP_SECONDS: '10' });
    expect(read).toThrow(SettingsError);
    expect(read).toThrow(/AW_TRUSTED_PROXY_HOPS is "two".*AW_CONTAINER_IDLE_STOP_SECONDS is "10"/u);
  });

  it('refuses one bad variable while the other is fine', () => {
    expect(() => readWebSettings({ AW_TRUSTED_PROXY_HOPS: 'two' })).toThrow(
      'AW_TRUSTED_PROXY_HOPS is "two"',
    );
    expect(() => readWebSettings({ AW_CONTAINER_IDLE_STOP_SECONDS: 'soon' })).toThrow(
      'AW_CONTAINER_IDLE_STOP_SECONDS is "soon"',
    );
  });
});

describe('the Agent Store demo settings (spec, "Abuse controls")', () => {
  it('reads the challenge adapter name trimmed, or null when unset', () => {
    expect(parseEmailLinkChallenge(undefined)).toEqual({ ok: true, value: null });
    expect(parseEmailLinkChallenge(' ')).toEqual({ ok: true, value: null });
    expect(parseEmailLinkChallenge(' fake ')).toEqual({ ok: true, value: 'fake' });
  });

  it('defaults the two counts the spec fixes and leaves the open amounts unset', () => {
    expect(parseDemoSettings({})).toEqual({ ok: true, value: UNSET_DEMO });
  });

  it('reads every amount from its variable', () => {
    expect(
      parseDemoSettings({
        AW_DEMO_RUNS_PER_PERSON_PER_DAY: '5',
        AW_DEMO_RUNS_PER_CLIENT_PER_DAY: ' 30 ',
        AW_DEMO_MAX_TURNS_PER_RUN: '10',
        AW_DEMO_MAX_COST_PER_RUN_USD: '0.5',
        AW_DEMO_SITE_MAX_COST_PER_DAY_USD: '25',
        AW_STORE_LEAD_RETENTION_DAYS: '365',
      }),
    ).toEqual({
      ok: true,
      value: {
        runsPerPersonPerDay: 5,
        runsPerClientPerDay: 30,
        maxTurnsPerRun: 10,
        maxCostPerRunUsd: 0.5,
        siteMaxCostPerDayUsd: 25,
        leadRetentionDays: 365,
      },
    });
  });

  it.each([
    ['AW_DEMO_RUNS_PER_PERSON_PER_DAY', '0'],
    ['AW_DEMO_RUNS_PER_CLIENT_PER_DAY', '1.5'],
    ['AW_DEMO_MAX_TURNS_PER_RUN', '-1'],
    ['AW_DEMO_MAX_COST_PER_RUN_USD', '0'],
    ['AW_DEMO_MAX_COST_PER_RUN_USD', '1e2'],
    ['AW_DEMO_SITE_MAX_COST_PER_DAY_USD', '100001'],
    ['AW_DEMO_SITE_MAX_COST_PER_DAY_USD', 'lots'],
    ['AW_STORE_LEAD_RETENTION_DAYS', '0'],
    ['AW_STORE_LEAD_RETENTION_DAYS', '3651'],
  ])('refuses %s=%j and stops start-up naming it', (name, raw) => {
    const parsed = parseDemoSettings({ [name]: raw });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(`${name} is "${raw}"`);
    expect(() => readWebSettings({ [name]: raw })).toThrow(SettingsError);
  });
});
