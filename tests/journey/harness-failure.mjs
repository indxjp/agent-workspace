/** A refusal of the journey: the message names what failed. */
export class JourneyFailure extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'JourneyFailure';
  }
}
