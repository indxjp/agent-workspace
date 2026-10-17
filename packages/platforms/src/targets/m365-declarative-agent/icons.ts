/**
 * Placeholder icons: the app manifest needs both to validate and the translator has no file system
 * to read brand icons from. A 192x192 solid #5B5FC7 PNG, and a 32x32 PNG with a transparent
 * background and a one-pixel white border.
 */
export const PLACEHOLDER_COLOR_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAABY0lEQVR42u3SMQ0AAAgEsffJgFxsYYEwN6mCy6V64C0SYCAMhIEwEBgIA2EgDAQGwkAYCAOBgTAQBsJAYCAMhIEwEAYCA2EgDISBwEAYCANhIDAQBsJAGAgMhIEwEAbCQGAgDISBMBAYCANhIAwEBsJAGAgDgYEwEAbCQGAgDISBMBAGAgNhIAyEgcBAGAgDYSAwEAbCQBgIDISBMBAGwkBgIAyEgTAQGAgDYSAMBAbCQBgIA4GBMBAGwkAYCAyEgTAQBgIDYSAMhIHAQBgIA2EgMBAGwkAYCAyEgTAQBsJAYCAMhIEwEBgIA2EgDAQGwkAYCAOBgTAQBsJAGAgMhIEwEAYCA2EgDISBwEAYCANhIDAQBsJAGAgDqYCBMBAGwkBgIAyEgTAQGAgDYSAMBAbCQBgIA4GBMBAGwkAYCAyEgTAQBgIDYSAMhIHAQBgIA2EgMBAGwkAYCAOBgTAQBsJAcLUu25yp5CfWegAAAABJRU5ErkJggg==';

export const PLACEHOLDER_OUTLINE_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR42u3OsQ0AAAjDsP7/NEg8UQZnyOxMudxKAQAAAAAAAAAAAAAAAAD8ATRbWpDuIIKs77gAAAAASUVORK5CYII=';

/** `atob`, not `Buffer`: a translator runs in a browser as well as in Node. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}
