#!/usr/bin/env node
/* global process */ // The root ESLint config declares no environment globals.
// Write src/skills.json, the text of every built-in skill in this package.
//
//   node scripts/bundle.mjs
//
// The skills are bundled into the web server as data, so they cannot be read from this package's
// directory at run time (the embedded build holds no workspace package). index.test.ts fails when
// skills.json is not what this script writes.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function filesUnder(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? filesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .filter((relative) => !relative.endsWith('.d.mts'))
    .sort();
}

/** `{ [skill name]: [{ path, content }] }` for each directory of `packageDir` holding a SKILL.md. */
export function bundleSkills(packageDir = PACKAGE_DIR) {
  const bundle = {};
  const names = readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const dir = path.join(packageDir, name);
    const files = filesUnder(dir, '');
    if (!files.includes('SKILL.md')) continue;
    bundle[name] = files.map((file) => ({
      path: file,
      content: readFileSync(path.join(dir, file), 'utf8'),
    }));
  }
  return bundle;
}

export const bundleText = (packageDir) => `${JSON.stringify(bundleSkills(packageDir), null, 2)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  writeFileSync(path.join(PACKAGE_DIR, 'src', 'skills.json'), bundleText());
