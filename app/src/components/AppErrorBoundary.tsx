import { Component, type ErrorInfo, type ReactNode } from 'react';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('The application encountered an unrecoverable rendering error.', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-error-page" role="alert">
          <section className="app-error-panel" aria-labelledby="app-error-title">
            <h1 id="app-error-title">This page could not load</h1>
            <p>Reload to try again. Any unfinished changes may need to be submitted again.</p>
            <div className="app-error-actions">
              <button type="button" className="button button-primary" onClick={() => window.location.reload()}>Reload page</button>
              <a className="button button-quiet" href="/">Return to home</a>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
