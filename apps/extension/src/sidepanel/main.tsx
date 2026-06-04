import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

// Prevent the side panel from being navigated away
document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('a');
  if (target?.href && !target.href.startsWith('chrome-extension://')) {
    e.preventDefault();
    chrome.tabs.create({ url: target.href });
  }
}, true);

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary
      label="Side panel"
      fallback={(error, reset) => (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 12,
            padding: 24,
            height: '100vh',
            boxSizing: 'border-box',
            background: '#1a1a2e',
            color: '#e0e0e0',
            font: '14px/1.5 system-ui, sans-serif',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600, color: '#f87171' }}>
            The side panel hit an unexpected error
          </div>
          <div style={{ color: '#9ca3af', wordBreak: 'break-word' }}>{error.message}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                background: '#6366f1',
                border: 'none',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                background: '#ffffff10',
                border: '1px solid #ffffff22',
                color: '#e0e0e0',
                cursor: 'pointer',
              }}
            >
              Reload panel
            </button>
          </div>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
