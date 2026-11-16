/**
 * @typedef {{ op: 'lic', id: string, orLater: boolean }
 * | { op: 'ref', id: string }
 * | { op: 'with', base: SpdxNode, exception: string }
 * | { op: 'and' | 'or', left: SpdxNode, right: SpdxNode }} SpdxNode
 * @typedef {{ value: string, offset: number }} SpdxToken
 * @typedef {'allow' | 'review' | 'deny'} LicenseVerdict
 * @typedef {{ verdict: LicenseVerdict, why: string }} Classification
 * @typedef {{ allow: string[], allowDev?: string[], review: string[],
 * denyFamilies: string[], denyLiteral: string[], denyByName?: string[] }} LicensePolicy
 * @typedef {{ scope: string, allowSet: Set<string>, reviewSet: Set<string>,
 * denySet: Set<string>, denyLiteralSet: Set<string>, denyByName: string[] }} CompiledPolicy
 * @typedef {{ licence: string | string[], scope: string, reviewer: string,
 * reason: string, expires?: unknown, actual?: string }} ExceptionEntry
 * @typedef {Record<string, ExceptionEntry>} ExceptionRegistry
 * @typedef {{ pattern: string, entry: ExceptionEntry, licenceMismatch?: string }} ExceptionMatch
 * @typedef {{ name: string, versions?: unknown }} InventoryPackage
 * @typedef {Record<string, InventoryPackage[]>} LicenseInventory
 * @typedef {Classification & { name: string, version: string, licence: string }} InventoryRow
 * @typedef {{ policy?: LicensePolicy, exceptions?: ExceptionRegistry,
 * scope?: string, now?: number }} EvaluationOptions
 * @typedef {{ compiled: CompiledPolicy, exceptions: ExceptionRegistry,
 * scope: string, now: number }} EvaluationContext
 */
export {};
