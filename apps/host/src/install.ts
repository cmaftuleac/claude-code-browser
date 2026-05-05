#!/usr/bin/env node

/**
 * Claude Code Browser — All-in-one installer.
 *
 * Usage:
 *   npx claude-code-browser install [extension-id]
 *   npx claude-code-browser uninstall
 */

import { platform, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync,
  copyFileSync, readFileSync, readdirSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.claude_code_browser';
const STORE_EXTENSION_ID = 'mnibceaaapcppokpnnljohdlmojjgbkf';
const STORE_URL = 'https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(msg: string) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function info(msg: string) { console.log(`  \x1b[36mℹ\x1b[0m ${msg}`); }
function warn(msg: string) { console.log(`  \x1b[33m!\x1b[0m ${msg}`); }
function fail(msg: string) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    // Windows fallback
    try {
      execSync(`where ${cmd}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

function getHostJsPath(): string {
  return resolve(__dirname, 'host.js');
}

function getManifestDir(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
    case 'linux':
      return join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

function getChromeBaseDirs(): string[] {
  switch (platform()) {
    case 'darwin': return [join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')];
    case 'linux': return [join(homedir(), '.config', 'google-chrome')];
    case 'win32': return [join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')];
    default: return [];
  }
}

function chromeProfiles(): string[] {
  // Default plus Profile 1..10. We don't list the dir because it contains many
  // non-profile entries; this fixed list catches all common cases.
  return ['Default', ...Array.from({ length: 10 }, (_, i) => `Profile ${i + 1}`)];
}

/** Check if STORE_EXTENSION_ID is referenced in any of Chrome's profile preference files.
 *  Catches Web Store installs that haven't been unpacked into Extensions/<id>/ yet,
 *  and installs tracked only via Chrome's signed-install list. */
function isExtensionInChromePrefs(): boolean {
  if (!STORE_EXTENSION_ID) return false;
  for (const baseDir of getChromeBaseDirs()) {
    for (const profile of chromeProfiles()) {
      for (const fname of ['Preferences', 'Secure Preferences']) {
        const p = join(baseDir, profile, fname);
        if (!existsSync(p)) continue;
        try {
          const data = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
          const exts = (data.extensions as Record<string, unknown> | undefined) ?? {};
          const settings = (exts.settings as Record<string, unknown> | undefined) ?? {};
          if (STORE_EXTENSION_ID in settings) return true;
          const sig = exts.install_signature as { ids?: string[] } | undefined;
          if (sig?.ids && sig.ids.includes(STORE_EXTENSION_ID)) return true;
        } catch { /* skip unreadable / non-JSON */ }
      }
    }
  }
  return false;
}

/** Scan unpacked extension directories for any "Claude Code Browser" manifest.
 *  Returns the extension's directory ID if found. */
function detectUnpackedExtensionId(): string | null {
  for (const baseDir of getChromeBaseDirs()) {
    for (const profile of chromeProfiles()) {
      const extDir = join(baseDir, profile, 'Extensions');
      if (!existsSync(extDir)) continue;
      try {
        for (const id of readdirSync(extDir)) {
          const versions = join(extDir, id);
          if (!existsSync(versions)) continue;
          try {
            for (const ver of readdirSync(versions)) {
              const manifest = join(versions, ver, 'manifest.json');
              if (existsSync(manifest)) {
                const content = readFileSync(manifest, 'utf-8');
                if (content.includes('Claude Code Browser')) return id;
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }
  return null;
}

/** Combined detection: prefer an unpacked extension ID (so dev installs work),
 *  fall back to confirming the Web Store extension is registered in Chrome's
 *  preference files (covers extensions that are signed/installed but not yet
 *  unpacked into Extensions/<id>/ — happens for some Web Store installs). */
function detectInstalledExtensionId(): string | null {
  const unpacked = detectUnpackedExtensionId();
  if (unpacked) return unpacked;
  if (STORE_EXTENSION_ID && isExtensionInChromePrefs()) return STORE_EXTENSION_ID;
  return null;
}

// ── Install Steps ───────────────────────────────────────────────────────────

function checkNode(): boolean {
  const version = process.version;
  const major = parseInt(version.slice(1));
  if (major >= 18) {
    ok(`Node.js ${version}`);
    return true;
  }
  fail(`Node.js ${version} — version 18+ required`);
  return false;
}

function checkClaudeCode(): boolean {
  if (commandExists('claude')) {
    try {
      const version = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
      ok(`Claude Code CLI ${version}`);
      return true;
    } catch {
      ok('Claude Code CLI installed');
      return true;
    }
  }
  warn('Claude Code CLI not found — installing...');
  try {
    execSync('npm install -g @anthropic-ai/claude-code', { stdio: 'inherit', timeout: 120000 });
    ok('Claude Code CLI installed');
    return true;
  } catch {
    fail('Failed to install Claude Code CLI. Run manually: npm install -g @anthropic-ai/claude-code');
    return false;
  }
}

function installNativeHost(extensionId: string): boolean {
  const hostJs = getHostJsPath();
  const dir = dirname(hostJs);
  const nodePath = process.execPath;

  // On macOS/Linux: set absolute node path as shebang in host.js and point manifest directly to it.
  // Shell wrappers get blocked by macOS Gatekeeper.
  // On Windows: use a .bat wrapper.
  let execPath: string;

  if (platform() === 'win32') {
    execPath = join(dir, `${HOST_NAME}.bat`);
    writeFileSync(execPath, `@echo off\r\ncd /d "%~dp0"\r\n"${nodePath}" host.js %*\r\n`);
  } else {
    // Rewrite shebang in host.js to use absolute node path
    const hostContent = readFileSync(hostJs, 'utf-8');
    const updatedContent = hostContent.replace(/^#!.*\n/, `#!${nodePath}\n`);
    writeFileSync(hostJs, updatedContent);
    chmodSync(hostJs, '755');
    execPath = hostJs;
  }

  // Write manifest
  const manifestDir = getManifestDir();
  const manifestPath = join(manifestDir, `${HOST_NAME}.json`);

  const manifest = {
    name: HOST_NAME,
    description: 'Claude Code Browser - Native Messaging Host',
    path: execPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Windows registry
  if (platform() === 'win32') {
    try {
      execSync(
        `reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${manifestPath}" /f`,
        { stdio: 'ignore' },
      );
    } catch { /* non-fatal */ }
  }

  ok(`Native messaging host registered for ${extensionId}`);
  return true;
}

function installSkill(): boolean {
  const skillDir = join(homedir(), '.claude', 'skills', 'browse');
  const skillFile = join(skillDir, 'SKILL.md');
  const bundledSkill = resolve(__dirname, '..', '..', '..', 'skills', 'browse', 'SKILL.md');

  if (!existsSync(bundledSkill)) {
    // Try alternate path (when installed via npm)
    const altPath = resolve(__dirname, '..', 'skills', 'browse', 'SKILL.md');
    if (existsSync(altPath)) {
      mkdirSync(skillDir, { recursive: true });
      copyFileSync(altPath, skillFile);
      ok('/browse skill installed');
      return true;
    }
    warn('/browse skill not found in package — skipping');
    return false;
  }

  mkdirSync(skillDir, { recursive: true });
  copyFileSync(bundledSkill, skillFile);
  ok('/browse skill installed');
  return true;
}

function printExtensionInstallInstructions(): void {
  if (!STORE_EXTENSION_ID) {
    info('Chrome extension: Load manually from apps/extension/dist/ (not yet on Chrome Web Store)');
    return;
  }
  info('Chrome extension is not installed.');
  info(`Install it from: ${STORE_URL}`);
}

// ── Commands ────────────────────────────────────────────────────────────────

function install(explicitId?: string): void {
  console.log('');
  console.log('  Claude Code Browser — Setup');
  console.log('  ═══════════════════════════');
  console.log('');

  // Step 1: Check Node
  if (!checkNode()) {
    console.log('');
    fail('Setup failed. Install Node.js 18+ and try again.');
    process.exit(1);
  }

  // Step 2: Check/install Claude Code
  checkClaudeCode();

  // Step 3: Install native host
  let extensionId = explicitId || '';

  if (!extensionId) {
    // Try to detect installed extension
    const detected = detectInstalledExtensionId();
    if (detected) {
      extensionId = detected;
      info(`Detected extension ID: ${extensionId}`);
    } else if (STORE_EXTENSION_ID) {
      extensionId = STORE_EXTENSION_ID;
    } else {
      fail('Could not detect extension ID.');
      console.log('');
      console.log('  Please provide your extension ID:');
      console.log('    1. Open chrome://extensions');
      console.log('    2. Enable "Developer mode"');
      console.log('    3. Find "Claude Code Browser" and copy the ID');
      console.log('    4. Run: npx claude-code-browser install <extension-id>');
      console.log('');
      process.exit(1);
    }
  }

  installNativeHost(extensionId);

  // Step 4: Install /browse skill
  installSkill();

  // Step 5: Extension
  const detected = detectInstalledExtensionId();
  if (detected) {
    ok('Chrome extension installed');
  } else {
    printExtensionInstallInstructions();
  }

  console.log('');
  console.log('  \x1b[32m✓ Setup complete!\x1b[0m');
  console.log('');
  console.log('  Open the Claude Code Browser side panel in Chrome to start.');
  console.log('');
}

function uninstall(): void {
  console.log('');

  // Remove native host manifest
  const manifestDir = getManifestDir();
  const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
  if (existsSync(manifestPath)) {
    unlinkSync(manifestPath);
    ok('Native messaging host manifest removed');
  }

  // Remove wrapper
  const hostJs = getHostJsPath();
  const dir = dirname(hostJs);
  const wrapperPath = platform() === 'win32'
    ? join(dir, `${HOST_NAME}.bat`)
    : join(dir, HOST_NAME);
  if (existsSync(wrapperPath)) {
    unlinkSync(wrapperPath);
  }

  // Windows registry
  if (platform() === 'win32') {
    try {
      execSync(`reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /f`, { stdio: 'ignore' });
    } catch { /* */ }
  }

  // Remove skill
  const skillFile = join(homedir(), '.claude', 'skills', 'browse', 'SKILL.md');
  if (existsSync(skillFile)) {
    unlinkSync(skillFile);
    ok('/browse skill removed');
  }

  console.log('');
  ok('Claude Code Browser uninstalled');
  console.log('');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'install':
    install(args[0]);
    break;
  case 'uninstall':
    uninstall();
    break;
  default:
    console.log('');
    console.log('  Claude Code Browser');
    console.log('');
    console.log('  Usage:');
    console.log('    npx claude-code-browser install [extension-id]   Install everything');
    console.log('    npx claude-code-browser uninstall                Remove everything');
    console.log('');
}
