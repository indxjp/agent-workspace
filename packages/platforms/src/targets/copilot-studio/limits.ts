/** Copilot Studio quotas: https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-quotas */
export const COPILOT_STUDIO_LIMITS = {
  /** "Instructions … 8,000 characters", counted in UTF-16 code units like the editor. */
  instructionsChars: 8_000,
  /** "Knowledge sources per agent: 500 across all types". */
  knowledgeSources: 500,
  /** "Files uploaded (number of files): 500". */
  uploadedFiles: 500,
  /** "Topics: 1,000 per agent in Dataverse environments". */
  topics: 1_000,
} as const;
