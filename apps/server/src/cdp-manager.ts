/**
 * Manages the Chrome DevTools Protocol connection configuration.
 * Provides MCP server config for the Agent SDK's Playwright integration.
 */

export class CdpManager {
  private port: number;

  constructor(port?: number) {
    this.port = port ?? (Number(process.env.CCB_CDP_PORT) || 9222);
  }

  setPort(port: number): void {
    this.port = port;
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      return res.ok;
    } catch {
      return false;
    }
  }

  getMcpConfig(): Record<string, { command: string; args: string[] }> {
    return {
      playwright: {
        command: 'npx',
        args: [
          '@playwright/mcp@latest',
          '--cdp-endpoint',
          `http://127.0.0.1:${this.port}`,
        ],
      },
    };
  }
}
