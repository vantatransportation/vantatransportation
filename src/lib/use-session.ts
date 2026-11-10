import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** Reads a sessionStorage string after hydration. undefined = not read yet, null = absent. */
export function useSessionString(key: string): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => undefined,
  );
}
