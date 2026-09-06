/**
 * The two ways a document operation fails loudly. Reads never throw — a missing or unreadable
 * document is `undefined` — because the caller asked a question. Writes throw, because writing to
 * nothing, or more than the host can hold, is a bug at the call site and the engine's own error
 * (`InvalidEntityError`, `World metadata storage limit exceeded`) names neither the collection nor
 * the target.
 */

/** A write or delete on a target the collection cannot reach right now, or refused outright. */
export class DbTargetError extends Error {
  override readonly name = 'DbTargetError';

  constructor(readonly collection: string, readonly reason: string) {
    super(`${collection}: ${reason}`);
  }
}

/** A document that would not fit in the host's budget. Nothing was written. */
export class DbBudgetError extends Error {
  override readonly name = 'DbBudgetError';

  constructor(readonly collection: string, readonly key: string, readonly size: number, readonly budget: number) {
    super(`${collection}: document '${key}' is ${size} characters, the host holds ${budget}`);
  }
}
