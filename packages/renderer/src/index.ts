/*
 * The respondent's entry: the form and what a page that hosts it passes in. Keep it that small. Everything the builder
 * and other authoring tools share with the form (control table, theme and layout helpers, API option and check
 * helpers) is exported from `@form/renderer/author`, so that code a public form never runs is not in its first download.
 */
export { FormRenderer } from './FormRenderer.tsx';
export type {
  FormRendererProps, PartialSave, RendererEvent, RendererHandle, RendererSession, SubmitAccepted, SubmitHandler, SubmitPayload, UploadRequest, Uploader,
} from './types.ts';
export { browserSession } from './eval/meta.ts';
