'use client';

/** The new-agent form and its form/chat mode entry point. */

import { type AgentResourceOptions } from './model';
import { ReadList } from './agent-form-steps';
import { CARD, CONTROL } from './agent-form-styles';
import { newAgentStrings, type AgentStepWords } from './new-agent-messages';

const EN_WORDS = newAgentStrings('en');

function joinOrNone(labels: readonly string[], none: string): string {
  return labels.length === 0 ? none : labels.join(', ');
}

export function ResourcesStep({
  options,
  fileAccess,
  selectedSkills,
  selectedConnectors,
  onFile,
  onSkill,
  onConnector,
  readOnly = false,
  words = EN_WORDS,
  title = words.resourcesTitle,
}: Readonly<{
  options: AgentResourceOptions;
  fileAccess: Readonly<Record<string, 'read' | 'read-write'>>;
  selectedSkills: ReadonlySet<string>;
  selectedConnectors: ReadonlySet<string>;
  onFile: (id: string, access: 'read' | 'read-write' | null) => void;
  onSkill: (id: string, selected: boolean) => void;
  onConnector: (id: string, selected: boolean) => void;
  readOnly?: boolean;
  /** The reader's words; English when the screen passes none. */
  words?: AgentStepWords;
  /** The form numbers its steps; a screen that shows them in another order names them only. */
  title?: string;
}>) {
  if (readOnly) {
    return (
      <section aria-labelledby="resources-heading" className="mt-4">
        <h2 className="mb-3 text-[15px]" id="resources-heading">
          {title}
        </h2>
        <ReadList
          rows={[
            [
              words.filesAndFolders,
              joinOrNone(
                options.files
                  .filter((row) => fileAccess[row.id] !== undefined)
                  .map(
                    (row) =>
                      `${row.label} (${fileAccess[row.id] === 'read' ? words.fileAccessRead : words.fileAccessReadWrite})`,
                  ),
                words.none,
              ),
            ],
            [
              words.skills,
              joinOrNone(
                options.skills.filter((r) => selectedSkills.has(r.id)).map((r) => r.label),
                words.none,
              ),
            ],
            [
              words.connectors,
              joinOrNone(
                options.connectors.filter((r) => selectedConnectors.has(r.id)).map((r) => r.label),
                words.none,
              ),
            ],
          ]}
        />
      </section>
    );
  }
  return (
    <section aria-labelledby="resources-heading" className="mt-4">
      <h2 className="mb-3 text-[15px]" id="resources-heading">
        {title}
      </h2>
      <div className={`${CARD} grid gap-3 p-4 md:grid-cols-3`}>
        <FileAccessFields
          files={options.files}
          fileAccess={fileAccess}
          onFile={onFile}
          words={words}
        />
        <ResourceCheckboxGroup
          heading={words.skills}
          rows={options.skills}
          selected={selectedSkills}
          onChange={onSkill}
          noneConfigured={words.noneConfigured}
        />
        <ResourceCheckboxGroup
          heading={words.connectors}
          rows={options.connectors}
          selected={selectedConnectors}
          onChange={onConnector}
          noneConfigured={words.noneConfigured}
        />
      </div>
    </section>
  );
}

function ResourceCheckboxGroup({
  heading,
  rows,
  selected,
  onChange,
  noneConfigured,
}: {
  readonly heading: string;
  readonly noneConfigured: string;
  readonly rows: readonly { id: string; label: string }[];
  readonly selected: ReadonlySet<string>;
  readonly onChange: (id: string, selected: boolean) => void;
}) {
  return (
    <fieldset className="rounded border border-border p-3">
      <legend className="px-1 text-[13px] font-semibold">{heading}</legend>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted">{noneConfigured}</p>
      ) : (
        rows.map((row) => (
          <label className="flex items-center gap-2 py-1 text-[13px]" key={row.id}>
            <input
              checked={selected.has(row.id)}
              onChange={(event) => onChange(row.id, event.target.checked)}
              type="checkbox"
            />
            {row.label}
          </label>
        ))
      )}
    </fieldset>
  );
}

function FileAccessFields({
  files,
  fileAccess,
  onFile,
  words,
}: {
  readonly words: AgentStepWords;
  readonly files: AgentResourceOptions['files'];
  readonly fileAccess: Readonly<Record<string, 'read' | 'read-write'>>;
  readonly onFile: (id: string, access: 'read' | 'read-write' | null) => void;
}) {
  return (
    <fieldset className="rounded border border-border p-3">
      <legend className="px-1 text-[13px] font-semibold">{words.filesAndFolders}</legend>
      {files.length === 0 ? (
        <p className="text-[12px] text-muted">{words.noneConfigured}</p>
      ) : (
        files.map((row) => (
          <div className="flex items-center gap-2 py-1" key={row.id}>
            <label className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
              <input
                checked={fileAccess[row.id] !== undefined}
                onChange={(event) => onFile(row.id, event.target.checked ? 'read' : null)}
                type="checkbox"
              />
              <span className="truncate">{row.label}</span>
            </label>
            {fileAccess[row.id] === undefined ? null : (
              <select
                aria-label={words.accessFor(row.label)}
                className={CONTROL}
                onChange={(event) => onFile(row.id, event.target.value as 'read' | 'read-write')}
                value={fileAccess[row.id]}
              >
                <option value="read">{words.read}</option>
                <option value="read-write">{words.readWrite}</option>
              </select>
            )}
          </div>
        ))
      )}
    </fieldset>
  );
}
