import React from 'react';

interface Props {
  children: React.ReactNode;
  /**
   * Fallback UI shown after a render error. Either a static node, or a render
   * function receiving the caught error and a `reset` callback that clears the
   * error state and re-mounts `children`.
   */
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
  /**
   * When any value in this array changes (shallow compare), the boundary clears
   * its error and retries. Use it to auto-recover when the underlying data the
   * subtree depends on changes — e.g. a streaming message's content.
   */
  resetKeys?: unknown[];
  /** Optional hook for logging/telemetry. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** Label included in the default fallback + console output for context. */
  label?: string;
}

interface State {
  error: Error | null;
}

function shallowDiff(a: unknown[] = [], b: unknown[] = []): boolean {
  if (a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
}

/**
 * Catches render-time errors in its subtree and shows a recoverable fallback
 * instead of letting the exception unmount the whole React tree (which would
 * leave the side panel blank and unrecoverable). Scope boundaries narrowly —
 * one per message, plus one at the app root — so a single failure degrades
 * only the smallest possible region.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Auto-recover when the inputs the subtree depends on change.
    if (this.state.error && shallowDiff(prev.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep this defensive: a crash inside error reporting must not re-throw
    // out of the boundary and defeat the whole point of having one.
    try {
      const where = this.props.label ? ` [${this.props.label}]` : '';
      console.error(`[ErrorBoundary]${where}`, error, info.componentStack);
      this.props.onError?.(error, info);
    } catch {
      /* swallow — reporting failures must not break the fallback */
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback, label } = this.props;
    if (typeof fallback === 'function') return fallback(error, this.reset);
    if (fallback !== undefined) return fallback;

    // Default fallback: self-contained inline styles so it renders legibly
    // even if the stylesheet failed to load.
    return (
      <div
        role="alert"
        style={{
          margin: '8px 12px',
          padding: '10px 12px',
          borderRadius: 8,
          background: '#ef444418',
          border: '1px solid #ef444455',
          color: '#e0e0e0',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 600, color: '#f87171', marginBottom: 4 }}>
          {label ? `${label} failed to render` : 'Something went wrong rendering this view'}
        </div>
        <div style={{ color: '#9ca3af', wordBreak: 'break-word' }}>{error.message}</div>
        <button
          type="button"
          onClick={this.reset}
          style={{
            marginTop: 8,
            padding: '4px 10px',
            borderRadius: 6,
            background: '#6366f1',
            border: 'none',
            color: '#fff',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }
}
