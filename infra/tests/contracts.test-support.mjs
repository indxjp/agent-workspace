import { readFile } from 'node:fs/promises';

/** Read a repository file, relative to the repo root. */
export const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

/**
 * Split a `variables.tf` into `{ name → declaration }`, so a rendered key can be held against
 * both "is this variable declared" and "does the module already default it".
 */
export function declaredVariables(source) {
  const declarations = new Map();
  for (const block of source.split(/\nvariable "/u).slice(1)) {
    const name = block.slice(0, block.indexOf('"'));
    declarations.set(name, block);
  }
  return declarations;
}

/** The generator's committed golden for one cloud's rendered artefact. */
export const golden = (cloud, file) => read(`packages/cli/src/fixtures/${cloud}/${file}`);

/** Looks up one NetworkPolicy block of the chart by name. */
export const networkPolicy = async () => {
  const policies = await read('infra/helm/agent-workspace/templates/networkpolicy.yaml');
  return (name) =>
    policies.split(/^---$/mu).find((block) => block.includes(`metadata: { name: ${name} }`)) ?? '';
};
