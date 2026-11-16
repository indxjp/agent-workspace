import {
  CompleteSetupAnswersSchema,
  type CompleteSetupAnswers,
} from '@indx-workspace/contracts/setup';
import { MODEL_KEY_VARIABLES } from './setup-models.js';

import { openapiTool, postgresTool, secret, type DefineTool } from '../define/index.js';
import { Code, definitionFile, tsString } from './definition-source.js';
import { defined, parsed, projectNameFor } from './render-validation.js';

/**
 * The only operations a rendered OpenAPI tool allows: reads. `GET` alone, because every allow rule
 * must admit an operation of the document (`selectAllowedOperations`) and most documents declare no
 * `HEAD` operation.
 */
const OPENAPI_TOOL_ALLOW = ['GET /**'] as const;

/** One tool file setup writes, and how the agent imports it. */
interface SetupTool {
  readonly name: string;
  /** The agent file's identifier for the tool's default export. */
  readonly identifier: string;
  /** The secret the tool's credential is read from. */
  readonly secret: string;
  readonly path: string;
  readonly contents: string;
  readonly tool: DefineTool;
}

/** `orders` → `ordersTool`, `my-api` → `myApiTool`; a leading digit gets a `_`. */
export function toolIdentifier(name: string): string {
  const camel = name.replace(/-([a-z0-9])/gu, (_, next: string) => next.toUpperCase());
  return `${/^[0-9]/u.test(camel) ? '_' : ''}${camel}Tool`;
}

/** `secret('NAME')` as code. */
function secretCall(name: string): Code {
  return new Code(`secret(${tsString(name)})`);
}

/** The OpenAPI tool for `document`, named after its last non-empty path segment up to the first `.`. */
function openapiSetupTool(document: string): SetupTool {
  const file = (document.split(/[?#]/u, 1)[0] ?? '').split('/').filter(Boolean).at(-1) ?? '';
  const name = projectNameFor(file.split('.', 1)[0] ?? '');
  const secretName = `${name.toUpperCase().replaceAll('-', '_')}_TOKEN`;
  const path = `tools/${name}.ts`;
  // ponytail: a document named aw.json yields AW_TOKEN (reserved prefix), and one whose stem
  // starts with a digit (2024.json) yields 2024_TOKEN (SECRET_NAME_PATTERN needs a leading
  // letter); both are refused at render as a ProjectRenderError, before create's confirmation;
  // rename the file
  const tool = defined(path, () =>
    openapiTool({ name, spec: document, auth: secret(secretName), allow: OPENAPI_TOOL_ALLOW }),
  );
  const contents = definitionFile(
    'openapiTool',
    {
      name,
      spec: document,
      auth: secretCall(secretName),
      allow: new Code(`[${OPENAPI_TOOL_ALLOW.map(tsString).join(', ')}]`),
    },
    { sdk: ['secret'] },
  );
  return { name, identifier: toolIdentifier(name), secret: secretName, path, contents, tool };
}

/** The PostgreSQL tool; its URL is the secret `POSTGRES_URL`, as `DATABASE_URL` is reserved. */
function postgresSetupTool(): SetupTool {
  const name = 'postgres';
  const secretName = 'POSTGRES_URL';
  const path = `tools/${name}.ts`;
  // ponytail: no question asks for tables, so one placeholder table is written; aw dev's dry run
  // refuses it until edited — upgrade: a content.postgresTables question
  const tables = ['public.your_table'];
  const tool = defined(path, () =>
    postgresTool({ name, url: secret(secretName), readOnly: true, tables }),
  );
  const contents = definitionFile(
    'postgresTool',
    { name, url: secretCall(secretName), readOnly: true, tables },
    { sdk: ['secret'] },
  );
  return { name, identifier: toolIdentifier(name), secret: secretName, path, contents, tool };
}

/** The tools the internal-tools answer asks for, sorted by name. */
export function setupTools(valid: CompleteSetupAnswers): readonly SetupTool[] {
  const chosen = valid['content.internalTools'];
  const document = valid['content.openapiDocument'];
  const tools = [
    ...(chosen.includes('openapi') && document !== undefined ? [openapiSetupTool(document)] : []),
    ...(chosen.includes('postgres') ? [postgresSetupTool()] : []),
  ];
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The environment variables a project rendered from `answers` reads its secrets from: the model
 * key's, then each tool's credential's, in file order. `create` names them as the variables to
 * export; only names are ever written, never a value.
 *
 * @throws {ProjectRenderError} when an answer is refused.
 */
export function setupSecretNames(answers: CompleteSetupAnswers): readonly string[] {
  const valid = parsed(CompleteSetupAnswersSchema, answers, 'the setup answers');
  return Object.freeze([
    MODEL_KEY_VARIABLES[valid['admin.modelProvider']],
    ...setupTools(valid).map((tool) => tool.secret),
  ]);
}
