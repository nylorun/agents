import { HostSuspension } from "../host-suspension.js";
import type { BoundMiddleware } from "@nylorun/core/define";
import type { StepResponse } from "@nylorun/core/define";
import type { ObserveEmit } from "../observe.js";
import { HarnessError, isHarnessError } from "@nylorun/core/define";
import { isBrandedResponse, StepContext } from "./step-context.js";

export async function runMiddleware(
  middleware: readonly BoundMiddleware[],
  context: StepContext,
  terminal: () => Promise<StepResponse>,
  observe: ObserveEmit,
): Promise<StepResponse> {
  const dispatch = async (index: number): Promise<StepResponse> => {
    if (context.currentTripwire) return context.tripwire(context.currentTripwire);
    if (index === middleware.length) return terminal();

    const item = middleware[index]!;
    const lease = context.requestFacade(item.id, index);
    let returned = false;
    let nextCalledTwice = false;
    let nextPromise: Promise<StepResponse> | undefined;
    observe({
      type: "middleware.entered",
      turnId: context.input.turnId,
      stepId: context.input.stepId,
      middlewareId: item.id,
    });
    try {
      let handlerError: unknown;
      let result: unknown;
      try {
        result = await item.handle(lease.value, () => {
          if (returned)
            throw new HarnessError(
              "middleware.next-after-return",
              `Middleware '${item.id}' called next() after returning`,
              { details: { middlewareId: item.id } },
            );
          if (nextPromise) {
            nextCalledTwice = true;
            throw new HarnessError(
              "middleware.next-called-twice",
              `Middleware '${item.id}' called next() more than once`,
              { details: { middlewareId: item.id } },
            );
          }
          lease.revokeMutators();
          nextPromise = dispatch(index + 1);
          return nextPromise;
        });
      } catch (error) {
        handlerError = error;
      } finally {
        returned = true;
        lease.revokeMutators();
      }

      let inner: StepResponse | undefined;
      if (nextPromise) {
        try {
          inner = await nextPromise;
        } catch (error) {
          handlerError ??= error;
        }
      }

      if (handlerError instanceof HostSuspension) throw handlerError;
      if (handlerError) {
        if (
          nextCalledTwice ||
          (isHarnessError(handlerError) && handlerError.code === "middleware.next-called-twice")
        ) {
          return context.tripwire({
            code: "middleware.next-called-twice",
            message: message(handlerError),
            scope: "execution",
          });
        }
        return context.tripwire({
          code: isHarnessError(handlerError) ? handlerError.code : "middleware.failed",
          message: message(handlerError),
        });
      }

      if (inner) {
        if (result !== inner) {
          return context.tripwire({
            code: "middleware.invalid-response",
            message: `Middleware '${item.id}' must return the StepResponse from next()`,
            // Calling next() completed the step successfully; forgetting to
            // return that response is isolated to this step. A non-response
            // replacement remains a execution-level middleware-contract breach.
            scope: result === undefined ? "step" : "execution",
          });
        }
        return inner;
      }

      if (!isBrandedResponse(result)) {
        return context.tripwire({
          code: "middleware.invalid-response",
          message: `Middleware '${item.id}' must return a branded StepResponse`,
          scope: "execution",
        });
      }
      return result;
    } finally {
      observe({
        type: "middleware.completed",
        turnId: context.input.turnId,
        stepId: context.input.stepId,
        middlewareId: item.id,
      });
    }
  };

  try {
    return await dispatch(0);
  } finally {
    context.seal();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
