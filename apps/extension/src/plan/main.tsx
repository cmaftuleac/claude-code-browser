/**
 * Standalone plan viewer — the "Open in window" target for a plan-approval card.
 *
 * A plan can run to dozens of lines, which is a poor fit for a 360px side panel.
 * The panel hands the text over through chrome.storage.local (a one-shot key named
 * in the URL) rather than the URL itself: plans routinely exceed what is safe to
 * put in a query string, and storage keeps the address bar readable.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../sidepanel/lib/markdown';
import '../sidepanel/styles.css';

function PlanView() {
  const [plan, setPlan] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const key = new URLSearchParams(location.search).get('k');
    if (!key) { setMissing(true); return; }
    chrome.storage.local.get(key, (res) => {
      const text = res[key] as string | undefined;
      if (typeof text === 'string' && text) {
        setPlan(text);
        // One-shot handoff: drop the key now that it is rendered, so plans don't
        // accumulate in storage. Reloading this window afterwards shows the
        // "no longer available" state rather than resurrecting a stale plan.
        chrome.storage.local.remove(key);
      } else {
        setMissing(true);
      }
    });
  }, []);

  return (
    <div className="planview">
      <div className="planview__bar">
        <span className="planview__title">Plan</span>
        {plan && (
          <button
            className="planview__copy"
            onClick={() => void navigator.clipboard.writeText(plan)}
          >Copy markdown</button>
        )}
      </div>
      <div className="planview__body">
        {plan ? <Markdown>{plan}</Markdown>
          : missing ? <p className="planview__empty">This plan is no longer available. Reopen it from the side panel.</p>
            : <p className="planview__empty">Loading…</p>}
      </div>
    </div>
  );
}

const el = document.getElementById('root');
if (el) createRoot(el).render(<React.StrictMode><PlanView /></React.StrictMode>);
