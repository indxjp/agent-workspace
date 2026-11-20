// The live Cloud Run preview's destroy (issue #2112): it must skip a stack that was never applied,
// always delete the staging repository, retry what Google Cloud releases late, and be followed by a
// leftovers gate. Run 42525921402: the sandbox-internet destroy's last attempt failed on the
// runner's network (`connect: no route to host`), and the loop, which retried only a held network,
// gave up and left the VPC and its two subnets.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PREVIEW,
  ROOT,
  jobText,
  script,
  step,
  steps,
} from './workflow-cloud-run-preview.test-support.js';

const STAGES = ['preview', 'sandbox-internet'];
const STEP_PREFIX = '      - name: ';

/** Whether `needles` occur in `text` in the given order, all present. */
function inOrder(text: string, needles: string[]): boolean {
  const order = needles.map((needle) => text.indexOf(needle));
  return (
    order.every((at) => at >= 0) && order.every((at, i) => i === 0 || at >= (order[i - 1] ?? 0))
  );
}

/** The text of the "Destroy the stack" step of `job`. */
function destroyStep(job: string): string {
  const text = jobText(job);
  const at = text.indexOf(`${STEP_PREFIX}Destroy the stack\n`);
  return text.slice(at, text.indexOf(`\n${STEP_PREFIX}`, at + 1));
}

/** The value of the single-quoted shell assignment `name='...'` in `text`. */
function assigned(text: string, name: string): string {
  const found = new RegExp(`\n\\s+${name}='([^']*)'\n`, 'u').exec(text);
  if (found?.[1] === undefined) throw new Error(`no ${name}='...' in the destroy step`);
  return found[1];
}

function matches(pattern: string, line: string): boolean {
  return spawnSync('grep', ['-Eq', pattern], { input: `${line}\n` }).status === 0;
}

describe('the live preview destroy order', () => {
  it('names no app in a destroy-only run, which builds no image', () => {
    const write = steps('Write the project file')[0] ?? '';
    expect(write).toMatch(
      /if \[ "\$ACTION" != destroy \]; then\n\s+cat >> agent-workspace\.yaml <<YAML\n[\s\S]*image: \$APP_IMAGE/u,
    );
  });

  it.each(STAGES)(
    'in %s, finds the state before it rebuilds, and destroys before listing',
    (job) => {
      const text = jobText(job);
      const find = text.indexOf(`${STEP_PREFIX}Find the Terraform state of the prefix\n`);
      const rebuild = text.indexOf(
        `${STEP_PREFIX}Rebuild the deployment state of the earlier run\n`,
      );
      const destroyAt = text.indexOf(`${STEP_PREFIX}Destroy the stack\n`);
      const left = text.indexOf(`${STEP_PREFIX}List `, destroyAt);
      expect(find).toBeGreaterThan(0);
      expect(find).toBeLessThan(rebuild);
      expect(rebuild).toBeLessThan(destroyAt);
      expect(destroyAt).toBeLessThan(left);
      const findStep = text.slice(find, rebuild);
      expect(findStep).toContain("if: always() && inputs.action != 'apply'");
      expect(findStep).toContain(
        'gs://${GCP_PROJECT}-aw-tfstate/agent-workspace/${PREFIX}/production/',
      );
      expect(findStep).toContain('echo "PREFIX_STATE=$state" >> "$GITHUB_ENV"');
      expect(text.slice(rebuild, rebuild + 200)).toContain(
        "if: inputs.action == 'destroy' && env.PREFIX_STATE == 'present'",
      );
    },
  );

  it.each(STAGES)(
    'in %s, skips a stack never applied and always deletes the staging repository',
    (job) => {
      const destroy = destroyStep(job);
      expect(destroy).toContain("if: always() && inputs.action != 'apply'");
      expect(
        inOrder(destroy, [
          'set +e',
          'if [ "${PREFIX_STATE:-present}" = absent ]; then',
          'elif [ ! -f agent-workspace.yaml ]; then',
          'aw deploy destroy production',
          'gcloud artifacts repositories delete "${PREFIX}-staging"',
          'exit "$status"',
        ]),
      ).toBe(true);
      // Nothing between the start and the staging deletion ends the step early.
      const beforeDelete = destroy.slice(
        0,
        destroy.indexOf('gcloud artifacts repositories delete'),
      );
      expect(beforeDelete).not.toMatch(/\bexit\b/u);
      // The one exit is the last line, with destroy's status.
      expect(destroy.trimEnd().endsWith('exit "$status"')).toBe(true);
    },
  );
});

