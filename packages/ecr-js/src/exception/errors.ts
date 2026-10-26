/**
 * The error types the SDK throws. Named after their PHP and .NET counterparts so
 * a support ticket reads the same on every platform.
 *
 * Results, not errors, carry what happened to a payment: an error is thrown only
 * when a call is refused before anything is sent, or when the SDK itself is used
 * wrongly.
 */

/** A value is outside the rules for it. The .NET SDK throws `ArgumentException`. */
export class InvalidArgumentException extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The SDK was used in a way its own code never should: a programming error. */
export class LogicException extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A number does not fit where it is going: an amount beyond the 64-bit integer
 * the Web Service carries. The .NET SDK throws `OverflowException` from its `checked` cast.
 */
export class OverflowException extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Something outside the SDK failed: a state folder, a file, a lock. */
export class RuntimeException extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
