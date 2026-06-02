/**
 * Transport-agnostic logger for the orchestration core.
 * Writes to stderr so it never collides with a stdout-based protocol.
 */
export function log(...args: unknown[]): void {
  process.stderr.write('[ccb-agent-core] ' + args.map(String).join(' ') + '\n');
}
