import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/** Keeps one broken page from blanking the whole app; resets when the user navigates elsewhere. */
export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error("page crashed", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto mt-16 max-w-md rounded-2xl border border-ink-700 bg-ink-900 p-8 text-center">
        <AlertTriangle className="mx-auto size-8 text-warn-ink" />
        <h2 className="mt-3 text-lg font-semibold text-ink-100">Something went wrong on this page</h2>
        <p className="mt-1 text-sm text-ink-300">Your library is safe. Reload the page or pick another section from the menu.</p>
        <button onClick={() => window.location.reload()}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500">
          <RotateCw className="size-4" /> Reload
        </button>
      </div>
    );
  }
}