describe('the live preview destroy retries', () => {
  const heldNetwork =
    'Google Cloud releases the network 1–2 hours after its services are deleted; everything else is gone.';
  const transientErrors = [
    'Error when reading or editing Subnetwork: Delete "https://compute.googleapis.com/compute/v1/projects/p/regions/r/subnetworks/aw-si-1-services?alt=json": dial tcp 142.250.21.95:443: connect: no route to host',
    'dial tcp 142.250.21.95:443: connect: connection refused',
    'read tcp 10.0.0.2:5555->142.250.21.95:443: read: connection reset by peer',
    'dial tcp 142.250.21.95:443: i/o timeout',
    'net/http: TLS handshake timeout',
    'Error waiting for Deleting Network: googleapi: Error 503: The service is currently unavailable., backendError',
    'googleapi: got HTTP response code 502 with body: <html>',
  ];
  const permanentErrors = [
    'googleapi: Error 403: Required permission compute.networks.delete, forbidden',
    'googleapi: Error 400: The network resource is already being used by firewall',
    'Error acquiring the state lock',
    'Error: Invalid value for variable',
  ];

  it.each(STAGES)('in %s, uses the patterns of the preview job', (job) => {
    const destroy = destroyStep(job);
    expect(assigned(destroy, 'held')).toBe(assigned(destroyStep('preview'), 'held'));
    expect(assigned(destroy, 'transient')).toBe(assigned(destroyStep('preview'), 'transient'));
  });

  it.each(STAGES)('in %s, retries a held network and a transient network error', (job) => {
    const held = assigned(destroyStep(job), 'held');
    const transient = assigned(destroyStep(job), 'transient');
    expect(matches(held, heldNetwork)).toBe(true);
    for (const line of transientErrors) expect(matches(transient, line), line).toBe(true);
    for (const line of permanentErrors) {
      expect(matches(held, line) || matches(transient, line), line).toBe(false);
    }
  });

  it.each(STAGES)('in %s, retries within one 150-minute budget', (job) => {
    const destroy = destroyStep(job);
    expect(
      inOrder(destroy, [
        'start=$(date +%s)',
        'aw deploy destroy production',
        'if [ "$status" -eq 0 ]; then break; fi',
        'if grep -Eq "$held" "$attempt"; then wait_seconds=600;',
        'elif grep -Eq "$transient" "$attempt"; then wait_seconds=60;',
        'else break; fi',
        'if [ $(( $(date +%s) - start )) -ge 9000 ]; then',
        'sleep "$wait_seconds"',
      ]),
    ).toBe(true);
    // One budget: the clock starts once, before the loop.
    expect(destroy.split('start=$(date +%s)')).toHaveLength(2);
  });
});

/** The inputs of the sandbox-internet naming step. */
interface NamingInputs {
  readonly run?: string;
  readonly si?: string;
}

