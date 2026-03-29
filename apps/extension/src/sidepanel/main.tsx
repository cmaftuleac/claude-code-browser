import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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
    <App />
  </React.StrictMode>,
);
