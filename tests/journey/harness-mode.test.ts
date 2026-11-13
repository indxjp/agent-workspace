import { failureOf, ROOT } from './harness-fixtures.js';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  JourneyFailure,
  assertNoChatFailure,
  firstTokenOf,
  journeyMode,
  splitFirstHour,
  runOf,
  scrubbedEvidence,
  sessionTokenOf,
  stubExpectation,
} from './harness.mjs';

it('runs the fake by default, and --live only with a non-blank ANTHROPIC_API_KEY', () => {
  expect(journeyMode([], {})).toEqual({ live: false });
  expect(journeyMode(['--live'], { ANTHROPIC_API_KEY: ' sk-ant-x ' })).toEqual({
    live: true,
    apiKey: 'sk-ant-x',
  });
  const missing =
    '--live needs ANTHROPIC_API_KEY: an Owner must add the repository secret ANTHROPIC_API_KEY';
  expect(failureOf(() => journeyMode(['--live'], {})).message).toBe(missing);
  expect(failureOf(() => journeyMode(['--live'], { ANTHROPIC_API_KEY: '  ' })).message).toBe(
    missing,
  );
});

it('splits --first-hour off, alone and with --live, before journeyMode sees the rest', () => {
  expect(splitFirstHour(['--first-hour'])).toEqual({ firstHour: true, rest: [] });
  expect(splitFirstHour(['--first-hour', '--live'])).toEqual({
    firstHour: true,
    rest: ['--live'],
  });
  expect(splitFirstHour(['--live'])).toEqual({ firstHour: false, rest: ['--live'] });
  expect(failureOf(() => journeyMode(['--first-hour'], {})).message).toMatch(/^usage: /u);
});

