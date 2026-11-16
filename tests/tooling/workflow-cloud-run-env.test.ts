// gcloud splits a --set-env-vars / --update-env-vars list on commas, or on the delimiter a `^x^`
// prefix names, so a value that holds one (a URL, a script, a service-account email with `@`) breaks
// the deploy: live run 42182594901 failed on `RUNTIME_SA=…-runtime@…` under `^@^`. A workflow passes
// Cloud Run environment through --env-vars-file and keeps --update-env-vars to one plain pair.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = path.resolve(import.meta.dirname, '../../.github/workflows');
const PREVIEW = 'gcp-cloudrun-preview.yml';

function workflowLines(): { where: string; line: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((file) =>
      readFileSync(path.join(WORKFLOWS, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ where: `${file}:${String(index + 1)}`, line })),
    );
}

function previewStep(name: string): string {
  const source = readFileSync(path.join(WORKFLOWS, PREVIEW), 'utf8');
  const start = source.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`no step "${name}" in ${PREVIEW}`);
  const end = source.indexOf('\n      - name: ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('Cloud Run environment in workflows', () => {
  it('never passes a --set-env-vars list', () => {
    const found = workflowLines()
      .filter(({ line }) => /--set-env-vars[\s=]/.test(line) && !line.trimStart().startsWith('#'))
      .map(({ where }) => where);
    expect(found).toEqual([]);
  });

  it('keeps --update-env-vars to one NAME=value pair without a delimiter', () => {
    const found = workflowLines()
      .flatMap(({ where, line }) =>
        [...line.matchAll(/--update-env-vars[\s=]+("[^"]*"|\S+)/g)].map((match) => ({
          where,
          value: (match[1] ?? '').replace(/^"|"$/g, ''),
        })),
      )
      .filter(({ value }) => !/^[A-Z_][A-Z0-9_]*=[^,^@]*$/.test(value))
      .map(({ where, value }) => `${where}: ${value}`);
    expect(found).toEqual([]);
  });

  it('deploys the IAM probe from an env-vars file and claims PERMISSION_DENIED only when gcloud said it', () => {
    const step = previewStep("Probe the runner manager's IAM condition");
    expect(step).toContain('--env-vars-file "$RUNNER_TEMP/iam-probe.env.yaml"');
    expect(step).toMatch(
      /RUNTIME_SA=\$\{PREFIX\}-runtime@\$\{GCP_PROJECT\}\.iam\.gserviceaccount\.com/,
    );
    const claims = step
      .split('\n')
      .filter((line) => line.includes('probe_failed') && line.includes('PERMISSION_DENIED'));
    expect(claims).toHaveLength(1);
    expect(step).toMatch(
      /if grep -q 'PERMISSION_DENIED' "\$deploy_log"; then\n\s+probe_failed "[^\n]*PERMISSION_DENIED/,
    );
  });
});
