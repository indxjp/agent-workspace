// The live Cloud Run preview (issue #2112). Run 42441982795 failed twice over:
// - the app-minimal image was built with examples/minimal as its context, whose Dockerfile copies a
//   package-lock.json the example does not ship (`"/package-lock.json": not found`);
// - "Destroy the stack" then ran `aw deploy destroy` with no project file, exited, and never
//   reached the deletion of the `${PREFIX}-staging` repository, which the leftovers gate found.
// Every file an image's Dockerfile copies must be in the context the workflow builds it from, and
// destroy must skip a stack that was never applied and always delete the staging repository.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { LOCKFILE, copyExample, lockArguments, parseArguments } from '../apps/app-image.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PREVIEW = readFileSync(path.join(ROOT, '.github/workflows/gcp-cloudrun-preview.yml'), 'utf8');

/** The condition of a preview evidence step that must run whatever the browser journey did. */
const AFTER_DEPLOY =
  "if: ${{ !cancelled() && inputs.action != 'destroy' && steps.deploy.outcome == 'success' }}";

/** Every step of the workflow named `name`, in order, as its text. */
function steps(name: string): string[] {
  const found: string[] = [];
  let start = PREVIEW.indexOf(`      - name: ${name}\n`);
  while (start >= 0) {
    const end = PREVIEW.indexOf('\n      - name: ', start + 1);
    found.push(PREVIEW.slice(start, end < 0 ? undefined : end));
    start = PREVIEW.indexOf(`      - name: ${name}\n`, start + 1);
  }
  if (found.length === 0) throw new Error(`no step "${name}" in the preview workflow`);
  return found;
}

function step(name: string): string {
  const [only, ...rest] = steps(name);
  if (only === undefined || rest.length > 0) throw new Error(`not one step "${name}"`);
  return only;
}

/** The text of job `job`. */
function jobText(job: string): string {
  const start = PREVIEW.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`no job ${job}`);
  const next = /\n {2}[a-z0-9-]+:\n/gu;
  next.lastIndex = start + 1;
  return PREVIEW.slice(start, next.exec(PREVIEW)?.index ?? PREVIEW.length);
}

/**
 * The sources of a Dockerfile's `COPY` instructions that read the build context (not another
 * stage), with build arguments left out: they are resolved only at build time.
 */
function copySources(dockerfile: string): string[] {
  const instructions = dockerfile.replace(/\\\n/gu, ' ').split('\n');
  return instructions.flatMap((line) => {
    const words = line.trim().split(/\s+/u);
    if (words[0]?.toUpperCase() !== 'COPY') return [];
    const operands = words.slice(1).filter((word) => !word.startsWith('--'));
    if (words.some((word) => word.startsWith('--from='))) return [];
    return operands.slice(0, -1).filter((source) => !source.includes('$'));
  });
}