it('refuses any other argument', () => {
  expect(failureOf(() => journeyMode(['--fake'], {})).message).toMatch(
    /^usage: node tests\/journey\/run\.mjs \[--live\] \(/u,
  );
  expect(failureOf(() => journeyMode(['live'], {})).message).toMatch(/^usage: /u);
});

it('reads the one first-token line a widget test prints, in seconds', () => {
  expect(firstTokenOf('  ✓  1 [chromium] …\njourney-first-token-ms 2345\r\n  1 passed\n')).toBe(
    2.3,
  );
  const none = 'the widget test printed 0 journey-first-token-ms lines, not one';
  expect(failureOf(() => firstTokenOf('1 passed\n')).message).toBe(none);
  expect(failureOf(() => firstTokenOf('journey-first-token-ms soon\n')).message).toBe(none);
  expect(
    failureOf(() => firstTokenOf('journey-first-token-ms 1\njourney-first-token-ms 2\n')).message,
  ).toBe('the widget test printed 2 journey-first-token-ms lines, not one');
});

it('reads a run and a session token only from the shapes the API answers', () => {
  expect(runOf({ run: { id: 'r1', status: 'completed', engine: 'pi' } }, 'GET')).toEqual({
    id: 'r1',
    status: 'completed',
  });
  for (const body of [null, {}, { run: null }, { run: { id: 'r1' } }, { id: 'r1', status: 'x' }]) {
    expect(failureOf(() => runOf(body, 'the run start')).message).toBe(
      'the run start answered no run',
    );
  }
  expect(sessionTokenOf({ token: 'awb_x', sessionId: 's' })).toBe('awb_x');
  for (const body of [null, {}, { token: '' }, { token: 1 }]) {
    expect(failureOf(() => sessionTokenOf(body)).message).toBe(
      'POST /p/s/main/sessions answered no token',
    );
  }
});

// Regressions (CI runs 37141361195 and 37143036089): the local driver's notice and Next's empty
// route-announcer live region are alerts, not a turn's failure. The fake answers every alert
// whatever the selector: the worst case of a selector that matches too much.
it('fails on a failed turn, never on an empty live region or the local driver notice', async () => {
  const selectors: string[] = [];
  const chatWith = (...alerts: { testid: string | null; text: string }[]) => ({
    locator: (selector: string) => {
      selectors.push(selector);
      return {
        all: () =>
          Promise.resolve(
            alerts.map(({ testid, text }) => ({
              getAttribute: () => Promise.resolve(testid),
              innerText: () => Promise.resolve(text),
            })),
          ),
      };
    },
  });
  const notice = {
    testid: 'driver-in-force',
    text: 'Runtime driver in force: local — No tenant isolation: commands run as the host user',
  };
  const announcer = { testid: null, text: '' };
  await expect(assertNoChatFailure(chatWith())).resolves.toBeUndefined();
  // (a) an empty role=alert live region beside a successful answer
  await expect(assertNoChatFailure(chatWith(announcer))).resolves.toBeUndefined();
  await expect(assertNoChatFailure(chatWith({ testid: null, text: ' \n ' }))).resolves.toBe(
    undefined,
  );
  // (b) the local driver's notice beside a successful answer
  await expect(assertNoChatFailure(chatWith(notice, announcer))).resolves.toBeUndefined();
  // (c) a failed turn, reported with its text
  await expect(
    assertNoChatFailure(chatWith(announcer, notice, { testid: null, text: ' run_failed: boom ' })),
  ).rejects.toThrow(new JourneyFailure('the chat shows a failure: run_failed: boom'));
  // Only surface-chat.tsx's failure element, the alert after the messages, is read.
  expect(new Set(selectors)).toEqual(new Set(['ol[aria-live="polite"] ~ [role="alert"]']));
});

it("asks for the fake's wording in stub mode only", () => {
  expect(stubExpectation(false, 'order-data-n1')).toEqual({
    JOURNEY_EXPECT_TEXT: 'order-data-n1',
  });
  expect(stubExpectation(true, 'order-data-n1')).toEqual({});
});

it('redacts every secret from copied evidence, and drops a binary file it cannot redact', () => {
  const secrets = new Set(['sk-ant-live', '']);
  const json = Buffer.from('{"key":"sk-ant-live","again":"sk-ant-live"}');
  expect(scrubbedEvidence(json, secrets)?.toString()).toBe(
    '{"key":"<fake key>","again":"<fake key>"}',
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
  expect(scrubbedEvidence(png, secrets)).toBe(png);
  expect(scrubbedEvidence(Buffer.concat([png, Buffer.from('sk-ant-live')]), secrets)).toBeNull();
});

it('keeps the live journey out of the required checks, and refuses a missing secret first', () => {
  const live = readFileSync(path.join(ROOT, '.github', 'workflows', 'journey-live.yml'), 'utf8');
  const ci = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  expect(ci).not.toContain('--live');
  expect(ci).not.toContain('journey-live');
  const steps = [...live.matchAll(/^ {6}- name: (.+)$/gmu)].map((match) => match[1]);
  expect(steps[0]).toBe('Refuse a missing live-model secret');
  expect(live).toContain('::error title=Missing secret ANTHROPIC_API_KEY::');
  expect(live).toContain('run: node tests/journey/run.mjs --live');
  expect(live).toMatch(/^ {4}- cron: /mu);
  expect(live).toMatch(/^ {2}workflow_dispatch:$/mu);
  expect(live).toContain('run: node tests/journey/run.mjs --first-hour --live');
  const secretReferences = /\$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/gu;
  // The key reaches only the step that refuses it and the two steps that run a journey.
  const [journeyJob = '', liveLane = ''] = live.split(/^ {2}platforms-live-managed-agents:$/mu);
  expect(journeyJob.match(secretReferences)).toHaveLength(3);
  // Issue #979: the live Managed Agents lane likewise reads it in its refusal step and its lane step.
  expect(liveLane.match(secretReferences)).toHaveLength(2);
  expect(live).not.toMatch(/^ {4}env:/mu);
});
