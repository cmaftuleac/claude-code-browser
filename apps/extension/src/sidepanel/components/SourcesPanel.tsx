import React, { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY_PREFIX = 'ccb-sources-';
const PANEL_KEY = 'ccb-sources-panel-collapsed';

function getDomainKey(): Promise<string> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      try {
        const url = new URL(tabs[0]?.url ?? '');
        resolve(url.hostname || 'unknown');
      } catch {
        resolve('unknown');
      }
    });
  });
}

export function useSourcePaths(): string[] {
  const [sources, setSources] = useState<string[]>([]);

  useEffect(() => {
    getDomainKey().then((domain) => {
      chrome.storage.local.get(STORAGE_KEY_PREFIX + domain, (result) => {
        setSources(result[STORAGE_KEY_PREFIX + domain] ?? []);
      });
    });

    // Re-read when tab changes
    const onActivated = () => {
      getDomainKey().then((domain) => {
        chrome.storage.local.get(STORAGE_KEY_PREFIX + domain, (result) => {
          setSources(result[STORAGE_KEY_PREFIX + domain] ?? []);
        });
      });
    };
    chrome.tabs.onActivated.addListener(onActivated);
    return () => chrome.tabs.onActivated.removeListener(onActivated);
  }, []);

  return sources;
}

export function SourcesPanel() {
  const [collapsed, setCollapsed] = useState(true);
  const [sources, setSources] = useState<string[]>([]);
  const [domain, setDomain] = useState('');
  const [inputValue, setInputValue] = useState('');

  // Load panel collapsed state
  useEffect(() => {
    chrome.storage.local.get(PANEL_KEY, (result) => {
      setCollapsed(result[PANEL_KEY] ?? true);
    });
  }, []);

  const loadSources = useCallback(async () => {
    const d = await getDomainKey();
    setDomain(d);
    chrome.storage.local.get(STORAGE_KEY_PREFIX + d, (result) => {
      setSources(result[STORAGE_KEY_PREFIX + d] ?? []);
    });
  }, []);

  const saveSources = useCallback((newSources: string[]) => {
    setSources(newSources);
    if (domain) {
      chrome.storage.local.set({ [STORAGE_KEY_PREFIX + domain]: newSources });
    }
  }, [domain]);

  const togglePanel = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      chrome.storage.local.set({ [PANEL_KEY]: next });
      return next;
    });
  }, []);

  const addSource = useCallback(() => {
    const path = inputValue.trim();
    if (!path) {
      // Focus the input if empty
      document.querySelector<HTMLInputElement>('.sources-panel__input')?.focus();
      return;
    }
    if (sources.includes(path)) return;
    saveSources([...sources, path]);
    setInputValue('');
  }, [inputValue, sources, saveSources]);

  const removeSource = useCallback((index: number) => {
    saveSources(sources.filter((_, i) => i !== index));
  }, [sources, saveSources]);

  // Poll sources every second
  useEffect(() => {
    loadSources();
    const onActivated = () => loadSources();
    chrome.tabs.onActivated.addListener(onActivated);
    const pollTimer = setInterval(loadSources, 1000);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      clearInterval(pollTimer);
    };
  }, [loadSources]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); addSource(); }
  };

  return (
    <div className="sources-panel">
      <button className="sources-panel__toggle" onClick={togglePanel}>
        <span className="sources-panel__arrow">{collapsed ? '\u25B6' : '\u25BC'}</span>
        <span>Sources ({sources.length})</span>
      </button>

      {!collapsed && (
        <div className="sources-panel__content">
          {sources.length > 0 && (
            <div className="sources-panel__list">
              {sources.map((path, i) => (
                <div key={i} className="sources-panel__item">
                  <span className="sources-panel__path" title={path}>
                    {path.split('/').slice(-2).join('/')}
                  </span>
                  <button
                    className="sources-panel__remove"
                    onClick={() => removeSource(i)}
                    title="Remove"
                  >
                    {'\u2715'}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="sources-panel__add">
            <input
              className="sources-panel__input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="/path/to/project"
            />
            <button className="sources-panel__add-btn" onClick={addSource}>
              +
            </button>
          </div>
          {domain && (
            <div className="sources-panel__domain">
              {domain}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