/** Runs the sandbox-internet job's naming step; its PREFIX, or its error. */
function nameSandboxInternet(inputs: NamingInputs): string {
  const text = jobText('sandbox-internet');
  const at = text.indexOf(
    `${STEP_PREFIX}Name the stack and refuse any project or prefix that is not disposable\n`,
  );
  const body = text.slice(at, text.indexOf(`\n${STEP_PREFIX}`, at + 1));
  const temp = mkdtempSync(path.join(tmpdir(), 'si-prefix-'));
  try {
    writeFileSync(path.join(temp, 'env'), '');
    const run = spawnSync('bash', ['-c', script(body)], {
      cwd: temp,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        GCP_PROJECT: 'example-disposable-project',
        GITHUB_RUN_ID: '777',
        GITHUB_ENV: path.join(temp, 'env'),
        GITHUB_PATH: path.join(temp, 'path'),
        GITHUB_WORKSPACE: temp,
        RUNNER_TEMP: temp,
        EVIDENCE_DIR: path.join(temp, 'evidence'),
        RUN_PREFIX_INPUT: inputs.run ?? '',
        SI_PREFIX_INPUT: inputs.si ?? '',
      },
    });
    if (run.status !== 0) return `error: ${run.stdout}`;
    return /^PREFIX=(.*)$/mu.exec(readFileSync(path.join(temp, 'env'), 'utf8'))?.[1] ?? '';
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('the live preview sandbox-internet stack name', () => {
  it('lets a destroy-only run name a sandbox-internet stack of the form aw-si-<run id>', () => {
    expect(PREVIEW).toMatch(
      /\n {6}si_prefix:\n {8}description: .*\n {8}required: false\n {8}default: ''\n {8}type: string\n/u,
    );
    expect(jobText('sandbox-internet')).toContain('SI_PREFIX_INPUT: ${{ inputs.si_prefix }}');
    expect(jobText('preview')).not.toContain('si_prefix');
    expect(nameSandboxInternet({ si: 'aw-si-42525921402' })).toBe('aw-si-42525921402');
    expect(nameSandboxInternet({ run: 'aw-byoc-9', si: 'aw-si-42525921402' })).toBe(
      'aw-si-42525921402',
    );
    expect(nameSandboxInternet({ run: 'aw-byoc-9' })).toBe('aw-byoc-9-si');
    expect(nameSandboxInternet({})).toBe('aw-si-777');
  });

  it.each([
    ['indx-test-stack', 'must not name a protected resource'],
    ['agent-workspace-x', 'must not name a protected resource'],
    ['aw-si-42525921402000', '3-19 lowercase letters'],
    ['AW-si-1', '3-19 lowercase letters'],
    ['aw-si-1-', '3-19 lowercase letters'],
    ['aw', '3-19 lowercase letters'],
  ])('refuses the sandbox-internet prefix %s', (si, reason) => {
    expect(nameSandboxInternet({ si })).toContain(reason);
  });
});

describe('the live preview gates after the destroy', () => {
  it('keeps the leftovers gate failing the job on anything of the prefix', () => {
    const gate = step('List what is left of the prefix');
    expect(gate).toContain("if: always() && inputs.action != 'apply'");
    expect(gate).toContain('list artifacts gcloud artifacts repositories list');
    expect(gate).toMatch(
      /echo "::error::resources of \$PREFIX are left after destroy"; cat "\$left"; exit 1/u,
    );
  });

  it('probes that the runner manager cannot run a Cloud Run Job and fails on a 2xx answer', () => {
    const probe = step("Probe the runner manager's IAM condition");
    expect(probe).toMatch(/jobs\/\$\{env\.PROBE_JOB\}:run/u);
    expect(probe).toContain('containerOverrides');
    expect(probe).toContain('out.runJob');
    expect(probe).toMatch(/case "\$run_job" in 403\) ;; 2\?\?\) probe_failed/u);
    expect(probe).toContain('want an IAM denial (403)');
  });

  it('documents the runner manager custom roles and the tftest that backs them', () => {
    const guide = readFileSync(path.join(ROOT, 'docs/40-operate/deploy/gcp-cloudrun.md'), 'utf8');
    const runbook = readFileSync(
      path.join(ROOT, 'docs/40-operate/operations/gcp-cloudrun-runbook.md'),
      'utf8',
    );
    for (const text of [guide, runbook]) {
      expect(text).not.toContain('roles/run.developer');
      expect(text).toContain('_runner_manager');
      expect(text).toContain('the_runner_manager_holds_no_permission_on_jobs');
    }
    expect(guide).toContain('roles/iam.roleAdmin');
  });
});
