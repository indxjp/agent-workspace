#!/usr/bin/env node
/**
 * The `aw-app` bin (issues #1505, #1506, #1514): the app-kit work `aw` needs from a project's own
 * install, which it spawns because it may not import the app kit. `sql` prints a resource's
 * migration (`runAwApp` in `./sql.ts`); `migrate` applies the app's migrations (`runAwAppMigrate`
 * in `./migrate.ts`); `recipe-on` checks a recipe's schedule (`runAwAppRecipeOn` in
 * `./recipe-on.ts`).
 */
import { migrateApp } from '../db/migrate.js';
import { runAwAppMigrate } from './migrate.js';
import { runAwAppRecipeOn } from './recipe-on.js';
import { runAwApp, type AwAppIo } from './sql.js';

const io: AwAppIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};
const [subcommand, ...rest] = process.argv.slice(2);

process.exitCode =
  subcommand === 'migrate'
    ? await runAwAppMigrate(rest, io, { env: process.env, cwd: process.cwd(), migrateApp })
    : subcommand === 'recipe-on'
      ? runAwAppRecipeOn(rest, io)
      : runAwApp(process.argv.slice(2), io);
