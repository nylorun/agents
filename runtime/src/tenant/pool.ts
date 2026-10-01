export class TimeoutError extends Error {
  constructor(message = "operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout. On timeout the late result is handed to
 * `onLate` (Risk R6: mark quarantined and close a late handle).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onLate?: (late: Promise<T>) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    return result;
  } catch (error) {
    if (timedOut && onLate) {
      onLate(
        promise.then(
          (value) => value,
          (lateError) => {
            throw lateError;
          },
        ),
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
