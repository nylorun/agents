import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/runtime-body.ts";

type Props = {
  /** A change (the route) clears the error and renders the view again. */
  resetKey?: string;
  children: ReactNode;
};

type State = { message?: string; attempt: number };

/**
 * Catches a render error in one view so the dashboard keeps its sidebar and
 * header instead of React unmounting the whole root (a blank page, or a blank
 * frame when embedded). Reload remounts the view in place, so it works the
 * same embedded: no page reload, no new window.
 */
export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { message: errorMessage(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Studio view failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (
      previous.resetKey !== this.props.resetKey &&
      this.state.message !== undefined
    )
      this.setState({ message: undefined });
  }

  render() {
    if (this.state.message === undefined)
      return (
        <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
      );
    return (
      <section
        role="alert"
        className="m-4 flex shrink-0 flex-col items-start gap-3 rounded-lg border p-4"
      >
        <h2 className="font-medium">Something went wrong in this view</h2>
        <p className="font-mono text-sm break-all text-muted-foreground">
          {this.state.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            this.setState(({ attempt }) => ({
              message: undefined,
              attempt: attempt + 1,
            }))
          }
        >
          Reload
        </Button>
      </section>
    );
  }
}
