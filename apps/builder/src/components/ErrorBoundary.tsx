import { Component, type ErrorInfo, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-[15px] font-medium">The {this.props.label} hit an error and could not be shown.</p>
        <p className="max-w-md text-[13px] text-zinc-500">{this.state.error.message}</p>
        <button
          type="button"
          className="h-8 rounded-[4px] border border-zinc-200 px-3 text-[14px] hover:bg-zinc-100"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
