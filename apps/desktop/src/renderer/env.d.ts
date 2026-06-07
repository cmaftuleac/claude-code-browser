/// <reference types="vite/client" />
import type { ClientMessage, ServerMessage, User, AuthResult, ProfilePayload, PlanPayload, HostInfo, Settings, SettingsPatch, UpdaterEvent } from '@fineguide-tesseract/shared';

declare global {
  interface Window {
    ccb: {
      /** True in Electron (preload bridge), false in plain browser (web-transport polyfill). */
      isElectron: boolean;
      /** Capability token appended to media-file:// URLs (empty in web mode). */
      mediaToken: string;
      /** Cloud backend origin (CCB_BACKEND_ORIGIN on desktop; page origin on web). */
      backendOrigin: string;
      send(msg: ClientMessage): Promise<void>;
      onAgentEvent(cb: (msg: ServerMessage) => void): () => void;
      editorPreloadPath(): Promise<string>;
      /** Report a browser instance's <webview> guest webContents id to main. */
      setGuest(browserId: string, webContentsId: number): void;
      /** Tell main a browser instance's guest was destroyed (instance closed). */
      notifyGuestGone(browserId: string): void;
      /** Tell main which browser instance is focused (interim agent target until per-session routing). */
      setActiveBrowser(browserId: string | null): void;
      /** Main asks the renderer to open/navigate a browser (agent navigated with no usable guest). */
      onEnsureBrowser(cb: (payload: { url: string; browserId?: string; requestId: string }) => void): () => void;
      /** Report which browser instance serviced an ensureOpen so main re-keys the parked request. */
      browserEnsured(requestId: string, browserId: string): void;
      ready(): void;
      /** Subscribe to OS memory-pressure escalations from the main-process governor. */
      onMemoryPressure(cb: (level: 'moderate' | 'critical') => void): () => void;
      /** Account-keyed host registry: the cloud server + the user's online machines.
       *  Desktop reports just "this machine"; web lists everything the account can drive. */
      host: {
        list(): Promise<HostInfo[]>;
        /** Route subsequent agent/browser/signal traffic to a host (null = default server). */
        select(hostId: string | null): void;
        selected(): string | null;
        onChange(cb: (hosts: HostInfo[]) => void): () => void;
      };
      /** WebRTC signaling relay (SDP/ICE). Media itself stays peer-to-peer, off the WS. */
      signal: {
        send(browserId: string, msg: unknown): void;
        on(cb: (msg: unknown, browserId?: string) => void): () => void;
      };
      /** Interactive control of a mirrored remote browser + the fallback frame stream. */
      browser: {
        send(browserId: string, msg: unknown): void;
        on(cb: (msg: unknown, browserId?: string) => void): () => void;
        /** Binary fallback video frames (when WebRTC can't establish). */
        onFrame(cb: (data: ArrayBuffer) => void): () => void;
      };
      fs: {
        openFolder(path?: string): Promise<{ root: string; name: string } | null>;
        /** Side-effect-free native folder picker — returns chosen absolute path or null. Electron only. */
        pickFolder(): Promise<string | null>;
        /** Native "Save As" dialog — returns chosen absolute path or null. Electron only. */
        saveDialog(defaultPath?: string): Promise<string | null>;
        readDir(dir: string): Promise<Array<{ name: string; path: string; isDir: boolean }>>;
        readFile(path: string): Promise<{ content?: string; error?: string }>;
        writeFile(path: string, content: string): Promise<{ ok: boolean; error?: string }>;
        createProject(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
        /** Pre-flight: returns size, last-modified time, and whether the file should open as binary. */
        statFile(path: string): Promise<{ size?: number; isBinary?: boolean; mtimeMs?: number; error?: string }>;
        /** Read a byte range as base64. length is server-capped at 1 MB per request. */
        readChunk(path: string, offset: number, length: number): Promise<{ base64?: string; bytesRead?: number; error?: string }>;
        /** Read the entire file as base64. Capped at 256 MB. */
        readBinary(path: string): Promise<{ base64?: string; size?: number; error?: string }>;
        revealInFinder(path: string): Promise<{ ok: boolean; error?: string }>;
        /** Open the file with the system default app. */
        openExternal(path: string): Promise<{ ok: boolean; error?: string }>;
        /** Show the OS "Open With…" app-chooser dialog and open the file with the picked app. */
        openWith(path: string): Promise<{ ok: boolean; error?: string }>;
        /** Rename a file in place (parent dir unchanged, new basename only). */
        renameFile(oldPath: string, newName: string): Promise<{ ok: boolean; newPath?: string; error?: string }>;
        /** Create an empty file inside the project tree. */
        createFile(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
        /** Create an empty folder inside the project tree. */
        createFolder(parent: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
        /** Delete a path (staged so it can be undone this session, then spilled to Trash). */
        deletePath(path: string): Promise<{ ok: boolean; error?: string }>;
        /** Undo the most recent deletion; returns the restored path. */
        undoDelete(): Promise<{ ok: boolean; path?: string; isDir?: boolean; error?: string }>;
        /** Release this window's project root + watcher (on project close). */
        releaseRoot(): Promise<void>;
        /** This window's open project root (survives a renderer reload; pre-seeded
         *  by main on a cold launch when restoring the last session), or null. */
        currentRoot(): Promise<{ root: string; name: string } | null>;
        /** Copy paths into destDir; appends " 2", " 3"… on collision. */
        copyPaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }>;
        /** Move (rename) paths into destDir; both ends inside the project root. */
        movePaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }>;
        /** Resolve a File dropped from the OS into its absolute path (Electron-only). */
        getDroppedFilePath(file: File): string;
        onFsChange(cb: (paths: string[]) => void): () => void;
      };
      /** Per-window workspace snapshot (open tabs + split layout) for reload restore. */
      workspace: {
        saveSnapshot(snapshot: unknown): void;
        getSnapshot(root: string): Promise<unknown | null>;
      };
      recents: {
        list(): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>>;
        add(path: string, name: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>>;
        remove(path: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>>;
      };
      /** Account auth against the cloud API. Web build is gated by it; desktop is optional. */
      auth: {
        /** True only when the SERVER requires auth (gated web build). Desktop → always false. */
        requireAuth(): Promise<boolean>;
        /** Current user from a stored token, or null. Network errors keep the cached user (never logs out). */
        me(): Promise<User | null>;
        login(email: string, password: string): Promise<AuthResult>;
        signup(email: string, password: string, name?: string): Promise<AuthResult>;
        /** Web: full-page redirect (never resolves). Desktop: opens system browser, resolves on callback. */
        loginWithGoogle(): Promise<AuthResult>;
        /** Desktop: abort an in-flight system-browser Google sign-in (Cancel / browser closed). No-op on web. */
        cancelGoogleSignIn(): Promise<void>;
        /** Onboarding step 1: persist name + account type. Returns a re-issued token + user. */
        updateProfile(payload: ProfilePayload): Promise<AuthResult>;
        /** Onboarding step 2 / Manage plan: record the chosen plan. Returns a re-issued token + user. */
        setPlan(payload: PlanPayload): Promise<AuthResult>;
        logout(): Promise<void>;
        /** Out-of-band auth changes (token expiry → 401, OAuth callback, other windows). */
        onChange(cb: (user: User | null) => void): () => void;
      };
      /** Silent background auto-update (packaged desktop only; web is a no-op). */
      updater: {
        onEvent(cb: (event: UpdaterEvent) => void): () => void;
        state(): Promise<UpdaterEvent | null>;
        check(): Promise<void>;
        installNow(): Promise<void>;
      };
      /** User settings (theme, editor, agent, general). Desktop persists in
       *  userData; web persists in localStorage. */
      settings: {
        load(): Promise<Settings>;
        save(patch: SettingsPatch): Promise<Settings>;
        onChange(cb: (settings: Settings) => void): () => void;
      };
      app: {
        quit(): Promise<void>;
        /** Open a new top-level application window. */
        newWindow(): Promise<void>;
        /** Close the window this renderer belongs to. */
        closeWindow(): Promise<void>;
        onCmdW(cb: () => void): () => void;
        onCmdQDown(cb: () => void): () => void;
        onCmdQUp(cb: () => void): () => void;
        /** Subscribe to a `menu:<channel>` event emitted by main when the
         *  user clicks the corresponding application-menu item. */
        onMenu(channel: string, cb: (...args: unknown[]) => void): () => void;
      };
    };
  }
}

export {};
