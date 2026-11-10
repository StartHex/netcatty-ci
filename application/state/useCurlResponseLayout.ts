import { useCallback, useState } from 'react';

import { STORAGE_KEY_CURL_RESPONSE_LAYOUT } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export type CurlResponseLayout = 'bottom' | 'right';

export function normalizeCurlResponseLayout(value: unknown): CurlResponseLayout {
  return value === 'right' ? 'right' : 'bottom';
}

/** Device-local preference: response pane below the request or beside it. */
export function useCurlResponseLayout(): readonly [CurlResponseLayout, (next: CurlResponseLayout) => void] {
  const [layout, setLayout] = useState<CurlResponseLayout>(() =>
    normalizeCurlResponseLayout(localStorageAdapter.readString(STORAGE_KEY_CURL_RESPONSE_LAYOUT)),
  );
  const update = useCallback((next: CurlResponseLayout) => {
    const normalized = normalizeCurlResponseLayout(next);
    setLayout(normalized);
    localStorageAdapter.writeString(STORAGE_KEY_CURL_RESPONSE_LAYOUT, normalized);
  }, []);
  return [layout, update] as const;
}
