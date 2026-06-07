/**
 * Custom application menu. Builds File / Edit / View / Go / Window / Help
 * with the entries we actually have functionality for. Keyboard accelerators
 * already owned by `before-input-event` (Cmd+W, Cmd+Q) are intentionally
 * shown without `registerAccelerator` so the menu item is discoverable but
 * the existing custom handler stays in charge.
 *
 * Most clicks send `menu:<action>` IPC events to the renderer; the
 * `useAppMenu` hook in the renderer dispatches them to the relevant store.
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { listRecents } from './recents.js';

type GetWin = () => BrowserWindow | null;

const REPO_ISSUES_URL = 'https://github.com/cmaftuleac/claude-code-browser/issues';

function send(getWin: GetWin, channel: string, ...args: unknown[]): void {
  const wc = getWin()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
}

function buildOpenRecentSubmenu(getWin: GetWin): MenuItemConstructorOptions[] {
  const recents = listRecents();
  if (recents.length === 0) {
    return [{ label: 'No recent projects', enabled: false }];
  }
  return [
    ...recents.slice(0, 10).map((r) => ({
      label: r.name,
      sublabel: r.path,
      click: () => send(getWin, 'menu:openRecent', r.path),
    })),
    { type: 'separator' as const },
    { label: 'Clear Recents', click: () => send(getWin, 'menu:clearRecents') },
  ];
}

function buildTemplate(getWin: GetWin, openNewWindow: () => void): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';

  // Settings. On macOS it lives in the app menu (⌘,) per Apple convention; on
  // Win/Linux it goes at the bottom of the File menu. The accelerator is only
  // ever claimed once (whichever menu hosts it) to avoid a duplicate-accelerator.
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => send(getWin, 'menu:settings'),
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => openNewWindow() },
      // Cmd/Ctrl+T opens a browser tab (Chrome-style); New Task keeps a slot.
      { label: 'New Browser Tab', accelerator: 'CmdOrCtrl+T', click: () => send(getWin, 'menu:newBrowser') },
      { label: 'New Task', accelerator: 'CmdOrCtrl+Shift+N', click: () => send(getWin, 'menu:newTask') },
      { label: 'New File…', accelerator: 'CmdOrCtrl+Alt+N', click: () => send(getWin, 'menu:newFile') },
      // Reopen the most-recently-closed tab — all kinds (Chrome-style).
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => send(getWin, 'menu:reopenClosedTab') },
      { type: 'separator' },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send(getWin, 'menu:openFolder') },
      { label: 'Open Recent', submenu: buildOpenRecentSubmenu(getWin) },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send(getWin, 'menu:save') },
      { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: () => send(getWin, 'menu:saveAll') },
      { type: 'separator' },
      // before-input-event owns Cmd+W for the tiered-close. Keep the menu
      // item visible (discoverability) but don't claim the accelerator.
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: () => send(getWin, 'menu:closeTab') },
      { label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', click: () => send(getWin, 'menu:closeProject') },
      // Win/Linux host Settings here; macOS uses the app menu instead.
      ...(isMac ? [] : [{ type: 'separator' as const }, settingsItem]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { label: 'Toggle Tasks Rail', accelerator: 'CmdOrCtrl+B', click: () => send(getWin, 'menu:toggleTasksRail') },
      { label: 'Toggle State Rail', accelerator: 'CmdOrCtrl+Alt+B', click: () => send(getWin, 'menu:toggleStateRail') },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Control+Tab', click: () => send(getWin, 'menu:nextTab') },
      { label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: () => send(getWin, 'menu:prevTab') },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const goMenu: MenuItemConstructorOptions = {
    label: 'Go',
    submenu: [
      { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send(getWin, 'menu:navBack') },
      { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send(getWin, 'menu:navForward') },
      { type: 'separator' },
      { label: 'Home (Close Project)', accelerator: 'CmdOrCtrl+Shift+H', click: () => send(getWin, 'menu:closeProject') },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'windowMenu',
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    role: 'help',
    submenu: [
      { label: 'About Fineguide Tesseract', click: () => send(getWin, 'menu:about') },
      { type: 'separator' },
      { label: 'Report an Issue…', click: () => { void shell.openExternal(REPO_ISSUES_URL); } },
    ],
  };

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      // Same reason as Close Tab — before-input-event owns Cmd+Q (hold-to-quit).
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', registerAccelerator: false, click: () => send(getWin, 'menu:quit') },
    ],
  };

  return isMac
    ? [appMenu, fileMenu, editMenu, viewMenu, goMenu, windowMenu, helpMenu]
    : [fileMenu, editMenu, viewMenu, goMenu, windowMenu, helpMenu];
}

export function installAppMenu(getWin: GetWin, openNewWindow: () => void): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(getWin, openNewWindow)));
}

/** Re-build the menu — used when recents change so Open Recent stays fresh. */
export function refreshAppMenu(getWin: GetWin, openNewWindow: () => void): void {
  installAppMenu(getWin, openNewWindow);
}
