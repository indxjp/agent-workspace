/* global console */
import { globsIntersect, matchGlob } from './globs.mjs';
import { runCrlfBodyCases } from './self-test-crlf-body.mjs';
import { runEnforcementCases } from './self-test-enforcement.mjs';
import { runGlobMatcherCases } from './self-test-glob-matcher.mjs';
import { runIntegrationEnforcementCases } from './self-test-integration-enforcement.mjs';
import { runIntegrationParserCases } from './self-test-integration-parser.mjs';
import { runIntersectionCases } from './self-test-intersection.mjs';
import { runLiteralPrefixCases } from './self-test-literal-prefix.mjs';
import { runPlanParserCases } from './self-test-plan-parser.mjs';
import { runPrBodyCases } from './self-test-pr-body.mjs';
import { runWholeRepositoryCases } from './self-test-whole-repository.mjs';

export function selfTest() {
  let failed = 0;
  /** @type {import('./types.mjs').Check} */
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok)
      console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const noRoot = { root: null };
  /** @type {import('./types.mjs').SelfTestContext['m']} */
  const m = (g, f) => matchGlob(g, f, noRoot);
  /** @type {import('./types.mjs').SelfTestContext['x']} */
  const x = (a, b, files = []) => globsIntersect(a, b, files, noRoot).intersects;
  runGlobMatcherCases({ check, noRoot, m });
  runLiteralPrefixCases({ check });
  runIntersectionCases({ check, x });
  const { parses, body, quotedTemplate, areaGlobs } = runPrBodyCases({ check, noRoot });
  runWholeRepositoryCases({ check, areaGlobs });
  runCrlfBodyCases({ check, parses, body, quotedTemplate });
  runEnforcementCases({ check, noRoot });
  runIntegrationParserCases({ check });
  runIntegrationEnforcementCases({ check, noRoot });
  runPlanParserCases({ check, noRoot });
  console.log(`\n${failed === 0 ? 'SELF-TEST PASSED' : `SELF-TEST FAILED (${failed} case(s))`}`);
  return failed ? 1 : 0;
}
