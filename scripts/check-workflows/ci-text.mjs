// The text helpers and paths every ci.yml rule shares.
import path from 'node:path';

export const WORKFLOWS_DIRECTORY = '.github/workflows';
export const CI_WORKFLOW = path.posix.join(WORKFLOWS_DIRECTORY, 'ci.yml');
export const WAVE_GATE_STEP = 'Wave plans declare disjoint ownership';

/** @param {string} source @param {string} jobId */
export function jobBlock(source, jobId) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) return null;
  const nextJob = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:\s*$/u.test(line),
  );
  return lines.slice(start, nextJob < 0 ? undefined : nextJob).join('\n');
}

/**
 * Push `<ci.yml>: <jobId> must include <x>` for every required text the job lacks.
 * @param {string[]} failures @param {string} job @param {string} jobId @param {readonly string[]} required
 */
export function requireIncludes(failures, job, jobId, required) {
  for (const requiredCheck of required) {
    if (!job.includes(requiredCheck)) {
      failures.push(`${CI_WORKFLOW}: ${jobId} must include ${requiredCheck}`);
    }
  }
}

/**
 * Run `check` on the job's block, or report the job missing.
 * @param {string[]} failures @param {string} ciSource @param {string} jobId
 * @param {(job: string) => void} check
 */
export function withJob(failures, ciSource, jobId, check) {
  const job = jobBlock(ciSource, jobId);
  if (job === null) failures.push(`${CI_WORKFLOW}: missing ${jobId} job`);
  else check(job);
}
