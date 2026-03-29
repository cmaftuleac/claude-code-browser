import React, { lazy, Suspense } from 'react';
import { ConnectionStatus } from './components/ConnectionStatus';
import { SessionList } from './components/SessionList';
import { ChatSidebar } from './components/ChatSidebar';
import { SetupScreen } from './components/SetupScreen';
import { useNativePort } from './hooks/useNativePort';
import { useConnectionStore } from './stores/connection-store';

const DomTreePanel = lazy(() => import('./components/DomTreePanel').then(m => ({ default: m.DomTreePanel })));

export function App() {
  const { send } = useNativePort();
  const status = useConnectionStore((s) => s.status);

  if (status !== 'connected') {
    return <SetupScreen />;
  }

  return (
    <div className="app-container">
      <ConnectionStatus />
      <SessionList send={send} />
      <Suspense fallback={null}>
        <DomTreePanel />
      </Suspense>
      <ChatSidebar send={send} />
    </div>
  );
}
