import type { BuilderRefusal } from './definition-from-run';

/** The kinds a missing-reference detail names (`connector:erp`), in words. */
const DETAIL_KINDS: Readonly<Record<string, string>> = {
  connector: 'Connector',
  skill: 'Skill',
  file: 'File or folder',
  environment: 'Environment',
  provider: 'Model connection',
};

/** One detail of a refused check in words: `connector:erp` reads "Connector: erp". */
export function detailText(detail: string): string {
  const colon = detail.indexOf(':');
  const kind = colon === -1 ? undefined : DETAIL_KINDS[detail.slice(0, colon)];
  return kind === undefined ? detail : `${kind}: ${detail.slice(colon + 1)}`;
}

const REFUSALS: Readonly<Record<BuilderRefusal, string>> = {
  builder_disabled: 'An admin has switched the Builder off.',
  builder_model_unavailable: 'The model the Builder uses is not available.',
};

/** Why the Builder cannot run here, in words. */
export function refusalText(refusal: BuilderRefusal): string {
  return REFUSALS[refusal];
}