function trackedFiles(directory: string): Set<string> {
  const listed = execFileSync('git', ['ls-files', '-z', '--', directory], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return new Set(listed.split('\0').filter(Boolean));
}

/** The sources `dockerfile` copies that `holds` says its context lacks. */
function missing(dockerfile: string, holds: (source: string) => boolean): string[] {
  return copySources(dockerfile).filter((source) => source !== '.' && !holds(source));
}

const work = mkdtempSync(path.join(tmpdir(), 'preview-images-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('the images the live preview builds', () => {
  const build = step('Build the six images from the ref');

  it('finds every file each Dockerfile copies in the context it is built from', () => {
    const specs = [...build.matchAll(/([a-z-]+):([A-Za-z./-]*Dockerfile):([a-z-]*):([^\s;]+)/gu)];
    const problems = specs.flatMap(([, name, file, , context]) => {
      if (name === undefined || file === undefined || context === undefined) return [];
      const tracked = trackedFiles(context);
      const holds = (source: string) => {
        const relative = path.posix.join(context, source.replace(/\/$/u, ''));
        return (
          tracked.has(relative) || [...tracked].some((entry) => entry.startsWith(`${relative}/`))
        );
      };
      return missing(readFileSync(path.join(ROOT, file), 'utf8'), holds).map(
        (source) => `${name}: ${file} copies ${source}, which ${context} does not hold`,
      );
    });
    expect(problems).toEqual([]);
    expect(specs.map((spec) => spec[1])).toEqual([
      'web',
      'gateway',
      'runner',
      'runtime',
      'tool-host',
    ]);
  });

  it('builds the app through app-image.mjs, never from examples/minimal as it is', () => {
    expect(build).not.toMatch(/app-minimal:examples\/minimal/u);
    expect(build).toMatch(
      /node tests\/apps\/app-image\.mjs --app minimal --work "\$RUNNER_TEMP\/app-image" -- \\\n\s+--platform linux\/amd64 --tag "\$staging\/app-minimal:\$tag" --push --metadata-file "\$RUNNER_TEMP\/meta\/app-minimal\.json"/u,
    );
    // The packages it packs are built first, and its digest is read like the others'.
    expect(build.indexOf('scripts/ci/nx.sh run-many -t build')).toBeLessThan(
      build.indexOf('node tests/apps/app-image.mjs'),
    );
    expect(build).toContain('pids[app-minimal]=$!');
    expect(build).toMatch(/for name in web gateway runner runtime tool-host app-minimal; do/u);
    expect(parseArguments(['--app', 'minimal', '--work', 'w', '--', '--push', '.'])).toEqual({
      app: 'minimal',
      work: path.resolve('w'),
      build: ['--push', '.'],
    });
  });

  it('gives every example Dockerfile a context that holds what it copies once locked', () => {
    expect(lockArguments('http://127.0.0.1:1')).toContain('--package-lock-only');
    const examples = readdirSync(path.join(ROOT, 'examples')).filter((id) =>
      existsSync(path.join(ROOT, 'examples', id, 'Dockerfile')),
    );
    expect(examples).toContain('minimal');
    const problems = examples.flatMap((id) => {
      const context = path.join(work, id);
      copyExample(id, context);
      const dockerfile = readFileSync(path.join(context, 'Dockerfile'), 'utf8');
      // The lock step writes LOCKFILE; everything else must have been copied.
      const holds = (source: string) =>
        source === LOCKFILE || existsSync(path.join(context, source));
      return missing(dockerfile, holds).map((source) => `${id}: the context lacks ${source}`);
    });
    expect(problems).toEqual([]);
    // Without the lock step the context is what failed live.
    const minimal = readFileSync(path.join(ROOT, 'examples/minimal/Dockerfile'), 'utf8');
    expect(copySources(minimal)).toContain(LOCKFILE);
    expect(existsSync(path.join(work, 'minimal', LOCKFILE))).toBe(false);
  });
});

describe('the live preview destroy', () => {
  it('names no app in a destroy-only run, which builds no image', () => {
    const write = steps('Write the project file')[0] ?? '';
    expect(write).toMatch(
      /if \[ "\$ACTION" != destroy \]; then\n\s+cat >> agent-workspace\.yaml <<YAML\n[\s\S]*image: \$APP_IMAGE/u,
    );
  });

  it.each(['preview', 'sandbox-internet'])(
    'in %s, skips a stack never applied and always deletes the staging repository',
    (job) => {
      const text = jobText(job);
      const find = text.indexOf('      - name: Find the Terraform state of the prefix\n');
      const rebuild = text.indexOf(
        '      - name: Rebuild the deployment state of the earlier run\n',
      );
      const destroyAt = text.indexOf('      - name: Destroy the stack\n');
      const left = text.indexOf('      - name: List ', destroyAt);
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

      const destroy = text.slice(destroyAt, left);
      expect(destroy).toContain("if: always() && inputs.action != 'apply'");
      const order = [
        'set +e',
        'if [ "${PREFIX_STATE:-present}" = absent ]; then',
        'elif [ ! -f agent-workspace.yaml ]; then',
        'aw deploy destroy production',
        'gcloud artifacts repositories delete "${PREFIX}-staging"',
        'exit "$status"',
      ].map((needle) => destroy.indexOf(needle));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
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

  /** The value of the single-quoted shell assignment `name='...'` in `text`. */
  function assigned(text: string, name: string): string {
    const found = new RegExp(`\n\\s+${name}='([^']*)'\n`, 'u').exec(text);
    if (found?.[1] === undefined) throw new Error(`no ${name}='...' in the destroy step`);
    return found[1];
  }
  const matches = (pattern: string, line: string): boolean =>
    spawnSync('grep', ['-Eq', pattern], { input: `${line}\n` }).status === 0;
  const destroyStep = (job: string): string => {
    const text = jobText(job);
    const at = text.indexOf('      - name: Destroy the stack\n');
    return text.slice(at, text.indexOf('\n      - name: ', at + 1));
  };

  // Run 42525921402: the sandbox-internet destroy's last attempt failed on the runner's network
  // (`connect: no route to host`), and the loop, which retried only a held network, gave up and
  // left the VPC and its two subnets.
  it.each(['preview', 'sandbox-internet'])(
    'in %s, retries a held network and a transient network error within one 150-minute budget',
    (job) => {
      const destroy = destroyStep(job);
      const held = assigned(destroy, 'held');
      const transient = assigned(destroy, 'transient');
      expect(held).toBe(assigned(destroyStep('preview'), 'held'));
      expect(transient).toBe(assigned(destroyStep('preview'), 'transient'));
      expect(
        matches(
          held,
          'Google Cloud releases the network 1–2 hours after its services are deleted; everything else is gone.',
        ),
      ).toBe(true);
      for (const line of [
        'Error when reading or editing Subnetwork: Delete "https://compute.googleapis.com/compute/v1/projects/p/regions/r/subnetworks/aw-si-1-services?alt=json": dial tcp 142.250.21.95:443: connect: no route to host',
        'dial tcp 142.250.21.95:443: connect: connection refused',
        'read tcp 10.0.0.2:5555->142.250.21.95:443: read: connection reset by peer',
        'dial tcp 142.250.21.95:443: i/o timeout',
        'net/http: TLS handshake timeout',
        'Error waiting for Deleting Network: googleapi: Error 503: The service is currently unavailable., backendError',
        'googleapi: got HTTP response code 502 with body: <html>',
      ]) {
        expect(matches(transient, line), line).toBe(true);
      }
      for (const line of [
        'googleapi: Error 403: Required permission compute.networks.delete, forbidden',
        'googleapi: Error 400: The network resource is already being used by firewall',
        'Error acquiring the state lock',
        'Error: Invalid value for variable',
      ]) {
        expect(matches(held, line) || matches(transient, line), line).toBe(false);
      }
      const order = [
        'start=$(date +%s)',
        'aw deploy destroy production',
        'if [ "$status" -eq 0 ]; then break; fi',
        'if grep -Eq "$held" "$attempt"; then wait_seconds=600;',
        'elif grep -Eq "$transient" "$attempt"; then wait_seconds=60;',
        'else break; fi',
        'if [ $(( $(date +%s) - start )) -ge 9000 ]; then',
        'sleep "$wait_seconds"',
      ].map((needle) => destroy.indexOf(needle));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // One budget: the clock starts once, before the loop.
      expect(destroy.split('start=$(date +%s)')).toHaveLength(2);
    },
  );

  /** Runs the sandbox-internet job's naming step; its PREFIX, or its error. */
  function nameSandboxInternet(inputs: { run?: string; si?: string }): string {
    const text = jobText('sandbox-internet');
    const at = text.indexOf(
      '      - name: Name the stack and refuse any project or prefix that is not disposable\n',
    );
    const body = text.slice(at, text.indexOf('\n      - name: ', at + 1));
    const script = body
      .slice(body.indexOf('        run: |\n') + '        run: |\n'.length)
      .split('\n')
      .map((line) => line.replace(/^ {10}/u, ''))
      .join('\n');
    const temp = mkdtempSync(path.join(tmpdir(), 'si-prefix-'));
    try {
      writeFileSync(path.join(temp, 'env'), '');
      const run = spawnSync('bash', ['-c', script], {
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

  it('keeps the leftovers gate failing the job on anything of the prefix', () => {
    const gate = step('List what is left of the prefix');
    expect(gate).toContain("if: always() && inputs.action != 'apply'");
    expect(gate).toContain('list artifacts gcloud artifacts repositories list');
    expect(gate).toMatch(
      /echo "::error::resources of \$PREFIX are left after destroy"; cat "\$left"; exit 1/u,
    );
  });

  it('requires the deployed services to run the pinned digests, read-only, after the private shape', () => {
    const preview = jobText('preview');
    const names = [...preview.matchAll(/^ {6}- name: (.+)$/gmu)].map((match) => match[1]);
    const at = names.indexOf('Require the services to run the copied digests');
    expect(at).toBeGreaterThan(names.indexOf('Assert the private shape'));
    expect(at).toBeLessThan(names.indexOf('Record the service logs of a failed check'));
    expect(names.filter((name) => name === names[at])).toHaveLength(1);
    const gate = step('Require the services to run the copied digests');
    expect(gate).toContain(AFTER_DEPLOY);
    expect(gate).toContain('overrides the pinned release image');
    expect(gate).toContain('gcloud run services describe');
    expect(gate).toContain('pinned-images.txt');
    expect(gate).toContain('result=$([ "$fail" -eq 0 ] && echo pass || echo fail)');
    expect(gate).not.toMatch(/gcloud run services (update|deploy|delete)/u);
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
    const guide = readFileSync(path.join(ROOT, 'docs/deploy/gcp-cloudrun.md'), 'utf8');
    const runbook = readFileSync(
      path.join(ROOT, 'docs/operations/gcp-cloudrun-runbook.md'),
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

// Run 42631986555: the browser journey failed only on a Vertex AI 429 (quota 0, an Owner item), and
// the evidence steps after it were skipped although none of them reads the journey's outcome. They
// run once the deploy succeeded, whatever an earlier check did, and still fail the job themselves.
describe('the live preview evidence steps after the browser journey', () => {
  const preview = jobText('preview');
  const names = [...preview.matchAll(/^ {6}- name: (.+)$/gmu)].map((match) => match[1] ?? '');
  /** The one step of the preview job named `name`: the sandbox-internet job repeats some names. */
  const previewStep = (name: string): string => {
    const found = steps(name).filter((text) => preview.includes(text));
    if (found.length !== 1 || found[0] === undefined)
      throw new Error(`not one preview step "${name}"`);
    return found[0];
  };

  it('names the deploy and the live configuration steps the conditions read', () => {
    expect(previewStep('Deploy from empty state')).toMatch(/^ {8}id: deploy$/mu);
    expect(previewStep('Load masked live configuration')).toMatch(/^ {8}id: live-config$/mu);
  });

  it.each([
    ['Require that model traffic reached Vertex AI and never api.anthropic.com', AFTER_DEPLOY],
    [
      'Assert the private shape',
      "if: ${{ !cancelled() && inputs.action != 'destroy' && steps.deploy.outcome == 'success' && steps.live-config.outcome == 'success' }}",
    ],
    ['Require the services to run the copied digests', AFTER_DEPLOY],
  ])('runs "%s" after a failed journey once the deploy succeeded', (name, condition) => {
    expect(names.indexOf(name)).toBeGreaterThan(
      names.indexOf('Validate the authenticated stack in Chromium'),
    );
    const text = previewStep(name);
    expect(text.split('\n').filter((line) => line.startsWith('        if: '))).toEqual([
      `        ${condition}`,
    ]);
    expect(text).toContain('set -euo pipefail');
    expect(text).not.toMatch(/^ {10}set \+e$/mu);
    expect(text).toMatch(/exit (1|"\$fail")/u);
  });

  it('leaves no step between the journey and the failure diagnostics on the bare destroy guard', () => {
    const from = names.indexOf('Validate the authenticated stack in Chromium');
    const to = names.indexOf('Record the service logs of a failed check');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from + 1);
    for (const name of names.slice(from + 1, to)) {
      expect(previewStep(name)).not.toMatch(/^ {8}if: inputs\.action != 'destroy'$/mu);
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

/** The `run: |` script of a step's text, unindented. */
function script(stepText: string): string {
  const marker = '        run: |\n';
  const at = stepText.indexOf(marker);
  if (at < 0) throw new Error('the step has no run script');
  return stepText
    .slice(at + marker.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/u, ''))
    .join('\n');
}

/** Every step of the workflow, as its text. */
function allSteps(): string[] {
  return PREVIEW.split('\n      - name: ')
    .slice(1)
    .map((text) => `      - name: ${text}`);
}

// Run 42577620759: the default shell of a step is `bash -e`, which `set -uo pipefail` does not lift.
// The IAM probe's log read (a grep that matched no line before the log was ingested) ended the step
// with exit 1 and no message, before its 9-attempt wait and its probe_failed marker.
describe('the live preview steps that handle their own failures', () => {
  it('lifts -e in every step that never fails itself or reads PIPESTATUS', () => {
    const handled = allSteps().filter((text) => {
      if (!text.includes('        run: |\n')) return false;
      const body = script(text).trimEnd();
      return body.endsWith('\nexit 0') || body.includes('PIPESTATUS');
    });
    expect(handled.length).toBeGreaterThan(5);
    const unlifted = handled
      .filter((text) => !/^set \+e$/mu.test(script(text)))
      .map((text) => text.split('\n')[0]);
    expect(unlifted).toEqual([]);
  });

  describe("the IAM probe's wait for its result line", () => {
    const probe = script(step("Probe the runner manager's IAM condition"));
    const nonce = '42-1-iam-0123456789abcdef';

    /** The step's prologue and read loop under `bash -e`, with a gcloud that prints the line on call `lineOn`. */
    function readLoop(lineOn: number): {
      status: number | null;
      reached: boolean;
      calls: number;
      result: string;
      failed: string;
    } {
      // The shell options the step sets before its first variable.
      const prologue = probe.slice(0, probe.indexOf('\nev="$EVIDENCE_DIR"\n'));
      const failedLine = probe.split('\n').find((line) => line.startsWith('probe_failed() {'));
      const from = probe.indexOf('filter="resource.type=\\"cloud_run_job\\"');
      const to = probe.indexOf('cat "$ev/iam-condition.json"\n');
      expect(prologue).toContain('set -uo pipefail');
      expect(failedLine).toBeDefined();
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      const temp = mkdtempSync(path.join(tmpdir(), 'iam-read-'));
      try {
        const bin = path.join(temp, 'bin');
        const ev = path.join(temp, 'evidence');
        execFileSync('mkdir', ['-p', bin, ev]);
        const line = `AW_IAM_PROBE {"mode":"iam","nonce":"${nonce}","positiveControl":200}`;
        writeFileSync(
          path.join(bin, 'gcloud'),
          [
            '#!/usr/bin/env bash',
            `count=$(( $(cat "${temp}/calls" 2>/dev/null || echo 0) + 1 ))`,
            `echo "$count" > "${temp}/calls"`,
            'echo "Starting execution"',
            `if [ "$count" -ge ${lineOn} ]; then echo '${line}'; fi`,
            '',
          ].join('\n'),
          { mode: 0o755 },
        );
        const body = [
          prologue,
          'sleep() { :; }',
          `ev="${ev}"`,
          'job=aw-test-iam-probe',
          `nonce=${nonce}`,
          failedLine ?? '',
          probe.slice(from, to + 'cat "$ev/iam-condition.json"\n'.length),
          'echo reached-the-end',
        ].join('\n');
        const run = spawnSync('bash', ['-e', '-c', body], {
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

/** The one step of the preview job named `name`: the sandbox-internet job repeats some names. */
function previewJobStep(name: string): string {
  const preview = jobText('preview');
  const found = steps(name).filter((text) => preview.includes(text));
  if (found.length !== 1 || found[0] === undefined)
    throw new Error(`not one preview step "${name}"`);
  return found[0];
}

/** Runs `body` under the steps' default `bash -e` in a fresh directory with `tools` first on PATH. */
function runWithTools(
  body: string,
  tools: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string>>,
  prepare: (temp: string) => void,
): { status: number | null; stdout: string; evidence: string } {
  const temp = mkdtempSync(path.join(tmpdir(), 'preview-step-'));
  try {
    const bin = path.join(temp, 'bin');
    execFileSync('mkdir', ['-p', bin, path.join(temp, 'evidence')]);
    for (const [name, text] of Object.entries(tools)) {
      writeFileSync(path.join(bin, name), text, { mode: 0o755 });
    }
    prepare(temp);
    const run = spawnSync('bash', ['-e', '-c', body], {
      cwd: temp,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        EVIDENCE_DIR: 'evidence',
        GITHUB_WORKSPACE: temp,
        RUNNER_TEMP: temp,
        PREFIX: 'aw-byoc-1',
        GCP_PROJECT: 'example-project',
        GCP_REGION: 'asia-northeast1',
        ...env,
      },
    });
    const files = readdirSync(path.join(temp, 'evidence'));
    const evidence = files
      .map((file) => readFileSync(path.join(temp, 'evidence', file), 'utf8'))
      .join('');
    return { status: run.status, stdout: `${run.stdout}${run.stderr}`, evidence };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Run 42674364781: gcloud's ';'-joined image list was piped to `read` without a final newline, so
// the last image was dropped: the runner manager, whose only container is its platform image,
// "had no platform container image", and web's Cloud SQL proxy went unrecorded.
describe('the live preview check that the services run the copied digests', () => {
  const body = script(previewJobStep('Require the services to run the copied digests'));
  const registry = 'asia-northeast1-docker.pkg.dev/example-project/aw-byoc-1-staging';
  const proxy = 'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.0';
  const built = { web: digest('a'), gateway: digest('b'), runner: digest('c') };

  function digest(hex: string): string {
    return `sha256:${hex.repeat(64)}`;
  }

  /** The step against a gcloud that describes each service with the `;`-joined `images`. */
  function check(images: Readonly<Record<string, string>>): ReturnType<typeof runWithTools> {
    const gcloud = [
      '#!/usr/bin/env bash',
      // gcloud run services describe <service> …: the service is the fourth argument.
      'cat "$RUNNER_TEMP/images/$4"',
      '',
    ].join('\n');
    return runWithTools(body, { gcloud }, {}, (temp) => {
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
    });
  }

  const deployed = {
    'aw-byoc-1-web': `${registry}/web@${built.web};${proxy}`,
    'aw-byoc-1-gateway': `${registry}/gateway@${built.gateway};${proxy}`,
    'aw-byoc-1-runner-mgr': `${registry}/runner@${built.runner}`,
  };

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
describe('the live preview check of the single sign-on redirect URI', () => {
  const shape = script(previewJobStep('Assert the private shape'));
  const from = shape.indexOf('# (c) ');
  const to = shape.indexOf('echo "result=');
  const base = 'https://aw-byoc-1-web-123456789012.asia-northeast1.run.app';

  /** Section (c) of the step against a curl answering /api/auth/login with `location`. */
  function login(baseUrl: string, location: string): ReturnType<typeof runWithTools> {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const curl = [
      '#!/usr/bin/env bash',
      `printf 'HTTP/2 303\\r\\nlocation: %s\\r\\n\\r\\n' '${location}' > headers.txt`,
      '',
    ].join('\n');
    const body = [
      'set -euo pipefail',
      'out="$EVIDENCE_DIR/private-shape.txt"',
      'fail=0',
      shape.slice(from, to),
      'echo "result=$([ "$fail" -eq 0 ] && echo pass || echo fail)" >> "$out"',
      'exit "$fail"',
    ].join('\n');
    return runWithTools(body, { curl }, { GCP_LIVE_BASE_URL: baseUrl }, () => undefined);
  }

  const google = (redirect: string): string =>
    `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(redirect)}&scope=openid&client_id=aw-byoc-live-test.apps.googleusercontent.com&response_type=code`;

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
