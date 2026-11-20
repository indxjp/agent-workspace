// The live Cloud Run preview workflow (issue #2112). This file holds the checks of its evidence
// and diagnostic steps; the images, the destroy and the scripted probes have their own files
// (workflow-cloud-run-preview-*.test.ts), sharing workflow-cloud-run-preview.test-support.ts.
import { describe, expect, it } from 'vitest';

import {
  AFTER_DEPLOY,
  jobText,
  previewJobStep,
  script,
  step,
} from './workflow-cloud-run-preview.test-support.js';

const IF_PREFIX = '        if: ';
const JOURNEY = 'Validate the authenticated stack in Chromium';
const ASSERT_PRIVATE_SHAPE_CONDITION =
  "if: ${{ !cancelled() && inputs.action != 'destroy' && steps.deploy.outcome == 'success' && steps.live-config.outcome == 'success' }}";

// Run 42631986555: the browser journey failed only on a Vertex AI 429 (quota 0, an Owner item), and
// the evidence steps after it were skipped although none of them reads the journey's outcome. They
// run once the deploy succeeded, whatever an earlier check did, and still fail the job themselves.
describe('the live preview evidence steps after the browser journey', () => {
  const names = [...jobText('preview').matchAll(/^ {6}- name: (.+)$/gmu)].map(
    (match) => match[1] ?? '',
  );

  it('names the deploy and the live configuration steps the conditions read', () => {
    expect(previewJobStep('Deploy from empty state')).toMatch(/^ {8}id: deploy$/mu);
    expect(previewJobStep('Load masked live configuration')).toMatch(/^ {8}id: live-config$/mu);
  });

  it.each([
    ['Require that model traffic reached Vertex AI and never api.anthropic.com', AFTER_DEPLOY],
    ['Assert the private shape', ASSERT_PRIVATE_SHAPE_CONDITION],
    ['Require the services to run the copied digests', AFTER_DEPLOY],
  ])('runs "%s" after a failed journey once the deploy succeeded', (name, condition) => {
    expect(names.indexOf(name)).toBeGreaterThan(names.indexOf(JOURNEY));
    const text = previewJobStep(name);
    expect(text.split('\n').filter((line) => line.startsWith(IF_PREFIX))).toEqual([
      `        ${condition}`,
    ]);
    expect(text).toContain('set -euo pipefail');
    expect(text).not.toMatch(/^ {10}set \+e$/mu);
    expect(text).toMatch(/exit (1|"\$fail")/u);
  });

  it('requires the deployed services to run the pinned digests, read-only, after the private shape', () => {
    const copied = 'Require the services to run the copied digests';
    const at = names.indexOf(copied);
    expect(at).toBeGreaterThan(names.indexOf('Assert the private shape'));
    expect(at).toBeLessThan(names.indexOf('Record the service logs of a failed check'));
    expect(names.filter((name) => name === names[at])).toHaveLength(1);
    const gate = step(copied);
    expect(gate).toContain(AFTER_DEPLOY);
    expect(gate).toContain('overrides the pinned release image');
    expect(gate).toContain('gcloud run services describe');
    expect(gate).toContain('pinned-images.txt');
    expect(gate).toContain('result=$([ "$fail" -eq 0 ] && echo pass || echo fail)');
    expect(gate).not.toMatch(/gcloud run services (update|deploy|delete)/u);
  });

  it('leaves no step between the journey and the failure diagnostics on the bare destroy guard', () => {
    const from = names.indexOf(JOURNEY);
    const to = names.indexOf('Record the service logs of a failed check');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from + 1);
    for (const name of names.slice(from + 1, to)) {
      expect(previewJobStep(name)).not.toMatch(/^ {8}if: inputs\.action != 'destroy'$/mu);
    }
  });
});

// Run 42475089040: an app role job exited 3 (psql's script error) and the run kept none of its
// logs, so the cause had to be found statically.
describe('the live preview diagnostics of a failed deploy', () => {
  const record = step('Record the app role job runs of a failed deploy');

  it('runs in the preview job only when the deploy failed, before the stack is checked', () => {
    const text = jobText('preview');
    const deploy = text.indexOf('      - name: Deploy from empty state\n');
    const at = text.indexOf('      - name: Record the app role job runs of a failed deploy\n');
    const status = text.indexOf('      - name: Report the stack status\n');
    expect(deploy).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(deploy);
    expect(status).toBeGreaterThan(at);
    expect(record).toContain("if: failure() && inputs.action != 'destroy'");
  });

  it("prints the role jobs' last executions and at most 100 log lines, and never fails", () => {
    expect(record).toContain('grep -E "^${PREFIX}-r-[0-9a-f]{5}$"');
    expect(record).toContain('gcloud run jobs executions list --job "$job"');
    expect(record).toContain(
      'filter="resource.type=\\"cloud_run_job\\" AND resource.labels.job_name=~\\"^${PREFIX}-r-\\""',
    );
    expect(record).toContain('gcloud logging read "$filter"');
    expect(record).toContain('--limit=100');
    expect(record).toContain('tail -n 100 "$out.tmp"');
    expect(record).toContain('set +e');
    expect(record.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('prints no secret: no job description, environment or secret value, and no line naming one', () => {
    const commands = record
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(commands).not.toMatch(/jobs describe|executions describe|--format=export/u);
    expect(commands).not.toMatch(/secrets versions access|\.env\b|containers\[/u);
    expect(commands).toContain("grep -viE 'password|secret|token|authorization'");
  });
});

// Run 42577620759: the tool-call job had no project, so the probe tool never tried its sandbox's
// metadata token and `tool-metadata-token` was inconclusive.
describe('the live preview tool lane', () => {
  it('gives the tool-call job the project and region, so the tool tries its metadata token', () => {
    const proof = script(step('Prove a none sandbox has no internet'));
    const env = /env_file "\$RUNNER_TEMP\/iso-tool-call\.env\.yaml"(?:[^\n]*\\\n)*[^\n]*\n/u.exec(
      proof,
    )?.[0];
    expect(env).toBeDefined();
    expect(env).toContain('"GCP_PROJECT=$GCP_PROJECT"');
    expect(env).toContain('"GCP_REGION=$GCP_REGION"');
  });
});
