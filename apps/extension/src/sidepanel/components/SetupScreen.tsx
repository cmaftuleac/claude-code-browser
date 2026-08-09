import React, { useState, useCallback } from 'react';
import { useConnectionStore, type ManualUpdateInfo } from '../stores/connection-store';

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);
  return (
    <div className="setup-screen__cmd-row">
      <pre className="setup-screen__code">{command}</pre>
      <button className="setup-screen__copy-btn" onClick={copy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

function FineguideFooter() {
  return (
    <div className="setup-screen__footer">
      <div className="setup-screen__footer-label">Developed by</div>
      <a
        className="setup-screen__footer-brand"
        href="https://fineguide.ai"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Fineguide.AI"
      >
        <img className="setup-screen__footer-logo" src="/fineguide-logo.svg" alt="Fineguide.AI" />
      </a>
    </div>
  );
}

/** Shown while the host is silently installing a compatible version of itself. */
function UpdatingScreen() {
  return (
    <div className="setup-screen">
      <div className="setup-screen__content">
        <div className="setup-screen__header">
          <span className="setup-screen__status-dot" />
          <h2 className="setup-screen__title">Updating the bridge…</h2>
        </div>
        <p className="setup-screen__subtitle">
          A newer version of the local bridge is required, so it's updating itself to
          match this extension. This takes a few seconds — Chrome will reconnect
          automatically when it's done. No action needed.
        </p>
      </div>
    </div>
  );
}

/** Shown when auto-update isn't possible (host too old) or it failed (npm /
 *  permission error). Names the exact version the user must install. */
function ManualUpdateScreen({ info }: { info: ManualUpdateInfo }) {
  const updateCmd = `npm i -g claude-code-browser@${info.target}`;
  return (
    <div className="setup-screen">
      <div className="setup-screen__content">
        <div className="setup-screen__header">
          <span className="setup-screen__status-dot" />
          <h2 className="setup-screen__title">Update Required</h2>
        </div>

        <p className="setup-screen__subtitle">
          This extension needs the local bridge at version{' '}
          <strong>{info.target}</strong>
          {info.current ? <> — yours is <strong>{info.current}</strong></> : null}. The
          bridge couldn't update itself automatically, so please update it by hand.
        </p>
        {info.reason ? (
          <p className="setup-screen__subtitle">
            <strong>Why automatic update failed:</strong> {info.reason}
          </p>
        ) : null}

        <div className="setup-screen__steps">
          <div className="setup-screen__step">
            <div className="setup-screen__step-num">1</div>
            <div className="setup-screen__step-body">
              <strong>Run this in your terminal</strong>
              <div className="setup-screen__step-desc">
                Installs the matching bridge version and re-wires it for Chrome.
              </div>
              <CopyableCommand command={updateCmd} />
            </div>
          </div>

          <div className="setup-screen__step">
            <div className="setup-screen__step-num">2</div>
            <div className="setup-screen__step-body">
              <strong>Restart Chrome</strong>
              <div className="setup-screen__step-desc">
                Quit Chrome completely (Cmd+Q on macOS) and reopen it so it picks up
                the updated bridge.
              </div>
            </div>
          </div>
        </div>

        <p className="setup-screen__hint">
          This screen will disappear automatically once the updated bridge connects.
        </p>

        <FineguideFooter />
      </div>
    </div>
  );
}

/** First-run setup: install the bridge for the first time. */
function GenericSetupScreen() {
  // No ID needed — installer auto-detects all loaded Claude Code Browser
  // extensions and registers them all in allowed_origins.
  const installCmd = 'npx claude-code-browser install';

  return (
    <div className="setup-screen">
      <div className="setup-screen__content">
        <div className="setup-screen__header">
          <span className="setup-screen__status-dot" />
          <h2 className="setup-screen__title">Setup Required</h2>
        </div>

        <p className="setup-screen__subtitle">
          This extension is a <strong>companion</strong> to Claude Code on your
          computer. It uses your existing Claude Code account, credentials and
          tokens — there is nothing new to sign in to here.
        </p>
        <p className="setup-screen__subtitle">
          It is <strong>not</strong> a standalone Claude Code by itself. To let
          Chrome talk to Claude Code, a small Node.js helper runs locally and
          acts as a <strong>bridge</strong> between this browser and your
          Claude Code instance.
        </p>
        <p className="setup-screen__subtitle">
          The command below installs that bridge. If you don't already have
          Claude Code installed, it will install that for you too.
        </p>

        <div className="setup-screen__steps">
          <div className="setup-screen__step">
            <div className="setup-screen__step-num">1</div>
            <div className="setup-screen__step-body">
              <strong>Run this in your terminal</strong>
              <div className="setup-screen__step-desc">
                Installs the local bridge, and Claude Code itself if it's missing.
              </div>
              <CopyableCommand command={installCmd} />
            </div>
          </div>

          <div className="setup-screen__step">
            <div className="setup-screen__step-num">2</div>
            <div className="setup-screen__step-body">
              <strong>Sign in to Claude Code (first time only)</strong>
              <div className="setup-screen__step-desc">
                If this is a fresh Claude Code install, run <code>claude</code>{' '}
                once in your terminal and follow the sign-in flow. Skip this if
                you already use Claude Code.
              </div>
            </div>
          </div>

          <div className="setup-screen__step">
            <div className="setup-screen__step-num">3</div>
            <div className="setup-screen__step-body">
              <strong>Restart Chrome</strong>
              <div className="setup-screen__step-desc">
                Quit Chrome completely (Cmd+Q on macOS) and reopen it so it
                picks up the new bridge.
              </div>
            </div>
          </div>
        </div>

        <p className="setup-screen__hint">
          This screen will disappear automatically once the bridge connects.
        </p>

        <FineguideFooter />
      </div>
    </div>
  );
}

export function SetupScreen() {
  const needsManualUpdate = useConnectionStore((s) => s.needsManualUpdate);
  const hostUpdating = useConnectionStore((s) => s.hostUpdating);

  if (needsManualUpdate) return <ManualUpdateScreen info={needsManualUpdate} />;
  if (hostUpdating) return <UpdatingScreen />;
  return <GenericSetupScreen />;
}
