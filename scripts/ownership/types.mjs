/** @typedef {{root?: string | null}} GlobOptions */
/** @typedef {{intersects: boolean, reason: 'tree' | 'literal' | 'disjoint', evidence: string[]}} Intersection */
/** @typedef {{ref: string, globs: string[], files: string[]}} AttributedParent */
/** @typedef {{root: string[], named: {dir: string, probes: string[]}[]}} RepositoryAreas */
/** @typedef {string | Literal[] | {[key: string]: Literal}} Literal */
/** @typedef {Map<string, Map<string, Literal[]>>} OwnershipPlan */
/** @typedef {(name: string, actual: unknown, expected: unknown) => void} Check */
/**
 * @typedef {{
 * check: Check,
 * noRoot: {root: null},
 * m: (glob: string, file: string) => boolean,
 * x: (left: string, right: string, files?: string[]) => boolean,
 * parses: (body: string) => string[] | 'REJECTED',
 * body: string,
 * quotedTemplate: string,
 * areaGlobs: string[],
 * ownsLine: (globs: string[]) => string
 * }} SelfTestContext
 */
export {};
