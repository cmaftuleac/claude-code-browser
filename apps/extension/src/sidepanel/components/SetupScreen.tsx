import React, { useState, useCallback } from 'react';

export function SetupScreen() {
  const [extensionId] = useState(() => chrome.runtime.id);
  const [copied, setCopied] = useState(false);

  const installCmd = `npx claude-code-browser install ${extensionId}`;

  const copy = useCallback(() => {
    navigator.clipboard.writeText(installCmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [installCmd]);

  return (
    <div className="setup-screen">
      <div className="setup-screen__content">
        <h2 className="setup-screen__title">Setup Required</h2>
        <p className="setup-screen__subtitle">
          Run this command in your terminal:
        </p>

        <div className="setup-screen__cmd-row">
          <pre className="setup-screen__code">{installCmd}</pre>
          <button className="setup-screen__copy-btn" onClick={copy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        <p className="setup-screen__hint">
          This installs Claude Code CLI, the native host, and /browse skill.
          This screen will disappear automatically once connected.
        </p>
      </div>
    </div>
  );
}
