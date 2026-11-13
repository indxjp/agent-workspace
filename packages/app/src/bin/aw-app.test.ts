import path from 'node:path';

import { parseFieldSpecs, renderResourceSpec } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { createTableSql } from '../db/create-table-sql.js';
import type { MigrateAppOptions } from '../db/migrate.js';
import { MIGRATE_USAGE, runAwAppMigrate, type AwAppMigrateDeps } from './migrate.js';
import { RECIPE_ON_USAGE, runAwAppRecipeOn } from './recipe-on.js';
import { enumOf, money, person, richText, text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import { AW_APP_EXIT, resourceFromSpec, runAwApp } from './sql.js';

function run(argv: readonly string[]) {
  let stdout = '';
  let stderr = '';
  const code = runAwApp(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const ARGUMENTS = [
  'title:text(200)',
  'notes:richText?',
  'amount:money(JPY)',
  'stage:enum(lead,won,lost)',
  'owner:person?',
];
const SPEC = { name: 'deal', fields: parseFieldSpecs(ARGUMENTS), board: 'stage' };

describe('aw-app sql', () => {
  it('prints createTableSql of the resource the generated file defines', () => {
    const written = defineResource({
      name: 'deal',
      fields: {
        title: text({ max: 200 }),
        notes: richText({ optional: true }),
        amount: money({ currency: 'JPY' }),
        stage: enumOf(['lead', 'won', 'lost']),
        owner: person({ optional: true }),
      },
      access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
      agents: { read: true, write: false },
      search: ['title', 'notes'],
      board: 'stage',
    });

    const result = run(['sql', '--app', 'sales', JSON.stringify(SPEC)]);

    expect(result).toEqual({
      code: AW_APP_EXIT.ok,
      stdout: createTableSql(written, 'sales'),
      stderr: '',
    });
  });

  it('searches the fields the resource template lists in search', () => {
    const resource = resourceFromSpec(SPEC);
    const templateOptions = renderResourceSpec('deal', SPEC.fields, { board: 'stage' })['options'];

    expect(templateOptions).toContain(
      `search: [${resource.search.map((name) => `'${name}'`).join(', ')}]`,
    );
    expect(resource.board).toBe('stage');
  });

  it('takes --app=<name> too', () => {
    expect(run(['sql', `--app=sales`, JSON.stringify(SPEC)]).code).toBe(AW_APP_EXIT.ok);
  });

  it.each([
    ['not JSON', '{', /not JSON/u],
    ['an unknown key', JSON.stringify({ ...SPEC, extra: true }), /extra/u],
    [
      'an unknown field type',
      JSON.stringify({
        name: 'deal',
        fields: [{ name: 'a', type: 'blob', args: [], optional: false }],
      }),
      /fields\.0\.type/u,
    ],
    ['no fields', JSON.stringify({ name: 'deal', fields: [] }), /fields/u],
    [
      'a currency the builder refuses',
      JSON.stringify({
        name: 'deal',
        fields: [{ name: 'a', type: 'money', args: ['yen'], optional: false }],
      }),
      /currency/u,
    ],
    ['a board that is no enum field', JSON.stringify({ ...SPEC, board: 'title' }), /board/u],
  ])('refuses %s with exit 1 and prints no SQL', (_case, spec, reason) => {
    const result = run(['sql', '--app', 'sales', spec]);

    expect(result.code).toBe(AW_APP_EXIT.refused);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(reason);
  });

  it('refuses an app name that is not a name key', () => {
    const result = run(['sql', '--app', 'Sales Team', JSON.stringify(SPEC)]);

    expect(result.code).toBe(AW_APP_EXIT.refused);
    expect(result.stderr).toMatch(/app name/u);
  });

  it.each([
    [[]],
    [['migrate']],
    [['sql', JSON.stringify(SPEC)]],
    [['sql', '--app', 'sales']],
    [['sql', '--app', 'sales', '{}', '{}']],
    [['sql', '--force', '--app', 'sales', '{}']],
  ])('answers a misused line %j with the usage and exit 2', (argv) => {
    const result = run(argv);

    expect(result.code).toBe(AW_APP_EXIT.usage);
    expect(result.stderr).toContain('usage: aw-app sql --app <name> <resource-spec-json>');
  });

  it('prints the usage for --help', () => {
    expect(run(['--help'])).toMatchObject({ code: AW_APP_EXIT.ok, stderr: '' });
  });
});

describe('aw-app migrate (issue #1506)', () => {
  const DATABASE_URL =
    'postgresql://agent_workspace:agent_workspace_local@127.0.0.1:25432/postgres';

  async function migrate(
    argv: readonly string[],
    options: {
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly migrateApp?: AwAppMigrateDeps['migrateApp'];
    } = {},
  ) {
    let stdout = '';
    let stderr = '';
    const calls: MigrateAppOptions[] = [];
    const migrator = options.migrateApp ?? (() => Promise.resolve({ applied: 2, ledgerTotal: 2 }));
    const code = await runAwAppMigrate(
      argv,
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
      {
        env: options.env ?? { DATABASE_URL },
        cwd: '/project',
        migrateApp: (input) => {
          calls.push(input);
          return migrator(input);
        },
      },
    );
    return { code, stdout, stderr, calls };
  }

  it('calls migrateApp with DATABASE_URL, the app and the folder under the working directory', async () => {
    const result = await migrate(['--app', 'desk', '--dir', 'db/migrations']);

    expect(result.calls).toStrictEqual([
      {
        url: DATABASE_URL,
        appName: 'desk',
        migrationsFolder: path.resolve('/project', 'db/migrations'),
      },
    ]);
    expect(result).toMatchObject({
      code: AW_APP_EXIT.ok,
      stdout: 'migrated app_desk: 2 applied, 2 in total\n',
      stderr: '',
    });
  });

  it('exits non-zero with the reason on stderr when the migration fails, and never echoes the URL', async () => {
    const result = await migrate(['--app=desk', '--dir=db/migrations'], {
      migrateApp: () => Promise.reject(new Error('App migration drift in app_desk')),
    });

    expect(result.code).toBe(AW_APP_EXIT.refused);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('error: App migration drift in app_desk\n');
    expect(result.stderr).not.toContain('agent_workspace_local');
  });

  it.each([[{}], [{ DATABASE_URL: '' }], [{ DATABASE_URL: 'mysql://u:p@127.0.0.1/app' }]])(
    'refuses the environment %j without calling the migrator',
    async (env) => {
      const result = await migrate(['--app', 'desk', '--dir', 'db/migrations'], { env });

      expect(result.code).toBe(AW_APP_EXIT.refused);
      expect(result.stderr).toMatch(/DATABASE_URL must be set/u);
      expect(result.calls).toStrictEqual([]);
    },
  );

  it('refuses an app name that is not a name key', async () => {
    const result = await migrate(['--app', 'Desk Team', '--dir', 'db/migrations']);

    expect(result.code).toBe(AW_APP_EXIT.refused);
    expect(result.calls).toStrictEqual([]);
  });

  it.each([
    [[]],
    [['--app', 'desk']],
    [['--dir', 'db/migrations']],
    [['--app', 'desk', '--app', 'other', '--dir', 'db']],
    [['--app', 'desk', '--dir', 'db', '--force']],
    [['--app', 'desk', '--dir']],
  ])('answers a misused line %j with the usage and exit 2', async (argv) => {
    const result = await migrate(argv);

    expect(result.code).toBe(AW_APP_EXIT.usage);
    expect(result.stderr).toBe(MIGRATE_USAGE);
    expect(result.calls).toStrictEqual([]);
  });
});

describe('aw-app recipe-on (#1514)', () => {
  function recipeOn(argv: readonly string[]) {
    let stdout = '';
    let stderr = '';
    const code = runAwAppRecipeOn(argv, {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  }

  it.each([
    [['*/5 * * * *']],
    [['0 9 * * 1-5', '--tz', 'Asia/Tokyo']],
    [['0 9 * * *', '--tz=UTC']],
  ])('accepts the schedule %j', (argv) => {
    expect(recipeOn(argv)).toStrictEqual({ code: AW_APP_EXIT.ok, stdout: 'ok\n', stderr: '' });
  });

  it('refuses a bad cron and a bad time zone with every reason and exit 1', () => {
    const result = recipeOn(['61 * * * *', '--tz', 'Mars/Olympus']);
    expect(result.code).toBe(AW_APP_EXIT.refused);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/cron is not a cron expression croner accepts/u);
    expect(result.stderr).toMatch(/timezone must be an IANA time zone/u);
    expect(recipeOn(['* * * *']).stderr).toMatch(/exactly five fields/u);
  });

  it.each([[[]], [['a', 'b']], [['* * * * *', '--tz']], [['* * * * *', '--force']]])(
    'answers a misused line %j with the usage and exit 2',
    (argv) => {
      expect(recipeOn(argv)).toStrictEqual({
        code: AW_APP_EXIT.usage,
        stdout: '',
        stderr: RECIPE_ON_USAGE,
      });
    },
  );
});
