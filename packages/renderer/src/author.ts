/*
 * What the form builder and the other authoring tools take from the renderer, apart from the form itself: the control
 * table, the theme and layout helpers the canvas shares with the live form, and the API-driven options and field
 * validation helpers the inspector previews.
 *
 * This is a second entry point (`@form/renderer/author`) so that the respondent's entry (`@form/renderer`) holds
 * only what a public form needs. Code that only this entry reaches (the API helpers) stays out of the respondent's
 * first download and is fetched on demand, the first time a field with an API option list or an API check is used.
 */
export { CONTROLS } from './controls/index.ts';
export {
  buildApiRequest, callFieldApi, defaultSuccess, getAtPath, matchSuccessRule, parseApiBody, postFieldApi,
} from './controls/apiValidation.ts';
export type { ApiCheckResult, ApiCollection, ApiParseResult, ApiResponseLeaf } from './controls/apiValidation.ts';
export { collectionLabel, displayOptionPath, fetchApiOptions, guessMapping, mapApiOptions, pickFromTree } from './controls/apiOptions.ts';
export type { TreePick } from './controls/apiOptions.ts';
export { slotsOf, toWallDateTime } from './controls/appointmentSlots.ts';
export type { AppointmentSlot } from './controls/appointmentSlots.ts';
export type { Control, ControlProps, FieldIds, FieldState, Labelling } from './controls/index.ts';
export { MESSAGES as RENDERER_MESSAGES } from './messages.ts';
export { DEFAULT_COLORS, cssColor, readableOn, themeCssVars } from './theme/cssVars.ts';
export { THEME_SCENES, coverPhoto, pagePhoto, rememberThemeImage, themeImageUrl } from './theme/media.ts';
export type { ThemeScene } from './theme/media.ts';
export { packRows } from './layout/rows.ts';
export { SectionNav, stepsFor } from './SectionNav.tsx';
export type { SectionStep, SectionStepState } from './SectionNav.tsx';
export { listFormSections, resolveSectionNav, sectionIndexForPage, sectionNavAtStart, SUBMIT_SECTION_ID, TITLE_SECTION_ID } from './sections.ts';
export { formTitlePresentation } from './formTitle.ts';
export { submitButtonPresentation } from './submitButton.ts';
export type { FormSection } from './sections.ts';
export { LINK_REL, RichTextView } from './richtext/RichTextView.tsx';
export type { RichTextResolvers, RichTextViewProps } from './richtext/RichTextView.tsx';
export { SignaturePad } from './signature/SignaturePad.tsx';
export type { SignaturePadProps } from './signature/SignaturePad.tsx';
export { Confetti } from './Confetti.tsx';
