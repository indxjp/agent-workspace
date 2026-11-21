// A coverage fixture: a CommonJS script no test runs, which the gate must still see.
'use strict';

function half(value) {
  return value / 2;
}

globalThis.fixtureHalf = half;
