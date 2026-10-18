export type TemplateCoreErrorCode =
  | 'wrong_template_kind'
  | 'page_not_found'
  | 'block_not_found'
  | 'snippet_already_inserted'
  | 'lock_target_in_ops'
  | 'lock_target_in_definition';

/** A call the engine cannot carry out (wrong template kind, unknown insertion point …); never thrown for content issues. */
export class TemplateCoreError extends Error {
  readonly code: TemplateCoreErrorCode;

  constructor(code: TemplateCoreErrorCode, message: string) {
    super(message);
    this.name = 'TemplateCoreError';
    this.code = code;
  }
}
