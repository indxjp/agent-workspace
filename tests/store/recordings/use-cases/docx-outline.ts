/**
 * A Word document's outline as a document entry's recorder writes it twice: as the `office-writer`
 * model (`format: "docx"`, one level-1 heading per section, its points as a list, its table) and as
 * the reply that shows the same headings, points and tables, so what the person approves is what the
 * render writes.
 */

/** One section of the document: its heading, its points (each citing its source) and a table. */
export interface DocSection {
  readonly heading: string;
  readonly points: readonly string[];
  /** Whether the points are numbered steps. */
  readonly ordered?: boolean;
  readonly table?: {
    readonly header: readonly string[];
    readonly rows: readonly (readonly string[])[];
  };
}

/** The `office-writer` model of `sections`, under `title`. */
export function docxModel(
  title: string,
  sections: readonly DocSection[],
): Readonly<{ format: 'docx' } & Record<string, unknown>> {
  return {
    format: 'docx',
    title,
    blocks: sections.flatMap((section) => [
      { type: 'heading', level: 1, text: section.heading },
      ...(section.points.length > 0
        ? [
            {
              type: 'list',
              ...(section.ordered === true ? { ordered: true } : {}),
              items: section.points,
            },
          ]
        : []),
      ...(section.table === undefined
        ? []
        : [{ type: 'table', header: section.table.header, rows: section.table.rows }]),
    ]),
  };
}

/** The outline as the reply shows it: each heading, its points and its table. */
export function docxOutline(sections: readonly DocSection[]): string {
  const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return sections
    .map((section) => {
      const lines = [
        `**${section.heading}**`,
        ...section.points.map((point, at) =>
          section.ordered === true ? `${String(at + 1)}. ${point}` : `- ${point}`,
        ),
      ];
      if (section.table !== undefined) {
        lines.push(
          '',
          row(section.table.header),
          row(section.table.header.map(() => '---')),
          ...section.table.rows.map(row),
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
