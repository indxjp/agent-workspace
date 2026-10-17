/**
 * The one error type the test-service launcher raises on purpose. `code` is stable and names the
 * expected failure (an invalid `AW_TEST_SERVICES`, a missing Docker daemon, an unsupported host, a
 * checksum mismatch, a service that never became ready), so a reader of the log and a test can both
 * tell it from an unexpected crash.
 */
export class TestServicesError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'TestServicesError';
    this.code = code;
  }
}
