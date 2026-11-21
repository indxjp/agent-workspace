/**
 * The number of data rows in a CSV text: every non-blank line after the header.
 *
 * @param {string} csv
 * @returns {number}
 */
export function tally(csv) {
  const lines = csv.split('\n').filter((line) => line.trim() !== '');
  return lines.length === 0 ? 0 : lines.length - 1;
}
