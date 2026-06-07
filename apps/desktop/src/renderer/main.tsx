import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
// Side-effect: install window.ccb polyfill if we're in a plain browser (no Electron preload).
import './lib/web-transport';
import { App } from './App';
import { AuthGate } from './components/AuthGate';
import { OnboardingGate } from './components/OnboardingGate';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <OnboardingGate>
        <App />
      </OnboardingGate>
    </AuthGate>
  </React.StrictMode>,
);
