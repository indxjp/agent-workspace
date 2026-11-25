#!/usr/bin/env node
// The gaps between an IT asset register and what device management detects, by rule, as
// `run_skill_script` runs it (`node analyse.mjs <args>`, no shell):
//
//   analyse.mjs <register.csv|.xlsx> <inventory.csv|.xlsx> [--stale <days>]
//
// It reads the register (one row per PC or licence; the Japanese or the English column names) and
// the device inventory (one row per detected device, its installed software separated by `;`)
// with the built-in table reader (ADR-0173), and matches PCs by serial number. It prints JSON on
// stdout: the PCs in use that were not detected (`missing`), devices detected but not in the
// register (`unregistered`), disposed PCs still detected (`disposedDetected`), PCs whose detected
// user is not the registered one (`userMismatch`), PCs in use last seen more than `--stale` days
// (default 30) before the inventory's latest date (`stale`), each licence's seats owned against
// the detected devices that have it installed (`licences`, every detected device counted once),
// and every note in the register as data. A file, row, column, value or option it cannot read
// prints `{ "error", "message" }` on stderr and exits 1 (2 for the arguments): it never guesses.
// It writes no file.
import { runWhenMain } from '@indx-workspace/builtin-skills/office-reader/scripts/lib/cli.mjs';
import {
  readTable,
  TableError,
} from '@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs';

/** The register's and the inventory's columns: the Japanese and the English name. */
const REGISTER = /** @type {const} */ ({
  id: ['資産番号', 'asset_id'],
  kind: ['区分', 'kind'],
  product: ['品名', 'product'],
  serial: { names: ['シリアル番号', 'serial'], optional: true },
  quantity: { names: ['数量', 'quantity'], type: 'whole' },
  user: { names: ['利用者', 'user'], optional: true },
  status: ['状態', 'status'],
  note: { names: ['備考', 'note'], optional: true },
});
const INVENTORY = /** @type {const} */ ({
  serial: ['シリアル番号', 'serial'],
  host: ['ホスト名', 'hostname'],
  user: { names: ['利用者', 'user'], optional: true },
  lastSeen: { names: ['最終接続日', 'last_seen'], type: 'date' },
  software: { names: ['インストール済みソフト', 'installed_software'], optional: true },
});

/** What a register's kind and status may say, in either language, by the code the script uses. */
const KINDS = { pc: ['pc'], licence: ['ライセンス', 'licence', 'license'] };
const STATUSES = {
  inUse: ['使用中', 'in use'],
  stored: ['保管', 'in storage'],
  disposed: ['廃棄', 'disposed'],
};
/** The code of `table` whose words hold `text`, in any case. */
const codeOf = (/** @type {Record<string, string[]>} */ table, /** @type {string} */ text) =>
  Object.entries(table).find(([, words]) => words.includes(text.toLowerCase()))?.[0];

/** The command line `run_skill_script` passes: the two files, then the option. */
export const SPEC = {
  usage: 'analyse.mjs <register.csv|.xlsx> <inventory.csv|.xlsx> [--stale <days>]',
  positionals: ['register', 'inventory'],
  options: { stale: { default: '30' } },
};

/**
 * The gaps between the register's rows and the inventory's.
 * @param {{ rows: readonly { id: string, kind: string, product: string, serial: string | null, quantity: number, user: string | null, status: string, note: string | null }[], rowNumbers: readonly number[] }} register
 * @param {{ rows: readonly { serial: string, host: string, user: string | null, lastSeen: string, software: string | null }[] }} inventory
 * @param {Readonly<{ stale?: string }>} options
 * @throws {TableError}
 */
