import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkReleaseReadiness } from '../../scripts/release/ready.mjs';

const roots: string[] = [];
const sha = 'a'.repeat(40);
const now = new Date('2026-09-10T00:00:00.000Z');
const digest = `registry.example/agent-workspace/web@sha256:${'b'.repeat(64)}`;

function approval() {
  return { status: 'approved', actor: 'reviewer@example.invalid', approvedAt: now.toISOString() };
}

function readyStatus() {
  return {
    schemaVersion: 2,
    canonical: true,
    releaseVerdict: 'ready',
    releaseEvidenceManifest: 'docs/release/evidence-manifest.json',
    capabilities: [
      {
        id: 'runtime',
        area: 'Runtime',
        status: 'live-verified',
        releaseImpact: 'blocker',
        evidence: ['evidence/runtime.json'],
        evidenceRequirement: { id: 'runtime', maxAgeDays: 7, approval: 'security' },
      },
      {
        id: 'managed',
        area: 'Managed target',
        status: 'unsupported',
        releaseImpact: 'none',
        evidence: ['docs/runtime-driver-matrix.md'],
      },
    ],
  };
}

function readyManifest() {
  return {
    schemaVersion: 1,
    releaseVersion: '0.1.0',
    commitSha: sha,
    checks: [
      {
        id: 'runtime',
        status: 'passed',
        commitSha: sha,
        completedAt: now.toISOString(),
        approval: approval(),
      },
    ],
    artifacts: {
      images: ['web', 'gateway', 'runner-manager', 'runtime'].map((component) => ({
        component,
        reference: digest.replace('/web@', `/${component}@`),
        commitSha: sha,
        signatureVerified: true,
        sbomVerified: true,
      })),
      package: {
        ownershipVerified: true,
        signatureVerified: true,
        provenanceVerified: true,
      },
    },
    approvals: { owner: approval(), security: approval() },
    walkthrough: approval(),
    residualRisks: [
      {
        id: 'RISK-01',
        status: 'accepted',
        actor: 'owner@example.invalid',
        dispositionAt: now.toISOString(),
      },
    ],
  };
}

async function fixture(
  mutate?: (
    status: ReturnType<typeof readyStatus>,
    manifest: ReturnType<typeof readyManifest>,
  ) => void,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'release-ready-'));
  roots.push(root);
  const status = readyStatus();
  const manifest = readyManifest();
  mutate?.(status, manifest);
  await mkdir(path.join(root, 'docs', 'capabilities'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'release'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'capabilities', 'status.json'), JSON.stringify(status));
  await writeFile(
    path.join(root, 'docs', 'release', 'evidence-manifest.json'),
    JSON.stringify(manifest),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fail-closed release readiness', () => {
  it('accepts immutable artifacts, fresh evidence, and explicit approvals at one SHA', async () => {
    await expect(checkReleaseReadiness(await fixture(), { currentSha: sha, now })).resolves.toEqual(
      {
        commitSha: sha,
        checks: 1,
        images: 4,
        version: '0.1.0',
      },
    );
  });

  type ReadinessMutation = (
    status: ReturnType<typeof readyStatus>,
    manifest: ReturnType<typeof readyManifest>,
  ) => void;
  const rejectionCases: readonly [string, ReadinessMutation, string][] = [
    [
      'blocked verdict',
      (status: ReturnType<typeof readyStatus>) => (status.releaseVerdict = 'blocked'),
      'READINESS_VERDICT_BLOCKED',
    ],
    [
      'open blocker',
      (status: ReturnType<typeof readyStatus>) => (status.capabilities[0]!.status = 'partial'),
      'READINESS_BLOCKER_OPEN',
    ],
    [
      'missing evidence',
      (_status: ReturnType<typeof readyStatus>, manifest: ReturnType<typeof readyManifest>) =>
        (manifest.checks = []),
      'READINESS_EVIDENCE_MISSING',
    ],
    [
      'wrong evidence SHA',
      (_status: ReturnType<typeof readyStatus>, manifest: ReturnType<typeof readyManifest>) =>
        (manifest.checks[0]!.commitSha = 'c'.repeat(40)),
      'READINESS_EVIDENCE_SHA_MISMATCH',
    ],
    [
      'mutable image',
      (_status: ReturnType<typeof readyStatus>, manifest: ReturnType<typeof readyManifest>) =>
        (manifest.artifacts.images[0]!.reference = 'registry.example/web:latest'),
      'READINESS_IMAGE_MUTABLE',
    ],
    [
      'unsigned image',
      (_status: ReturnType<typeof readyStatus>, manifest: ReturnType<typeof readyManifest>) =>
        (manifest.artifacts.images[0]!.signatureVerified = false),
      'READINESS_IMAGE_UNVERIFIED',
    ],
    [
      'unowned package',
      (_status: ReturnType<typeof readyStatus>, manifest: ReturnType<typeof readyManifest>) =>
        (manifest.artifacts.package.ownershipVerified = false),
      'READINESS_PACKAGE_OWNERSHIP_UNVERIFIED',
    ],
    [
      'missing owner approval',
      (_status: ReturnType<typeof readyStatus>, manifest: ReturnType<typeof readyManifest>) =>
        (manifest.approvals.owner.status = 'pending'),
      'READINESS_APPROVAL_MISSING',
    ],
    [
      'unsigned risk',
      (_status: ReturnType<typeof readyStatus>, manifest: ReturnType<typeof readyManifest>) =>
        (manifest.residualRisks[0]!.status = 'pending'),
      'READINESS_RISK_UNSIGNED',
    ],
  ];

  it.each(rejectionCases)('rejects %s', async (_label, mutate, code) => {
    await expect(
      checkReleaseReadiness(await fixture(mutate), { currentSha: sha, now }),
    ).rejects.toThrow(code);
  });

  it('rejects stale evidence even if it passed previously', async () => {
    const root = await fixture((_status, manifest) => {
      manifest.checks[0]!.completedAt = '2026-08-01T00:00:00.000Z';
    });
    await expect(checkReleaseReadiness(root, { currentSha: sha, now })).rejects.toThrow(
      'READINESS_EVIDENCE_EXPIRED',
    );
  });
});
