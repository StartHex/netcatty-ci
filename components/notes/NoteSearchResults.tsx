import { ChevronDown, ChevronUp, X } from "lucide-react";
import React, { memo, useMemo } from "react";

import {
  splitTextByNoteSearchRanges,
  type NoteSearchHit,
  type NoteSearchRange,
} from "../../domain/notes/noteSearch";
import { cn } from "../../lib/utils";

/** Renders `text` with `<mark>` around every search range. */
export const NoteSearchHighlightedText = memo(function NoteSearchHighlightedText({
  text,
  ranges,
  markClassName,
}: {
  text: string;
  ranges: readonly NoteSearchRange[];
  markClassName?: string;
}) {
  const segments = useMemo(() => splitTextByNoteSearchRanges(text, ranges), [text, ranges]);
  if (ranges.length === 0) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className={cn("netcatty-search-mark", markClassName)} data-note-search-mark="true">
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  );
});

export const formatNoteSearchCount = (count: number, capped: boolean): string =>
  capped ? `${count}+` : String(count);

export interface NoteSearchSnippetListProps {
  hit: NoteSearchHit;
  /** Tree depth of the owning note row (snippets indent one level deeper). */
  depth: number;
  selected: boolean;
  moreLabel: (count: number) => string;
  onSelectOccurrence: (occurrence: number) => void;
}

/**
 * Content snippets under a note row while the tree is filtered by a search.
 * Each line jumps straight to its occurrence in the editor.
 */
export const NoteSearchSnippetList = memo(function NoteSearchSnippetList({
  hit,
  depth,
  selected,
  moreLabel,
  onSelectOccurrence,
}: NoteSearchSnippetListProps) {
  const remaining = Math.max(0, hit.bodyMatchCount - hit.nextOccurrence);
  if (hit.snippets.length === 0 && !hit.meta) return null;
  return (
    <div
      className="nc-anim-slide-down space-y-px pb-0.5"
      style={{ paddingLeft: depth * 16 + 30 }}
      data-note-search-snippets={hit.noteId}
    >
      {hit.snippets.map((snippet) => (
        <button
          key={`${snippet.occurrence}-${snippet.line}`}
          type="button"
          className={cn(
            "flex h-5 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-left text-[11px] leading-4 text-muted-foreground transition-colors",
            selected ? "hover:bg-secondary" : "hover:bg-secondary/60 hover:text-foreground",
          )}
          title={`${snippet.leadingEllipsis ? "…" : ""}${snippet.text}${snippet.trailingEllipsis ? "…" : ""}`}
          data-note-search-snippet={snippet.occurrence}
          onClick={(event) => {
            event.stopPropagation();
            onSelectOccurrence(snippet.occurrence);
          }}
        >
          <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums opacity-60">
            {snippet.line}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {snippet.leadingEllipsis ? "…" : ""}
            <NoteSearchHighlightedText text={snippet.text} ranges={snippet.highlights} />
            {snippet.trailingEllipsis ? "…" : ""}
          </span>
        </button>
      ))}
      {remaining > 0 ? (
        <button
          type="button"
          className="flex h-5 w-full items-center rounded px-1.5 pl-[34px] text-left text-[11px] leading-4 text-primary/80 transition-colors hover:bg-secondary/60 hover:text-primary"
          onClick={(event) => {
            event.stopPropagation();
            onSelectOccurrence(hit.nextOccurrence);
          }}
        >
          {moreLabel(remaining)}
        </button>
      ) : null}
      {hit.meta ? (
        <div className="flex h-5 min-w-0 items-center px-1.5 pl-[34px] text-[11px] leading-4 text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={hit.meta.text}>
            <NoteSearchHighlightedText text={hit.meta.text} ranges={hit.meta.highlights} />
          </span>
        </div>
      ) : null}
    </div>
  );
});

export interface NoteSearchNavigatorProps {
  /** 0-based active occurrence, or null when nothing is focused yet. */
  activeIndex: number | null;
  total: number;
  /** Prev/next stay usable while other result notes still have matches. */
  canNavigate?: boolean;
  labels: {
    previous: string;
    next: string;
    close: string;
    noMatches: string;
  };
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  className?: string;
}

/** Floating "3 / 12 ↑ ↓ ×" pill shown over the editor while a search is active. */
export const NoteSearchNavigator: React.FC<NoteSearchNavigatorProps> = ({
  activeIndex,
  total,
  canNavigate,
  labels,
  onPrevious,
  onNext,
  onClose,
  className,
}) => {
  const hasMatches = total > 0;
  const navigable = canNavigate ?? hasMatches;
  const position = hasMatches
    ? `${activeIndex === null ? "–" : Math.min(activeIndex, total - 1) + 1}/${total}`
    : labels.noMatches;
  return (
    <div
      className={cn(
        "nc-anim-pop-in pointer-events-auto flex h-7 items-center gap-0.5 rounded-md border border-border/70 bg-background/95 px-1 text-[11px] text-muted-foreground shadow-md backdrop-blur",
        className,
      )}
      data-note-search-navigator="true"
      role="toolbar"
    >
      <span
        className={cn(
          "min-w-[44px] px-1 text-center tabular-nums",
          hasMatches ? "text-foreground" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {position}
      </span>
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label={labels.previous}
        title={labels.previous}
        disabled={!navigable}
        onClick={onPrevious}
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label={labels.next}
        title={labels.next}
        disabled={!navigable}
        onClick={onNext}
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-secondary hover:text-foreground"
        aria-label={labels.close}
        title={labels.close}
        onClick={onClose}
      >
        <X size={12} />
      </button>
    </div>
  );
};
