import type { MarkdownActionType, NoteHeadingItem } from "../../domain/notes";

export interface InlineMarkdownEditorHandle {
  executeAction: (action: MarkdownActionType) => void;
  focus: () => void;
  scrollToHeading: (heading: NoteHeadingItem, headingIndex: number) => boolean;
}

export type NoteEditorMode = "edit" | "preview" | "source" | "live";

/**
 * Search highlighting requested by the notes tree. Every occurrence of the
 * terms is painted; `activeOccurrence` (0-based, document order) gets the
 * strong color, and each new `revealToken` scrolls it into view once.
 */
export interface NoteSearchHighlightRequest {
  terms: readonly string[];
  activeOccurrence: number | null;
  revealToken: number;
}

/** Active text-format toggles at the current selection (toolbar highlight). */
export type ActiveTextFormats = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
};

export const EMPTY_ACTIVE_FORMATS: ActiveTextFormats = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  code: false,
};
