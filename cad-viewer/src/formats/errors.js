/**
 * A file that cannot be opened. `hint` names an entry of the unsupported-format
 * explanations (registry HINTS) shown instead of a plain error toast.
 */
export class FormatError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'FormatError';
    this.hint = hint;
  }
}
