// Scripted checks of the live Cloud Run preview's own-failure-handling steps: each step's bash is
// run against stand-in tools (gcloud, curl) under the default `bash -e` of a workflow step.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  allSteps,
  previewJobStep,
  runWithTools,
  script,
  step,
} from './workflow-cloud-run-preview.test-support.js';

const RUN_BLOCK = '        run: |\n';

/** What a run of the IAM probe's read loop left behind. */
interface ReadLoopOutcome {
  readonly status: number | null;
  readonly reached: boolean;
  readonly calls: number;
  readonly result: string;
  readonly failed: string;
}

// Run 42577620759: the default shell of a step is `bash -e`, which `set -uo pipefail` does not lift.
// The IAM probe's log read (a grep that matched no line before the log was ingested) ended the step
// with exit 1 and no message, before its 9-attempt wait and its probe_failed marker.
describe('the live preview steps that handle their own failures', () => {
  it('lifts -e in every step that never fails itself or reads PIPESTATUS', () => {
    const handled = allSteps().filter((text) => {
      if (!text.includes(RUN_BLOCK)) return false;
      const body = script(text).trimEnd();
      return body.endsWith('\nexit 0') || body.includes('PIPESTATUS');
    });
    expect(handled.length).toBeGreaterThan(5);
    const unlifted = handled
      .filter((text) => !/^set \+e$/mu.test(script(text)))
      .map((text) => text.split('\n')[0]);
    expect(unlifted).toEqual([]);
  });
});

const probe = script(step("Probe the runner manager's IAM condition"));
const nonce = '42-1-iam-0123456789abcdef';
const resultFile = 'cat "$ev/iam-condition.json"\n';

/** A gcloud that prints the result line from call number `lineOn` on, counting its calls. */
function fakeGcloud(temp: string, lineOn: number): string {
  const line = `AW_IAM_PROBE {"mode":"iam","nonce":"${nonce}","positiveControl":200}`;
  return [
    '#!/usr/bin/env bash',
    `count=$(( $(cat "${temp}/calls" 2>/dev/null || echo 0) + 1 ))`,
    `echo "$count" > "${temp}/calls"`,
    'echo "Starting execution"',
    `if [ "$count" -ge ${lineOn} ]; then echo '${line}'; fi`,
    '',
  ].join('\n');
}

/** The step's prologue, its failure marker and its read loop, as one script. */
function loopScript(ev: string): string {
  // The shell options the step sets before its first variable.
  const prologue = probe.slice(0, probe.indexOf('\nev="$EVIDENCE_DIR"\n'));
  const failedLine = probe.split('\n').find((line) => line.startsWith('probe_failed() {'));
  const from = probe.indexOf('filter="resource.type=\\"cloud_run_job\\"');
  const to = probe.indexOf(resultFile);
  expect(prologue).toContain('set -uo pipefail');
  expect(failedLine).toBeDefined();
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return [
    prologue,
    'sleep() { :; }',
    `ev="${ev}"`,
    'job=aw-test-iam-probe',
    `nonce=${nonce}`,
    failedLine ?? '',
    probe.slice(from, to + resultFile.length),
    'echo reached-the-end',
  ].join('\n');
}

