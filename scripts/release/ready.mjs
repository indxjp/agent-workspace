/* global console */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { verifyDigestReference } from '../../infra/release/verify-reference.mjs';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/u;
const RELEASE_READY_STATUSES = new Set(['implemented', 'live-verified']);
const REQUIRED_IMAGES = new Set(['web', 'gateway', 'runner-manager', 'runtime']);

/** @param {string} file @returns {Promise<any>} */
async function readJson(file) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`READINESS_SOURCE_UNREADABLE: ${file}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`READINESS_JSON_INVALID: ${file}: ${String(error)}`, { cause: error });
  }
}

/** @param {string} root */
async function headSha(root) {
  const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

/** @param {string} code @param {string} detail @returns {never} */
function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

/** @param {any} value Untrusted manifest JSON. @param {string} label */
function requireApproval(value, label) {
  if (
    value?.status !== 'approved' ||
    typeof value.actor !== 'string' ||
    value.actor.trim() === ''
  ) {
    fail('READINESS_APPROVAL_MISSING', label);
  }
  if (typeof value.approvedAt !== 'string' || !Number.isFinite(Date.parse(value.approvedAt))) {
    fail('READINESS_APPROVAL_INVALID', `${label}.approvedAt`);
  }
}

/**
 * Fail-closed release-readiness validation. Structural version checks intentionally remain in
 * release:check; this command validates deployability, immutable evidence, and human approvals.
 *
 * @param {string} root
 * @param {{currentSha?: string, now?: Date}} [options]
 */
export async function checkReleaseReadiness(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  const status = await readJson(path.join(absoluteRoot, 'docs', 'capabilities', 'status.json'));
  if (status.schemaVersion !== 2 || status.canonical !== true) {
    fail('READINESS_STATUS_SCHEMA_INVALID', 'expected canonical schemaVersion 2');
  }
  if (status.releaseVerdict !== 'ready') {
    fail('READINESS_VERDICT_BLOCKED', `releaseVerdict=${String(status.releaseVerdict)}`);
  }
  if (!Array.isArray(status.capabilities) || status.capabilities.length === 0) {
    fail('READINESS_CAPABILITIES_INVALID', 'no capabilities declared');
  }

  const evidencePath = status.releaseEvidenceManifest;
  if (typeof evidencePath !== 'string' || evidencePath.trim() === '') {
    fail('READINESS_MANIFEST_MISSING', 'releaseEvidenceManifest is not configured');
  }
  const manifest = await readJson(path.join(absoluteRoot, evidencePath));
  if (manifest.schemaVersion !== 1) fail('READINESS_MANIFEST_SCHEMA_INVALID', 'expected version 1');

  const currentSha = options.currentSha ?? (await headSha(absoluteRoot));
  if (!SHA.test(currentSha)) fail('READINESS_SHA_INVALID', currentSha);
  if (manifest.commitSha !== currentSha) {
    fail('READINESS_SHA_MISMATCH', `manifest=${String(manifest.commitSha)} head=${currentSha}`);
  }

  const checks = new Map(
    (manifest.checks ?? []).map((/** @type {any} */ entry) => [entry.id, entry]),
  );
  const now = (options.now ?? new Date()).getTime();
  for (const capability of status.capabilities) {
    if (typeof capability.id !== 'string' || capability.id.trim() === '') {
      fail('READINESS_CAPABILITY_ID_MISSING', String(capability.area));
    }
    if (capability.releaseImpact === 'blocker' && !RELEASE_READY_STATUSES.has(capability.status)) {
      fail('READINESS_BLOCKER_OPEN', `${capability.id}=${String(capability.status)}`);
    }
    const requirement = capability.evidenceRequirement;
    if (capability.releaseImpact === 'none') continue;
    if (typeof requirement?.id !== 'string' || requirement.id.trim() === '') {
      fail('READINESS_EVIDENCE_REQUIREMENT_MISSING', capability.id);
    }
    const check = checks.get(requirement.id);
    if (!check || check.status !== 'passed') {
      fail('READINESS_EVIDENCE_MISSING', `${capability.id}/${requirement.id}`);
    }
    if (check.commitSha !== currentSha) {
      fail('READINESS_EVIDENCE_SHA_MISMATCH', `${requirement.id}=${String(check.commitSha)}`);
    }
    if (typeof check.completedAt !== 'string' || !Number.isFinite(Date.parse(check.completedAt))) {
      fail('READINESS_EVIDENCE_TIME_INVALID', requirement.id);
    }
    if (requirement.maxAgeDays !== null && requirement.maxAgeDays !== undefined) {
      const age = now - Date.parse(check.completedAt);
      if (age < 0 || age > requirement.maxAgeDays * 86_400_000) {
        fail('READINESS_EVIDENCE_EXPIRED', requirement.id);
      }
    }
    if (requirement.approval === 'owner')
      requireApproval(check.approval, `${requirement.id}/owner`);
    if (requirement.approval === 'security') {
      requireApproval(check.approval, `${requirement.id}/security`);
    }
  }

  const images = new Map(
    (manifest.artifacts?.images ?? []).map((/** @type {any} */ item) => [item.component, item]),
  );
  for (const component of REQUIRED_IMAGES) {
    const image = images.get(component);
    if (!image || typeof image.reference !== 'string') {
      fail('READINESS_IMAGE_MUTABLE', component);
    }
    try {
      // Shared with infra/release/write-manifest.mjs so the two checks cannot drift: this also
      // rejects the all-zero placeholder digest, which a bare digest-syntax regex would accept.
      verifyDigestReference(image.reference);
    } catch {
      fail('READINESS_IMAGE_MUTABLE', component);
    }
    if (
      image.commitSha !== currentSha ||
      image.signatureVerified !== true ||
      image.sbomVerified !== true
    ) {
      fail('READINESS_IMAGE_UNVERIFIED', component);
    }
  }

  if (manifest.artifacts?.package?.ownershipVerified !== true) {
    fail('READINESS_PACKAGE_OWNERSHIP_UNVERIFIED', 'package ownership has not been verified');
  }
  if (
    manifest.artifacts?.package?.provenanceVerified !== true ||
    manifest.artifacts?.package?.signatureVerified !== true
  ) {
    fail('READINESS_PACKAGE_UNVERIFIED', 'package signature/provenance is incomplete');
  }

  requireApproval(manifest.approvals?.owner, 'release owner');
  requireApproval(manifest.approvals?.security, 'security reviewer');
  requireApproval(manifest.walkthrough, 'independent walkthrough');
  if (!Array.isArray(manifest.residualRisks) || manifest.residualRisks.length === 0) {
    fail('READINESS_RISKS_MISSING', 'no residual-risk dispositions');
  }
  for (const risk of manifest.residualRisks) {
    if (!['accepted', 'mitigated'].includes(risk.status)) {
      fail('READINESS_RISK_UNSIGNED', `${String(risk.id)}=${String(risk.status)}`);
    }
    requireApproval(
      { status: 'approved', actor: risk.actor, approvedAt: risk.dispositionAt },
      `risk ${String(risk.id)}`,
    );
  }

  return {
    commitSha: currentSha,
    checks: checks.size,
    images: REQUIRED_IMAGES.size,
    version: manifest.releaseVersion,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const result = await checkReleaseReadiness(process.cwd());
    console.log(
      `release ready: version=${String(result.version)} sha=${result.commitSha} checks=${String(result.checks)} images=${String(result.images)}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
