/**
 * Terminal line panel: go to a line, copy a range of lines, and work with
 * line marks. Opens over the top-right corner of the terminal.
 */
import { Bookmark, ChevronDown, ChevronUp, Copy, CornerDownLeft, Trash2, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';

import { useI18n } from '../../application/i18n/I18nProvider';
import { useClipboardBackend } from '../../application/state/useClipboardBackend';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import {
  getTerminalLineTools,
  parseLineRangeInput,
  type LineToolsTerminal,
  type TerminalLineMark,
  type TerminalLineTools,
} from './runtime/terminalLineTools';

export type TerminalLinePanelNotice = { kind: 'success' | 'error' | 'info'; message: string };

export interface TerminalLinePanelProps {
  termRef: RefObject<XTerm | null>;
  isOpen: boolean;
  /** Bumped when the hotkey fires while the panel is open, to take focus back. */
  focusToken: number;
  top: string;
  right: number;
  onClose: () => void;
  onNotify: (notice: TerminalLinePanelNotice) => void;
}

const FG = 'var(--terminal-ui-fg, #ffffff)';
const mix = (percent: number) => `color-mix(in srgb, ${FG} ${percent}%, transparent)`;

const iconButtonClass =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-30 hover:bg-[color:var(--terminal-toolbar-btn-hover)]';
const textButtonClass =
  'flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[11px] transition-colors disabled:opacity-30 hover:bg-[color:var(--terminal-toolbar-btn-hover)]';

const getTools = (termRef: RefObject<XTerm | null>): TerminalLineTools | null => {
  const term = termRef.current;
  return term ? getTerminalLineTools(term as unknown as LineToolsTerminal) : null;
};

export const TerminalLinePanel: React.FC<TerminalLinePanelProps> = ({
  termRef,
  isOpen,
  focusToken,
  top,
  right,
  onClose,
  onNotify,
}) => {
  const { t } = useI18n();
  const { writeClipboardText } = useClipboardBackend();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [marks, setMarks] = useState<TerminalLineMark[]>([]);
  const [range, setRange] = useState<{ first: number; last: number }>({ first: 1, last: 1 });
  const [hint, setHint] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const tools = getTools(termRef);
    if (!tools) return;
    setMarks(tools.listMarks());
    setRange(tools.getRange());
  }, [termRef]);

  useEffect(() => {
    if (!isOpen) return;
    refresh();
    const tools = getTools(termRef);
    const unsubscribe = tools?.onChange(refresh);
    // New output moves the last line number; keep the shown range current.
    const timer = setInterval(refresh, 1000);
    return () => {
      unsubscribe?.();
      clearInterval(timer);
    };
  }, [isOpen, refresh, termRef]);

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isOpen, focusToken]);

  const parsed = useMemo(() => parseLineRangeInput(value), [value]);

  const close = useCallback(() => {
    onClose();
    termRef.current?.focus();
  }, [onClose, termRef]);

  const goTo = useCallback(() => {
    const tools = getTools(termRef);
    if (!tools || !parsed) return;
    const shown = tools.goToLine(parsed.from);
    setHint(shown === parsed.from ? null : t('terminal.lines.clamped', { line: shown }));
    refresh();
  }, [parsed, refresh, t, termRef]);

  const copyRange = useCallback(async (from: number, to: number) => {
    const tools = getTools(termRef);
    if (!tools) return;
    const read = tools.readRange(from, to);
    if (!read) {
      onNotify({ kind: 'error', message: t('terminal.lines.copy.unavailable') });
      return;
    }
    try {
      // The system clipboard through the main process first: the browser
      // clipboard refuses to write while the window is not focused.
      let written = false;
      try { written = await writeClipboardText(read.text); } catch { /* Use the browser clipboard. */ }
      if (!written) await navigator.clipboard.writeText(read.text);
      onNotify({
        kind: 'success',
        message: t(read.clamped ? 'terminal.lines.copy.doneClamped' : 'terminal.lines.copy.done', {
          from: read.from,
          to: read.to,
          count: read.rows,
        }),
      });
    } catch {
      onNotify({ kind: 'error', message: t('terminal.lines.copy.failed') });
    }
  }, [onNotify, t, termRef, writeClipboardText]);

  const copyTyped = useCallback(() => {
    if (!parsed) return;
    void copyRange(parsed.from, parsed.to ?? parsed.from);
  }, [copyRange, parsed]);

  const stepMark = useCallback((direction: 1 | -1) => {
    const step = getTools(termRef)?.stepMark(direction);
    if (step) setHint(t('terminal.lines.marks.position', { index: step.index + 1, total: step.total, line: step.lineNumber }));
  }, [t, termRef]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) copyTyped();
      else goTo();
    }
  };

  if (!isOpen) return null;

  const invalid = value.trim().length > 0 && !parsed;
  const firstMark = marks[0];
  const lastMark = marks[marks.length - 1];

  return (
    <div
      className="absolute z-30 w-[300px] rounded-md border shadow-lg pointer-events-auto"
      style={{
        top,
        right,
        backgroundColor: 'var(--terminal-ui-bg, #000000)',
        borderColor: mix(14),
        color: FG,
      }}
      data-section="terminal-line-panel"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1 p-1.5">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setHint(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t('terminal.lines.placeholder')}
          aria-label={t('terminal.lines.placeholder')}
          aria-invalid={invalid}
          data-terminal-line-input=""
          className="h-6 min-w-0 flex-1 rounded border-none px-2 text-[11px] tabular-nums placeholder:opacity-40 focus:outline-none"
          style={{
            backgroundColor: mix(5),
            color: FG,
            boxShadow: invalid ? 'inset 0 0 0 1px #ef4444' : undefined,
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={iconButtonClass} style={{ color: mix(70) }} disabled={!parsed} onClick={goTo} aria-label={t('terminal.lines.go')}>
              <CornerDownLeft size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.lines.go')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={iconButtonClass} style={{ color: mix(70) }} disabled={!parsed} onClick={copyTyped} aria-label={t('terminal.lines.copy')}>
              <Copy size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.lines.copy')}</TooltipContent>
        </Tooltip>
        <button type="button" className={iconButtonClass} style={{ color: mix(60) }} onClick={close} aria-label={t('common.close')}>
          <X size={13} />
        </button>
      </div>
      <div className="px-2 pb-1.5 text-[10px] leading-4" style={{ color: invalid ? '#f87171' : mix(50) }}>
        {invalid
          ? t('terminal.lines.invalid')
          : hint ?? t('terminal.lines.range', { first: range.first, last: range.last })}
      </div>

      <div className="flex items-center gap-0.5 border-t px-1.5 py-1" style={{ borderColor: mix(10) }}>
        <Bookmark size={11} className="ml-0.5 shrink-0" style={{ color: '#f59e0b' }} />
        <span className="ml-1 mr-auto text-[11px]" style={{ color: mix(70) }}>
          {t('terminal.lines.marks.title', { count: marks.length })}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={iconButtonClass} style={{ color: mix(70) }} disabled={marks.length === 0} onClick={() => stepMark(-1)} aria-label={t('terminal.lines.marks.prev')}>
              <ChevronUp size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.lines.marks.prev')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={iconButtonClass} style={{ color: mix(70) }} disabled={marks.length === 0} onClick={() => stepMark(1)} aria-label={t('terminal.lines.marks.next')}>
              <ChevronDown size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.lines.marks.next')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={iconButtonClass} style={{ color: mix(70) }} disabled={marks.length === 0} onClick={() => getTools(termRef)?.clearMarks()} aria-label={t('terminal.lines.marks.clear')}>
              <Trash2 size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('terminal.lines.marks.clear')}</TooltipContent>
        </Tooltip>
      </div>

      {marks.length === 0 ? (
        <div className="px-2 pb-2 text-[10px] leading-4" style={{ color: mix(45) }}>
          {t('terminal.lines.marks.empty')}
        </div>
      ) : (
        <div className="max-h-40 overflow-y-auto px-1 pb-1">
          {marks.map((mark, index) => (
            <div
              key={mark.id}
              className="group flex h-6 cursor-pointer items-center gap-2 rounded px-1.5 text-[11px] hover:bg-[color:var(--terminal-toolbar-btn-hover)]"
              data-terminal-line-mark={mark.lineNumber}
              onClick={() => {
                const step = getTools(termRef)?.visitMark(mark.id);
                if (step) setHint(t('terminal.lines.marks.position', { index: step.index + 1, total: step.total, line: step.lineNumber }));
              }}
            >
              <span className="w-4 shrink-0 text-right tabular-nums" style={{ color: mix(40) }}>{index + 1}</span>
              <span className="shrink-0 font-medium tabular-nums" style={{ color: '#f59e0b' }}>{mark.lineNumber}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: mix(60) }}>{mark.preview}</span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color:var(--terminal-toolbar-btn-hover)]"
                style={{ color: mix(60) }}
                aria-label={t('terminal.lines.marks.remove')}
                onClick={(event) => {
                  event.stopPropagation();
                  getTools(termRef)?.removeMark(mark.id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {marks.length >= 2 && firstMark && lastMark && (
        <div className="border-t p-1.5" style={{ borderColor: mix(10) }}>
          <button
            type="button"
            className={`${textButtonClass} w-full justify-center`}
            style={{ color: mix(80), backgroundColor: mix(5) }}
            onClick={() => void copyRange(firstMark.lineNumber, lastMark.lineNumber)}
          >
            <Copy size={11} />
            {t('terminal.lines.marks.copyBetween', { from: firstMark.lineNumber, to: lastMark.lineNumber })}
          </button>
        </div>
      )}
    </div>
  );
};