/** The step's prologue and read loop under `bash -e`, with a gcloud that prints the line on call `lineOn`. */
function readLoop(lineOn: number): ReadLoopOutcome {
  const temp = mkdtempSync(path.join(tmpdir(), 'iam-read-'));
  try {
    const bin = path.join(temp, 'bin');
    const ev = path.join(temp, 'evidence');
    execFileSync('mkdir', ['-p', bin, ev]);
    writeFileSync(path.join(bin, 'gcloud'), fakeGcloud(temp, lineOn), { mode: 0o755 });
    const run = spawnSync('bash', ['-e', '-c', loopScript(ev)], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, GCP_PROJECT: 'example-project' },
    });
    const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
    return {
      status: run.status,
      reached: run.stdout.includes('reached-the-end'),
      calls: Number(read(path.join(temp, 'calls'))),
      result: read(path.join(ev, 'iam-condition.json')),
      failed: read(path.join(ev, 'iam-probe-failed')),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe("the IAM probe's wait for its result line", () => {
  it('waits through reads with no result line and keeps the line of the third', () => {
    const outcome = readLoop(3);
    expect(outcome.status).toBe(0);
    expect(outcome.reached).toBe(true);
    expect(outcome.calls).toBe(3);
    expect(JSON.parse(outcome.result)).toEqual({
      mode: 'iam',
      nonce,
      positiveControl: 200,
    });
    expect(outcome.failed).toBe('');
  });

  it('marks the probe failed, with its reason, when no line is ingested in 9 reads', () => {
    const outcome = readLoop(99);
    expect(outcome.status).toBe(0);
    expect(outcome.calls).toBe(9);
    expect(outcome.result).toBe('');
    expect(outcome.failed).toBe(`no IAM probe result line with nonce ${nonce} was ingested`);
  });
});

function digest(hex: string): string {
  return `sha256:${hex.repeat(64)}`;
}

// Run 42674364781: gcloud's ';'-joined image list was piped to `read` without a final newline, so
// the last image was dropped: the runner manager, whose only container is its platform image,
// "had no platform container image", and web's Cloud SQL proxy went unrecorded.
const body = script(previewJobStep('Require the services to run the copied digests'));
const registry = 'asia-northeast1-docker.pkg.dev/example-project/aw-byoc-1-staging';
const proxy = 'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.0';
const built = { web: digest('a'), gateway: digest('b'), runner: digest('c') };
const gcloud = [
  '#!/usr/bin/env bash',
  // gcloud run services describe <service> …: the service is the fourth argument.
  'cat "$RUNNER_TEMP/images/$4"',
  '',
].join('\n');

/** Writes the build metadata, the described images and the deploy log the step reads. */
function prepareDigestCheck(temp: string, images: Readonly<Record<string, string>>): void {
  execFileSync('mkdir', ['-p', path.join(temp, 'meta'), path.join(temp, 'images')]);
  for (const [name, value] of Object.entries(built)) {
    writeFileSync(
      path.join(temp, 'meta', `${name}.json`),
      JSON.stringify({ 'containerimage.digest': value }),
    );
  }
  for (const [service, value] of Object.entries(images)) {
    writeFileSync(path.join(temp, 'images', service), `${value}\n`);
  }
  writeFileSync(
    path.join(temp, 'evidence', 'deploy-first.log'),
    'AW_WEB_IMAGE overrides the pinned release image\n',
  );
}

/** The step against a gcloud that describes each service with the `;`-joined `images`. */
function check(images: Readonly<Record<string, string>>): ReturnType<typeof runWithTools> {
  return runWithTools({
    body,
    tools: { gcloud },
    env: {},
    prepare: (temp) => {
      prepareDigestCheck(temp, images);
    },
  });
}

const deployed = {
  'aw-byoc-1-web': `${registry}/web@${built.web};${proxy}`,
  'aw-byoc-1-gateway': `${registry}/gateway@${built.gateway};${proxy}`,
  'aw-byoc-1-runner-mgr': `${registry}/runner@${built.runner}`,
};

describe('the live preview check that the services run the copied digests', () => {
  it("passes the live shape: the runner manager's one container and each proxy listed last", () => {
    const outcome = check(deployed);
    expect(outcome.stdout).not.toContain('::error::');
    expect(outcome.status).toBe(0);
    expect(outcome.evidence).toContain(
      `image_aw-byoc-1-runner-mgr=${registry}/runner@${built.runner}`,
    );
    expect(outcome.evidence).toContain(`third_party_image_aw-byoc-1-web=${proxy}`);
    expect(outcome.evidence).toContain(`third_party_image_aw-byoc-1-gateway=${proxy}`);
    expect(outcome.evidence).toContain('result=pass');
  });

  it.each([
    [
      'a digest other than the build',
      { 'aw-byoc-1-runner-mgr': `${registry}/runner@${digest('d')}` },
      `aw-byoc-1-runner-mgr runs ${digest('d')} but the build of runner produced ${built.runner}`,
    ],
    [
      'an image pinned by tag',
      { 'aw-byoc-1-web': `${registry}/web:latest;${proxy}` },
      `aw-byoc-1-web runs '${registry}/web:latest', which is not an Artifact Registry image pinned by digest`,
    ],
    [
      'an image outside the project registry',
      { 'aw-byoc-1-gateway': `ghcr.io/example/gateway@${built.gateway};${proxy}` },
      'which is not an Artifact Registry image pinned by digest',
    ],
    [
      'a proxy-named image from another registry',
      { 'aw-byoc-1-gateway': `${registry}/gateway@${built.gateway};docker.io/x/cloud-sql-proxy:1` },
      "aw-byoc-1-gateway runs 'docker.io/x/cloud-sql-proxy:1'",
    ],
    ['only the proxy', { 'aw-byoc-1-web': proxy }, 'aw-byoc-1-web has no platform container image'],
  ])('fails on %s', (_name, change, error) => {
    const outcome = check({ ...deployed, ...change });
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain(error);
    expect(outcome.evidence).toContain('result=fail');
  });
});

// Run 42674364781: web sent the deterministic run.app URL as its redirect URI while web_url (and so
// GCP_LIVE_BASE_URL) was the service's <hash>-<region code>.a.run.app URL.
const shape = script(previewJobStep('Assert the private shape'));
const from = shape.indexOf('# (c) ');
const to = shape.indexOf('echo "result=');
const base = 'https://aw-byoc-1-web-123456789012.asia-northeast1.run.app';

/** Section (c) of the step as a script of its own. */
function loginSection(): string {
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return [
    'set -euo pipefail',
    'out="$EVIDENCE_DIR/private-shape.txt"',
    'fail=0',
    shape.slice(from, to),
    'echo "result=$([ "$fail" -eq 0 ] && echo pass || echo fail)" >> "$out"',
    'exit "$fail"',
  ].join('\n');
}

/** Section (c) of the step against a curl answering /api/auth/login with `location`. */
function login(baseUrl: string, location: string): ReturnType<typeof runWithTools> {
  const curl = [
    '#!/usr/bin/env bash',
    `printf 'HTTP/2 303\\r\\nlocation: %s\\r\\n\\r\\n' '${location}' > headers.txt`,
    '',
  ].join('\n');
  return runWithTools({
    body: loginSection(),
    tools: { curl },
    env: { GCP_LIVE_BASE_URL: baseUrl },
    prepare: () => undefined,
  });
}

const google = (redirect: string): string =>
  `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(redirect)}&scope=openid&client_id=aw-byoc-live-test.apps.googleusercontent.com&response_type=code`;

describe('the live preview check of the single sign-on redirect URI', () => {
  it('passes when the redirect URI is exactly the callback on the deterministic web_url', () => {
    const outcome = login(base, google(`${base}/api/auth/callback`));
    expect(outcome.stdout).not.toContain('::error::');
    expect(outcome.status).toBe(0);
    expect(outcome.evidence).toContain(`login_redirect_uri=${base}/api/auth/callback`);
  });

  it('fails when web_url is the hash URL the redirect URI is not built on', () => {
    const hashUrl = 'https://aw-byoc-1-web-abc123def-an.a.run.app';
    const outcome = login(hashUrl, google(`${base}/api/auth/callback`));
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain(`web_url is '${hashUrl}', not the deterministic`);
    expect(outcome.stdout).toContain(`(want exactly ${hashUrl}/api/auth/callback)`);
  });

  it('fails on a redirect URI that only starts with the callback', () => {
    const outcome = login(base, google(`${base}/api/auth/callback/extra`));
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain(`(want exactly ${base}/api/auth/callback)`);
  });
});
