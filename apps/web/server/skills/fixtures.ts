/** Test payloads for the skill import, publish and patch routes. */

/** One file of a skill payload, as those routes accept it (bytes inline, base64). */
export interface SkillPayloadFile {
  readonly path: string;
  readonly contentBase64: string;
}

export function skillPayloadFile(path: string, text: string): SkillPayloadFile {
  return { path, contentBase64: Buffer.from(text).toString('base64') };
}
