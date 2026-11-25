// Docker Hub's anonymous limit is per address, and CI's runners share addresses (the MS-A2 host's
// eight runners, GitHub's hosted pools): `429 Too Many Requests` from registry-1.docker.io failed
// the release smoke and the apps lane. These rules keep CI's Docker Hub traffic on Google's public
// mirror of it, mirror.gcr.io (.github/actions/docker-hub-mirror says how).
import { CI_WORKFLOW, jobBlock } from './ci-text.mjs';

export const DOCKER_HUB_MIRROR_ACTION = './.github/actions/docker-hub-mirror';

/**
 * The ci.yml jobs that pull Docker Hub images (a `docker run`, a Dockerfile's base image, a
 * Compose project) or resolve a Docker Hub digest through the CLI. Each routes Docker Hub through
 * the mirror right after its checkout, before any step that could reach Docker Hub.
 */
export const DOCKER_HUB_JOBS = [
  'heavy-checks',
  'release-checks',
  'release-images',
  'image-scan',
  'generated-project-e2e',
  'apps-e2e',
  'tool-sandbox-e2e',
  'journey-e2e',
  'docs-claims',
  'full-e2e',
  'coverage',
];

/**
 * Whether `reference` is pulled from Docker Hub: an explicit docker.io host, or no registry host
 * at all (a first component without a dot or a port that is not `localhost`).
 * @param {string} reference
 */
export function isDockerHubReference(reference) {
  const slash = reference.indexOf('/');
  if (slash < 0) return true;
  const first = reference.slice(0, slash);
  if (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(first)) return true;
  return !first.includes('.') && !first.includes(':') && first !== 'localhost';
}

/**
 * A job's service containers start before its first step, so no step can route them through a
 * mirror: a service image must not be a Docker Hub reference. A job-level `container.image` is
 * outside this rule on purpose: no workflow runs a job in a container today, and one that starts
 * to should name its image through mirror.gcr.io the same way (extend this rule then).
 * @param {string[]} failures @param {string} relativePath @param {string} source
 */
export function checkServiceImages(failures, relativePath, source) {
  /** @type {number | null} */
  let servicesIndent = null;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (servicesIndent !== null && indent <= servicesIndent) servicesIndent = null;
    if (/^\s*services:\s*$/u.test(line)) {
      servicesIndent = indent;
      continue;
    }
    const image = servicesIndent === null ? null : /^\s*image:\s*['"]?([^'"\s#]+)/u.exec(line);
    if (image?.[1] !== undefined && isDockerHubReference(image[1])) {
      failures.push(
        `${relativePath}:${String(index + 1)}: the service image ${image[1]} is pulled from Docker Hub before any step runs; name it through mirror.gcr.io (mirror.gcr.io/library/<name>:<tag>)`,
      );
    }
  }
}

/**
 * Every job of {@link DOCKER_HUB_JOBS} runs {@link DOCKER_HUB_MIRROR_ACTION} as the step right
 * after its checkout.
 * @param {string[]} failures @param {string} ciSource
 */
export function checkDockerHubJobs(failures, ciSource) {
  for (const jobId of DOCKER_HUB_JOBS) {
    const job = jobBlock(ciSource, jobId);
    const steps = job === null ? [] : job.split(/^ {6}- /mu).slice(1);
    const checkout = steps.findIndex((step) => /uses: actions\/checkout@/u.test(step));
    const next = checkout < 0 ? undefined : steps[checkout + 1];
    const routes = next
      ?.split('\n')
      .some((line) => line.trim() === `uses: ${DOCKER_HUB_MIRROR_ACTION}`);
    if (routes !== true) {
      failures.push(
        `${CI_WORKFLOW}: ${jobId} must route Docker Hub through ${DOCKER_HUB_MIRROR_ACTION} in the step right after its checkout`,
      );
    }
  }
}
