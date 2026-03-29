import React from 'react';
import { useConnectionStore } from '../stores/connection-store';

export function ConnectionStatus() {
  const status = useConnectionStore((s) => s.status);
  const isConnected = status === 'connected';

  return (
    <div className="connection-status">
      <span
        className={`status-dot ${isConnected ? 'status-dot--connected' : 'status-dot--disconnected'}`}
      />
      <span className="status-label">
        {status === 'connecting' ? 'Connecting...' : isConnected ? 'Connected' : 'Disconnected'}
      </span>
    </div>
  );
}
