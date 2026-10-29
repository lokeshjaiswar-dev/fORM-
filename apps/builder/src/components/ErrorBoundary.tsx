import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@dmacq/ui';

export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <Alert variant="destructive" icon className="max-w-md text-left">
          <AlertTitle>The {this.props.label} hit an error and could not be shown.</AlertTitle>
          <AlertDescription>{this.state.error.message}</AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
