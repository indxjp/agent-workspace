/**
 * `@indx-workspace/sdk/portable` — the portable agent file (ADR-0133 D2, D3).
 *
 * - **Reading.** {@link parseAgentMarkdown} reads `agents/<name>.agent.md`: YAML front matter, read
 *   with the project file's reader and its ADR-0089 refusals, then the instructions as Markdown.
 *   Every refusal is a `ProjectFileError` naming its file, line and column.
 * - **Writing.** {@link formatAgentMarkdown} writes the one canonical text the parser reads back
 *   deep-equal.
 * - **Converting.** {@link portableFromAgentVersionBody} is the one mapping from a stored version
 *   body; {@link toPortableAgent} reaches it from a `defineAgent` value, and
 *   {@link defineAgentFromPortable} goes back through `defineAgent()`. Each answers the value and
 *   a `dropped` list of everything it could not carry (ADR-0133 D5).
 * - **Printing.** {@link printAgentProject} writes a stored version body as `agents/<name>.ts` and
 *   `agents/<name>.md`, importing its module tools from the project; a `PrintError` names every
 *   part of the body it cannot write as code.
 * - **Diffing.** {@link diffBodies} lists what one version body changes relative to another, section
 *   by section; the console and `aw agents new` print the same list, and {@link uncoveredKeys}
 *   names what changes outside it.
 * - **Loading.** {@link loadPortableProject} assembles a `PortableProject` from a project's agents
 *   and the skill, knowledge and OpenAPI bytes a caller-injected {@link PortableProjectSource} reads.
 * - **Types.** `PortableAgent` and `PortableProject` are re-exported from the contracts, so an
 *   author imports one path.
 * - **Isomorphic.** No Node.js module is imported; reading and writing the files is the caller's job.
 *
 * @packageDocumentation
 */
export {
  defineAgentFromPortable,
  portableFromAgentVersionBody,
  toPortableAgent,
  type PortableAgentContext,
  type PortableCodeToolDeclaration,
  type PortableConversion,
  type PortableDrop,
} from './convert.js';
export {
  DEFINITION_SECTIONS,
  diffBodies,
  uncoveredKeys,
  type DefinitionChange,
  type DefinitionSection,
} from './diff.js';
export { AGENT_MARKDOWN_SUFFIX, formatAgentMarkdown, parseAgentMarkdown } from './markdown.js';
export {
  PrintError,
  printAgentProject,
  type PrintedAgentProject,
  type PrintedFile,
  type PrintOptions,
} from './print.js';
export {
  loadPortableProject,
  PortableProjectError,
  type LoadPortableProjectInput,
  type PortableProjectLoad,
  type PortableProjectSource,
} from './project.js';
export type {
  PortableAgent,
  PortableAgentInput,
  PortableProject,
  PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
