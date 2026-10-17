import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const vectors = loadVectors('azure-gateway', 'ingress.json');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const terraform = readFileSync(
  path.join(repoRoot, 'infra/terraform/azure-container-apps/apps.tf'),
  'utf8',
);

describe('azure-gateway: Terraform ingress follows the Lean deployment decision', () => {
  it.each(vectors)('$id', ({ input, expected }) => {
    const enabled = asRecord(input, 'input')['dynamicSessionsEnabled'];
    if (typeof enabled !== 'boolean') throw new Error('dynamicSessionsEnabled must be boolean');
    const expectedIngress = asString(asRecord(expected, 'expected')['ingress'], 'ingress');

    const gatewayResource = terraform
      .split(/^resource\s/mu)
      .find((block) => /^"azurerm_container_app"\s+"gateway"\s*\{/u.test(block));
    if (gatewayResource === undefined) throw new Error('Gateway resource missing');
    const gatewayIngress = gatewayResource.match(
      /\n\s*ingress\s*\{[\s\S]*?\n\s*external_enabled\s*=\s*([^\r\n]+)/u,
    );
    const expression = gatewayIngress?.[1]?.trim();
    const actualIngress = (() => {
      if (expression === 'var.enable_dynamic_sessions') return enabled ? 'external' : 'internal';
      if (expression === 'true') return 'external';
      if (expression === 'false') return 'internal';
      throw new Error(`Unsupported gateway ingress expression: ${String(expression)}`);
    })();
    expect(actualIngress).toBe(expectedIngress);
  });
});
