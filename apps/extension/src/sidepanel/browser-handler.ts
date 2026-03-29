/**
 * Handles browser:request messages from the native host.
 * Executes browser operations via chrome.debugger / chrome.tabs / chrome.scripting APIs.
 */

type BrowserRequest = {
  requestId: string;
  action: 'navigate' | 'snapshot' | 'screenshot' | 'click' | 'evaluate';
  params: Record<string, unknown>;
};

type BrowserResponse = {
  type: 'browser:response';
  requestId: string;
  result?: unknown;
  error?: string;
};

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return tab;
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.getTargets((targets) => {
      const attached = targets.some((t) => t.tabId === tabId && t.attached);
      if (attached) {
        resolve();
        return;
      }
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  });
}

function sendDebuggerCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function handleNavigate(params: Record<string, unknown>): Promise<unknown> {
  const url = params.url as string;
  if (!url) throw new Error('url is required');

  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id!, { url });

  // Wait for page to load
  await new Promise<void>((resolve) => {
    const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 30s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });

  const updated = await chrome.tabs.get(tab.id!);
  return { url: updated.url, title: updated.title };
}

async function handleSnapshot(): Promise<unknown> {
  const tab = await getActiveTab();

  // Get accessibility tree via debugger
  try {
    await ensureDebuggerAttached(tab.id!);
    const result = await sendDebuggerCommand(tab.id!, 'Accessibility.getFullAXTree') as {
      nodes?: Array<{ role?: { value: string }; name?: { value: string }; nodeId?: string; childIds?: string[] }>;
    };

    if (result?.nodes) {
      // Build a simplified text representation
      const lines: string[] = [];
      const nodeMap = new Map<string, typeof result.nodes[0]>();
      for (const node of result.nodes) {
        if (node.nodeId) nodeMap.set(node.nodeId, node);
      }

      function walk(nodeId: string, depth: number) {
        const node = nodeMap.get(nodeId);
        if (!node) return;
        const role = node.role?.value ?? '';
        const name = node.name?.value ?? '';
        if (role && role !== 'none' && role !== 'generic') {
          const indent = '  '.repeat(depth);
          const label = name ? `${role} "${name}"` : role;
          lines.push(`${indent}${label}`);
        }
        for (const childId of node.childIds ?? []) {
          walk(childId, depth + (role && role !== 'none' && role !== 'generic' ? 1 : 0));
        }
      }

      if (result.nodes.length > 0 && result.nodes[0].nodeId) {
        walk(result.nodes[0].nodeId, 0);
      }

      return {
        url: tab.url,
        title: tab.title,
        snapshot: lines.join('\n'),
      };
    }
  } catch {
    // Fall back to DOM-based snapshot
  }

  // Fallback: get DOM structure via scripting
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: () => {
      function walk(el: Element, depth: number, maxDepth: number): string {
        if (depth > maxDepth) return '';
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const role = el.getAttribute('role') ?? '';
        const ariaLabel = el.getAttribute('aria-label') ?? '';
        const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
          ? ` "${(el.childNodes[0].textContent ?? '').trim().slice(0, 50)}"` : '';
        const indent = '  '.repeat(depth);
        const roleStr = role ? ` role="${role}"` : '';
        const labelStr = ariaLabel ? ` aria-label="${ariaLabel}"` : '';
        let result = `${indent}<${tag}${id}${roleStr}${labelStr}>${text}\n`;
        for (const child of el.children) {
          if (['script', 'style', 'noscript'].includes(child.tagName.toLowerCase())) continue;
          result += walk(child, depth + 1, maxDepth);
        }
        return result;
      }
      return walk(document.body, 0, 6);
    },
  });

  return {
    url: tab.url,
    title: tab.title,
    snapshot: injection?.result ?? 'Could not get snapshot',
  };
}

async function handleScreenshot(): Promise<unknown> {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
  return { dataUrl };
}

async function handleClick(params: Record<string, unknown>): Promise<unknown> {
  const selector = params.selector as string;
  const xpath = params.xpath as string;

  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: (sel: string, xp: string) => {
      let el: Element | null = null;
      if (sel) {
        try { el = document.querySelector(sel); } catch { /* */ }
      }
      if (!el && xp) {
        try {
          const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          el = r.singleNodeValue as Element | null;
        } catch { /* */ }
      }
      if (!el) return { error: 'Element not found' };
      (el as HTMLElement).click();
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent ?? '').trim().slice(0, 80);
      return { clicked: true, element: `<${tag}>`, text };
    },
    args: [selector ?? '', xpath ?? ''],
  });

  return result?.result ?? { error: 'Script execution failed' };
}

async function handleEvaluate(params: Record<string, unknown>): Promise<unknown> {
  const expression = params.expression as string;
  if (!expression) throw new Error('expression is required');

  const tab = await getActiveTab();
  await ensureDebuggerAttached(tab.id!);
  const result = await sendDebuggerCommand(tab.id!, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result;
}

export async function handleBrowserRequest(request: BrowserRequest): Promise<BrowserResponse> {
  try {
    let result: unknown;
    switch (request.action) {
      case 'navigate':
        result = await handleNavigate(request.params);
        break;
      case 'snapshot':
        result = await handleSnapshot();
        break;
      case 'screenshot':
        result = await handleScreenshot();
        break;
      case 'click':
        result = await handleClick(request.params);
        break;
      case 'evaluate':
        result = await handleEvaluate(request.params);
        break;
      default:
        throw new Error(`Unknown action: ${request.action}`);
    }
    return { type: 'browser:response', requestId: request.requestId, result };
  } catch (err) {
    return {
      type: 'browser:response',
      requestId: request.requestId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
