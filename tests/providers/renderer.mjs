/** @typedef {import('./types.js').CompatibilityOutcome} CompatibilityOutcome */
/** @typedef {import('./types.js').CompatibilityReport} CompatibilityReport */
/** @typedef {import('./types.js').CompatibilityVerdict} CompatibilityVerdict */

/** @type {Record<CompatibilityVerdict, string>} */
const SYMBOLS = {
  native: String.fromCodePoint(0x2713),
  approximated: '~',
  unsupported: '-',
  failed: String.fromCodePoint(0x2717),
  unverified: '?',
  'not-derivable': 'n/d',
};

/**
 * @param {'passed' | 'failed' | 'skipped' | 'missing'} scenarioStatus
 * @param {'native' | 'approximated' | 'unsupported' | 'missing'} capability
 * @returns {CompatibilityVerdict}
 */
export function decideEvidenceMark(scenarioStatus, capability) {
  if (capability === 'unsupported') return 'unsupported';
  if (scenarioStatus !== 'passed' || capability === 'missing') return 'unverified';
  if (capability === 'native') return 'native';
  if (capability === 'approximated') return 'approximated';
  return 'unverified';
}

/** @param {CompatibilityReport} report @param {readonly string[]} allScenarios */
function completeOutcomes(report, allScenarios) {
  /** @type {Map<string, CompatibilityOutcome>} */
  const table = new Map();
  for (const outcome of report.outcomes) {
    if (table.has(outcome.id)) {
      throw new Error(`provider ${JSON.stringify(report.providerId)} recorded ${outcome.id} twice`);
    }
    if (!(outcome.verdict in SYMBOLS)) {
      throw new Error(
        `provider ${JSON.stringify(report.providerId)} recorded unknown verdict ${JSON.stringify(outcome.verdict)}`,
      );
    }
    if (outcome.verdict === 'approximated' && !outcome.warning?.trim()) {
      throw new Error(
        `provider ${JSON.stringify(report.providerId)} omitted the warning for approximated scenario ${outcome.id}`,
      );
    }
    table.set(outcome.id, outcome);
  }
  for (const id of allScenarios) {
    if (!table.has(id)) {
      throw new Error(`provider ${JSON.stringify(report.providerId)} omitted scenario ${id}`);
    }
  }
  if (table.size !== allScenarios.length) {
    throw new Error(`provider ${JSON.stringify(report.providerId)} recorded an unknown scenario`);
  }
  return table;
}

/** @param {Map<string, CompatibilityOutcome>} outcomes @param {string} id */
function requireOutcome(outcomes, id) {
  const outcome = outcomes.get(id);
  if (!outcome) throw new Error(`scenario ${id} has no outcome`);
  return outcome;
}

/** @param {readonly CompatibilityReport[]} reports @param {readonly string[]} allScenarios */
export function renderCompatibilityMatrixWithScenarios(reports, allScenarios) {
  if (reports.length === 0) return '';
  const seen = new Set();
  const rows = reports.map((report) => {
    if (seen.has(report.providerId)) {
      throw new Error(
        `duplicate compatibility report for provider ${JSON.stringify(report.providerId)}`,
      );
    }
    seen.add(report.providerId);
    return { report, outcomes: completeOutcomes(report, allScenarios) };
  });
  const header = `| Provider | ${allScenarios.join(' | ')} |`;
  const divider = `| --- | ${allScenarios.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    ({ report, outcomes }) =>
      `| ${report.providerId} | ${allScenarios.map((id) => SYMBOLS[requireOutcome(outcomes, id).verdict]).join(' | ')} |`,
  );
  const warnings = rows.flatMap(({ report, outcomes }) =>
    allScenarios.flatMap((id) => {
      const outcome = requireOutcome(outcomes, id);
      return outcome.verdict === 'approximated'
        ? [`- ${report.providerId} / ${id}: ${outcome.warning}`]
        : [];
    }),
  );
  return [
    '# Provider compatibility',
    '',
    header,
    divider,
    ...body,
    '',
    'Legend:',
    '',
    '```text',
    `${SYMBOLS.native} native/compatible`,
    `${SYMBOLS.approximated} approximated`,
    `${SYMBOLS.unsupported} unsupported`,
    '```',
    '',
    `${SYMBOLS.failed} conformance test failed`,
    `${SYMBOLS.unverified} not verified in this build`,
    `${SYMBOLS['not-derivable']} not derivable from the available scenario or out of release scope`,
    ...(warnings.length === 0 ? [] : ['', 'Approximations:', '', ...warnings]),
    '',
  ].join('\n');
}
