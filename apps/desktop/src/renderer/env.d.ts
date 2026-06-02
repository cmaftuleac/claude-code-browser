/// <reference types="vite/client" />
import type { ClientMessage, ServerMessage } from '@claude-code-browser/shared';

declare global {
  interface Window {
    ccb: {
      /** True in Electron (preload bridge), false in plain browser (web-transport polyfill). */
      isElectron: boolean;
      send(msg: ClientMessage): Promise<void>;
      onAgentEvent(cb: (msg: ServerMessage) => void): () => void;
      editorPreloadPath(): Promise<string>;
      setGuest(webContentsId: number): void;
      ready(): void;
      fs: {
        openFolder(path?: string): Promise<{ root: string; name: string } | null>;
        /** Side-effect-free native folder picker — returns chosen absolute path or null. Electron only. */
        pickFolder(): Promise<string | null>;
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
        /** Move a path (file or folder) to the system Trash. Recoverable via Finder. */
        deletePath(path: string): Promise<{ ok: boolean; error?: string }>;
        /** Copy paths into destDir; appends " 2", " 3"… on collision. */
        copyPaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }>;
        /** Move (rename) paths into destDir; both ends inside the project root. */
        movePaths(srcPaths: string[], destDir: string): Promise<{ ok: boolean; newPaths?: string[]; error?: string }>;
        /** Resolve a File dropped from the OS into its absolute path (Electron-only). */
        getDroppedFilePath(file: File): string;
        onFsChange(cb: (paths: string[]) => void): () => void;
      };
      recents: {
        list(): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>>;
        add(path: string, name: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>>;
        remove(path: string): Promise<Array<{ path: string; name: string; lastOpenedAt: number }>>;
      };
      app: {
        quit(): Promise<void>;
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
