import type { PersistStorage } from "zustand/middleware";
import { uiMeasure } from "./ui-performance-client.ts";

export function observeBoardStorage<T>(storage: PersistStorage<T> | undefined): PersistStorage<T> | undefined {
  if (!storage) return storage;
  return {
    getItem: (key) => uiMeasure("board.storage-read", () => storage.getItem(key)),
    setItem: (key, value) => uiMeasure("board.storage-write", () => storage.setItem(key, value)),
    removeItem: (key) => uiMeasure("board.storage-remove", () => storage.removeItem(key)),
  };
}
