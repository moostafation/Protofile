// The desktop program (Electron, ../desktop) when the Studio runs inside it; null in a browser.

export interface DesktopFile {
  path: string;
  name: string;
  bytes: Uint8Array;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  user: string;
  host: string;
  electron: string;
  autoSave: boolean;
  recent: string[];
}

export type MenuCommand = "new" | "open" | "demo" | "save" | "save-as" | "auto-save" | "export" | "undo" | "redo" | "delete" | "run" | "focus-command" | "database" | "help";

export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  /** The file this program was started with (double-click on a .pfdb), once. */
  initialFile(): Promise<DesktopFile | { error: string } | null>;
  openDialog(): Promise<DesktopFile | null>;
  readFile(path: string): Promise<DesktopFile>;
  /** Write the plant database to `path`, or ask where when it is null. */
  saveFile(o: { path: string | null; bytes: Uint8Array; suggestedName: string }): Promise<{ path: string; name: string } | null>;
  exportFile(o: { filename: string; data: string | Uint8Array }): Promise<{ path: string; name: string } | null>;
  setDocument(state: { path: string | null; name: string; dirty: boolean }): void;
  /** A native message box; resolves to the index of the button pressed. */
  ask(o: { message: string; detail?: string; buttons: string[]; type?: "none" | "info" | "error" | "question" | "warning"; defaultId?: number; cancelId?: number }): Promise<number>;
  closeNow(how?: "reload"): void;
  showInFolder(path: string): void;
  pathForFile(file: File): string | null;
  on(channel: "menu", fn: (cmd: MenuCommand, arg?: string | boolean) => void): () => void;
  on(channel: "open-path", fn: (path: string) => void): () => void;
  on(channel: "close-requested", fn: (how?: "reload") => void): () => void;
}

export const desktop: DesktopBridge | null = typeof window !== "undefined" ? ((window as unknown as { plantforgeDesktop?: DesktopBridge }).plantforgeDesktop ?? null) : null;

export const isDesktop = () => desktop !== null;
