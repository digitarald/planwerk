"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Read-and-write a string value backed by `localStorage`, hydration-safe.
 *
 * Uses `useSyncExternalStore` so the server render (and the initial client
 * hydration pass) sees `defaultValue`, then React reconciles to the stored
 * value without triggering a hydration mismatch — replacing the common
 * `useState` + `useEffect(() => setState(localStorage…))` anti-pattern that the
 * `react-hooks/set-state-in-effect` rule flags.
 */
export function usePersistentState(
  key: string,
  defaultValue: string,
): [string, (value: string) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const handler = (event: StorageEvent) => {
        if (event.key === key) onChange();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    [key],
  );

  const getSnapshot = useCallback(() => {
    try {
      return localStorage.getItem(key) ?? defaultValue;
    } catch {
      return defaultValue;
    }
  }, [key, defaultValue]);

  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: string) => {
      try {
        localStorage.setItem(key, next);
        // Notify same-tab subscribers (the `storage` event only fires cross-tab).
        window.dispatchEvent(new StorageEvent("storage", { key }));
      } catch {
        // Ignore quota/availability errors — state simply won't persist.
      }
    },
    [key],
  );

  return [value, setValue];
}
