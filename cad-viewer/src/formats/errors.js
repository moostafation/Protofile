/**
 * A file that cannot be opened. `hint` names an unsupported-format explanation
 * (i18n key hint_<name>) shown in a dialog instead of a plain error toast, and
 * `label` is the detected format's name for that dialog.
 */
export class FormatError extends Error {
  constructor(message, hint = null, label = null) {
    super(message);
    this.name = 'FormatError';
    this.hint = hint;
    this.label = label;
  }
}
