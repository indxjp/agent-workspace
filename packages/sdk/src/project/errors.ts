/** One reason a project could not be rendered: where (dotted), and why. */
export interface ProjectRenderIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * What the renderers and the writer of `@indx-workspace/sdk/project` throw when an input is
 * refused: setup answers, a project name or version, or a value the project file cannot hold.
 * Nothing has been written when it is thrown.
 */
export class ProjectRenderError extends Error {
  override readonly name = 'ProjectRenderError';
  /** Every reason the input was refused, at least one. */
  readonly issues: readonly ProjectRenderIssue[];

  constructor(subject: string, issues: readonly ProjectRenderIssue[]) {
    super(
      `${subject} could not be rendered: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}
