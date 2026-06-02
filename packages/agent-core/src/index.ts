/**
 * @claude-code-browser/agent-core
 *
 * Transport-agnostic orchestration shared by the native-messaging host and the
 * Electron desktop app. The AgentManager talks to the Claude Agent SDK and
 * surfaces results through two injected callbacks (`send` and
 * `onBrowserRequest`) so each host can wire its own transport.
 */
export { AgentManager } from './agent-manager.js';
export type { SendMessageParams } from './agent-manager.js';
export { SessionStore } from './session-store.js';
export { log } from './log.js';
