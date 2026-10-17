/**
 * The parser's options, shared by the reader and the writer: the core schema, so `yes` stays text
 * and `0x1f` is the only hex form, and duplicate keys reported by the reader itself.
 */
export const YAML_OPTIONS = { schema: 'core', uniqueKeys: false, prettyErrors: false } as const;