export function analyse(register, inventory, options) {
  const stale = options.stale ?? '30';
  if (!/^\d{1,3}$/u.test(stale))
    throw new TableError('usage', `--stale "${stale}" is not 0 to 999 days`);
  if (register.rows.length === 0 || inventory.rows.length === 0)
    throw new TableError('no_rows', 'the register or the inventory has no rows under its header');
  // An asset id, or a PC's serial number, twice in the register is refused (`duplicate_row`).
  /** @type {Set<string>} */
  const seen = new Set();
  const items = register.rows.map((row, at) => {
    const where = { row: Number(register.rowNumbers[at]) };
    const [kind, status] = [codeOf(KINDS, row.kind), codeOf(STATUSES, row.status)];
    if (kind === undefined || status === undefined)
      throw new TableError('unknown_value', `${row.id}: unknown kind or status`, where);
    if (kind === 'pc' && row.serial === null)
      throw new TableError('missing_serial', `${row.id} is a PC with no serial number`, where);
    const keys = [row.id, ...(kind === 'pc' ? [`serial ${String(row.serial)}`] : [])];
    if (keys.some((key) => seen.has(key)))
      throw new TableError('duplicate_row', `${row.id} or its serial number appears twice`, where);
    for (const key of keys) seen.add(key);
    return { ...row, kind, status };
  });
  const pcs = new Map(items.flatMap((item) => (item.kind === 'pc' ? [[item.serial, item]] : [])));
  const devices = new Map(inventory.rows.map((device) => [device.serial, device]));
  if (devices.size < inventory.rows.length)
    throw new TableError('duplicate_row', 'a serial number appears twice in the inventory');
  const asOf = inventory.rows.reduce(
    (last, { lastSeen }) => (lastSeen > last ? lastSeen : last),
    '',
  );
  const daysSince = (/** @type {string} */ day) =>
    (Date.parse(asOf) - Date.parse(day)) / 86_400_000;
  const detected = (/** @type {(typeof items)[number]} */ pc) => devices.get(String(pc.serial));
  const inUse = [...pcs.values()].filter((pc) => pc.status === 'inUse');
  /** @type {Map<string, number>} */
  const owned = new Map();
  for (const item of items)
    if (item.kind === 'licence')
      owned.set(item.product, (owned.get(item.product) ?? 0) + item.quantity);
  const installs = inventory.rows.map(
    (device) => new Set((device.software ?? '').split(';').map((name) => name.trim())),
  );
  return {
    asOf,
    staleDays: Number(stale),
    missing: inUse
      .filter((pc) => detected(pc) === undefined)
      .map(({ id, serial, product, user }) => ({ id, serial, product, user })),
    unregistered: [...devices.values()]
      .filter((device) => !pcs.has(device.serial))
      .map(({ serial, host, user, lastSeen }) => ({ serial, host, user, lastSeen })),
    disposedDetected: [...pcs.values()].flatMap((pc) => {
      const device = detected(pc);
      return pc.status === 'disposed' && device !== undefined
        ? [{ id: pc.id, serial: pc.serial, host: device.host, lastSeen: device.lastSeen }]
        : [];
    }),
    userMismatch: inUse.flatMap((pc) => {
      const user = detected(pc)?.user ?? pc.user;
      return user === pc.user
        ? []
        : [{ id: pc.id, serial: pc.serial, registered: pc.user, detected: user }];
    }),
    stale: inUse.flatMap((pc) => {
      const device = detected(pc);
      if (device === undefined) return [];
      const days = daysSince(device.lastSeen);
      return days > Number(stale)
        ? [{ id: pc.id, serial: pc.serial, user: pc.user, lastSeen: device.lastSeen, days }]
        : [];
    }),
    licences: [...owned].map(([product, seats]) => {
      const installed = installs.filter((names) => names.has(product)).length;
      return { product, owned: seats, installed, gap: installed - seats };
    }),
    notes: items.flatMap(({ id, note }) => (note === null ? [] : [{ id, note }])),
  };
}

/**
 * The command line: read the register and the inventory, then compare them.
 * @param {{ positionals: Readonly<Record<string, string>>, options: Readonly<Record<string, string>> }} args
 */
export const compute = ({ positionals, options }) =>
  analyse(
    readTable(String(positionals['register']), { columns: REGISTER }),
    readTable(String(positionals['inventory']), { columns: INVENTORY }),
    options,
  );

runWhenMain(import.meta.url, SPEC, compute);
