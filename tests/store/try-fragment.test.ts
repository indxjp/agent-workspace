/** The email link's fragment: what the sign-in page accepts, and where it sends the visitor. */
import { describe, expect, it } from 'vitest';

import { afterSignInPath, parseLinkFragment } from '../../examples/store/app/sign-in/fragment.ts';

const TOKEN = 'A'.repeat(43);

describe('parseLinkFragment', () => {
  it('reads the token, address and entry', () => {
    expect(parseLinkFragment(`#token=${TOKEN}&email=a%40example.com&entry=ringi-review`)).toEqual({
      token: TOKEN,
      email: 'a@example.com',
      entry: 'ringi-review',
    });
  });

  it('accepts a link with no entry', () => {
    expect(parseLinkFragment(`token=${TOKEN}&email=a@example.com`)).toEqual({
      token: TOKEN,
      email: 'a@example.com',
    });
  });

  it('refuses a missing, short or odd part', () => {
    expect(parseLinkFragment('')).toBeNull();
    expect(parseLinkFragment('#token=short&email=a@example.com')).toBeNull();
    expect(parseLinkFragment(`#token=${TOKEN}`)).toBeNull();
    expect(parseLinkFragment(`#token=${TOKEN}&email=nope`)).toBeNull();
    expect(parseLinkFragment(`#token=${TOKEN}&email=a@example.com&entry=../evil`)).toBeNull();
    expect(parseLinkFragment(`#token=${TOKEN}&email=a@example.com&entry=a/b`)).toBeNull();
  });
});

describe('afterSignInPath', () => {
  it("goes to the entry's Try tab, or to the shelves", () => {
    expect(afterSignInPath('ringi-review')).toBe('/agents/ringi-review#try');
    expect(afterSignInPath(undefined)).toBe('/');
  });
});
