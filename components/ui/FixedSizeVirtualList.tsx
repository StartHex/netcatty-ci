import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { cn } from '../../lib/utils';
import { getFixedSizeVirtualWindow } from './virtualListMath';

const DEFAULT_OVERSCAN = 6;

export type FixedSizeVirtualListHandle = {
  scrollToIndex: (index: number, align?: 'auto' | 'center') => void;
};

interface FixedSizeVirtualListProps<T> {
  items: T[];
  itemHeight: number;
  className?: string;
  contentClassName?: string;
  overscan?: number;
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Fired with the container scrollTop so callers can mirror the viewport. */
  onScroll?: (scrollTop: number) => void;
  /**
   * Rendered inside the scroll container above the rows. Give it
   * `sticky top-0` to pin it: it then scrolls horizontally with the rows on
   * the compositor instead of being mirrored from JavaScript.
   */
  header?: React.ReactNode;
  /** Height of `header` in pixels; keeps the window math and scrollToIndex exact. */
  headerHeight?: number;
  /** Extra style for the rows wrapper (e.g. a fixed width for horizontal scrolling). */
  contentStyle?: React.CSSProperties;
}

function FixedSizeVirtualListInner<T>(
  {
    items,
    itemHeight,
    className,
    contentClassName,
    overscan = DEFAULT_OVERSCAN,
    getItemKey,
    renderItem,
    onScroll,
    header,
    headerHeight = 0,
    contentStyle,
  }: FixedSizeVirtualListProps<T>,
  ref: React.ForwardedRef<FixedSizeVirtualListHandle>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewportHeight = () => {
      setViewportHeight(container.clientHeight);
    };

    updateViewportHeight();
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const {
    startIndex,
    endIndex,
    effectiveScrollTop,
    totalHeight,
  } = getFixedSizeVirtualWindow({
    itemCount: items.length,
    itemHeight,
    scrollTop,
    viewportHeight: Math.max(0, viewportHeight - headerHeight),
    overscan,
  });

  // When content shrinks (filter / data change) the browser clamps the DOM
  // scroll position by itself; only the React state needs to follow. Layout
  // already uses effectiveScrollTop so the list never blanks for a frame.
  //
  // Never write the state back into container.scrollTop here: the state trails
  // the real position by a frame while the user scrolls, so writing it back
  // yanks the viewport backwards and cancels the browser's smooth scrolling.
  useEffect(() => {
    if (scrollTop !== effectiveScrollTop) {
      setScrollTop(effectiveScrollTop);
    }
  }, [effectiveScrollTop, scrollTop]);

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number, align = 'auto') => {
      const container = containerRef.current;
      if (!container || index < 0 || index >= items.length) return;

      // Rows live below the (sticky) header, so the visible band is shorter.
      const bandHeight = Math.max(0, container.clientHeight - headerHeight);
      const itemTop = index * itemHeight;
      const itemBottom = itemTop + itemHeight;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + bandHeight;

      if (align === 'center') {
        container.scrollTop = Math.max(
          0,
          itemTop - (bandHeight - itemHeight) / 2,
        );
      } else if (itemTop < viewTop) {
        container.scrollTop = itemTop;
      } else if (itemBottom > viewBottom) {
        container.scrollTop = itemBottom - bandHeight;
      }
      setScrollTop(container.scrollTop);
      onScroll?.(container.scrollTop);
    },
  }), [headerHeight, itemHeight, items.length, onScroll]);

  // Wheel bursts fire many scroll events per frame; coalesce them so React
  // renders at most once per animation frame.
  const frameRef = useRef<number | null>(null);
  const pendingTopRef = useRef(0);
  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop;
    onScroll?.(top);
    pendingTopRef.current = top;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const next = pendingTopRef.current;
      // The rendered window only changes when a row boundary is crossed, so
      // scrolling inside one row costs no React render at all.
      setScrollTop((previous) =>
        itemHeight > 0 && Math.floor(previous / itemHeight) === Math.floor(next / itemHeight)
          ? previous
          : next,
      );
    });
  }, [itemHeight, onScroll]);

  return (
    <div
      ref={containerRef}
      className={cn('h-full overflow-y-auto overflow-x-hidden', className)}
      onScroll={handleScroll}
    >
      {header}
      <div
        className={cn('relative w-full', contentClassName)}
        style={{
          ...contentStyle,
          height: totalHeight || undefined,
          minHeight: items.length === 0 ? 0 : totalHeight,
        }}
      >
        {items.slice(startIndex, endIndex).map((item, offset) => {
          const index = startIndex + offset;
          return (
            <div
              key={getItemKey(item, index)}
              className="absolute left-0 right-0"
              style={{
                top: index * itemHeight,
                height: itemHeight,
              }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const FixedSizeVirtualList = forwardRef(FixedSizeVirtualListInner) as <T>(
  props: FixedSizeVirtualListProps<T> & { ref?: React.ForwardedRef<FixedSizeVirtualListHandle> },
) => React.ReactElement | null;
