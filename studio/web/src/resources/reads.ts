import { useCallback, useEffect, useRef, useState } from "react";

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Selection-scoped public API reads: cancel stale work and retry without losing metadata. */
export function useRead<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setData(undefined);
  }, [load]);
  useEffect(() => {
    const abort = new AbortController();
    setPending(true);
    setError("");
    load(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setData(value);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => {
        if (!abort.signal.aborted) setPending(false);
      });
    return () => abort.abort();
  }, [load, revision]);
  return {
    data,
    error,
    pending,
    reload: useCallback(() => setRevision((r) => r + 1), []),
  };
}

/** The cursor and ordering belong to Runtime; Studio only appends deduplicated pages. */
export function usePages<T extends { id: string }>(
  load: (
    signal: AbortSignal,
    cursor?: string,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const [revision, setRevision] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const read = useCallback(
    async (after?: string) => {
      abort.current?.abort();
      const current = new AbortController();
      abort.current = current;
      setPending(true);
      setError("");
      try {
        const page = await load(current.signal, after);
        if (current.signal.aborted) return;
        setItems((previous) =>
          Array.from(
            new Map(
              [...(after === undefined ? [] : previous), ...page.items].map(
                (item) => [item.id, item],
              ),
            ).values(),
          ),
        );
        setCursor(page.nextCursor);
      } catch (cause) {
        if (!current.signal.aborted) setError(messageOf(cause));
      } finally {
        if (!current.signal.aborted) setPending(false);
      }
    },
    [load],
  );
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void read();
    return () => abort.current?.abort();
  }, [read, revision]);
  return {
    items,
    error,
    pending,
    more: cursor !== null,
    loadMore: () => {
      if (!pending && cursor !== null) void read(cursor);
    },
    reload: () => setRevision((r) => r + 1),
  };
}
