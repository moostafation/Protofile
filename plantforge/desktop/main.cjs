// PlantForge Studio, desktop edition: the Electron main process.
//
// The window shows the same Studio as the web version (built into ./app by `npm run app`). This process
// adds what a desktop program needs: plant database files (.pfdb, a standard SQLite 3 file) opened and
// saved on this computer, native menus and dialogs, recent files, one window per running program,
// double-click on a .pfdb file, and an "unsaved changes" prompt on close.

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_DIR = path.join(__dirname, "app");
const SCHEME = "plantforge";
const START_URL = `${SCHEME}://studio/index.html`;
const EXT = "pfdb";
const OPENABLE = ["pfdb", "sqlite", "sqlite3", "db", "json", "zip"];
const MAX_RECENT = 10;

const OPEN_FILTERS = [
  { name: "PlantForge files", extensions: OPENABLE },
  { name: "Plant database (.pfdb)", extensions: [EXT] },
  { name: "SQLite database", extensions: ["sqlite", "sqlite3", "db"] },
  { name: "PlantForge model (.json)", extensions: ["json"] },
  { name: "Database backup (.zip)", extensions: ["zip"] },
];

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ------------------------------------------------------------------ settings (window, recent files, options)
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = { bounds: null, maximized: false, recent: [], autoSave: false, openDir: null, exportDir: null };

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    /* first run */
  }
  settings.recent = (settings.recent ?? []).filter((p) => typeof p === "string");
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 1));
  } catch (e) {
    console.error("settings not saved", e);
  }
}

function addRecent(file) {
  settings.recent = [file, ...settings.recent.filter((p) => p.toLowerCase() !== file.toLowerCase())].slice(0, MAX_RECENT);
  saveSettings();
  app.addRecentDocument(file);
  buildMenu();
}

// ------------------------------------------------------------------ files
const isOpenable = (p) => typeof p === "string" && OPENABLE.includes(path.extname(p).slice(1).toLowerCase()) && fs.existsSync(p);

/** A plant file named on the command line (double-click in Explorer, "Open with", a second launch). */
const fileFromArgs = (argv) => argv.slice(1).find((a) => !a.startsWith("-") && isOpenable(path.resolve(a)));

// The page may only write to database files the user picked in a dialog, opened, or saved before.
const known = new Set();
const isDatabase = (p) => /\.(pfdb|sqlite3?|db)$/i.test(p);

/** Read a plant file for the page. Database files (not .json models or .zip backups) go in the recent list. */
function readPlantFile(file) {
  const full = path.resolve(file);
  if (!OPENABLE.includes(path.extname(full).slice(1).toLowerCase())) throw new Error("not a PlantForge file");
  const bytes = fs.readFileSync(full);
  if (isDatabase(full)) {
    known.add(full);
    addRecent(full);
  }
  return { path: full, name: path.basename(full), bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

const backedUp = new Set();

/** Write a file safely: next to it first, then swap it in, so a crash never leaves half a database.
 *  The first time a file is overwritten in a session, the version it had is kept as <name>.bak. */
function writeSafely(file, bytes) {
  const tmp = `${file}.saving`;
  fs.writeFileSync(tmp, bytes);
  if (fs.existsSync(file) && !backedUp.has(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* the backup is a convenience */
    }
    backedUp.add(file);
  }
  fs.renameSync(tmp, file);
}

const withExt = (file, ext) => (path.extname(file).toLowerCase() === `.${ext}` ? file : `${file}.${ext}`);

// ------------------------------------------------------------------ window
let win = null;
let pendingFile = null; // a file to open once the page asks for it
let doc = { path: null, name: "", dirty: false };
let closing = false;
let pageAnswersClose = false; // the page has its "unsaved changes" handler installed

function visibleBounds(b) {
  if (!b) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const overlaps = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y < area.y + area.height - 100 && b.y + b.height > area.y;
  return overlaps ? b : null;
}

function createWindow() {
  const bounds = visibleBounds(settings.bounds);
  win = new BrowserWindow({
    width: bounds?.width ?? 1600,
    height: bounds?.height ?? 960,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "PlantForge Studio",
    backgroundColor: "#16233a",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (settings.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("page-title-updated", (e) => e.preventDefault());

  // links open in the normal browser; the window itself never navigates away (a dropped file is opened, not shown)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${SCHEME}://`)) e.preventDefault();
  });

  const remember = () => {
    if (!win || win.isMinimized()) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized && !win.isFullScreen()) settings.bounds = win.getBounds();
  };
  win.on("resize", remember);
  win.on("move", remember);

  // unsaved changes: the page asks Save / Don't Save / Cancel and then closes the window itself
  win.on("close", (e) => {
    remember();
    saveSettings();
    if (closing || !pageAnswersClose) return;
    e.preventDefault();
    win.webContents.send("close-requested");
  });
  win.on("closed", () => (win = null));
  win.webContents.on("did-start-loading", () => (pageAnswersClose = false));
  // a crashed or frozen page cannot answer: let the window close
  win.webContents.on("render-process-gone", () => (closing = true));
  win.on("unresponsive", () => (closing = true));
  win.on("responsive", () => (closing = false));

  win.loadURL(START_URL);
}

function setTitle() {
  if (!win) return;
  const name = doc.path ? path.basename(doc.path) : `${doc.name || "Untitled"} (not saved to a file)`;
  win.setTitle(`${name}${doc.dirty ? " *" : ""} - PlantForge Studio`);
  win.setDocumentEdited(!!doc.dirty);
  if (doc.path) win.setRepresentedFilename(doc.path);
}

const send = (channel, ...args) => win?.webContents.send(channel, ...args);
const menu = (cmd, arg) => () => send("menu", cmd, arg);

function openRecent(file) {
  if (!fs.existsSync(file)) {
    settings.recent = settings.recent.filter((p) => p !== file);
    saveSettings();
    buildMenu();
    dialog.showMessageBox(win, { type: "warning", message: `${path.basename(file)} was not found`, detail: file });
    return;
  }
  send("open-path", file);
}

// ------------------------------------------------------------------ menus
function buildMenu() {
  const mac = process.platform === "darwin";
  const recent = settings.recent.length
    ? [...settings.recent.map((p, i) => ({ label: `${i + 1}  ${path.basename(p)}`, sublabel: path.dirname(p), toolTip: p, click: () => openRecent(p) })), { type: "separator" }, { label: "Clear recent files", click: () => ((settings.recent = []), saveSettings(), app.clearRecentDocuments(), buildMenu()) }]
    : [{ label: "No recent files", enabled: false }];
  const view = (label, name, accelerator) => ({ label, accelerator, click: menu("run", `view ${name}`) });
  const template = [
    ...(mac ? [{ role: "appMenu" }] : []),
    {
      label: "&File",
      submenu: [
        { label: "&New plant", accelerator: "CmdOrCtrl+N", click: menu("new") },
        { label: "&Open…", accelerator: "CmdOrCtrl+O", click: menu("open") },
        { label: "Open &recent", submenu: recent },
        { label: "Open the &demo unit", click: menu("demo") },
        { type: "separator" },
        { label: "&Save", accelerator: "CmdOrCtrl+S", click: menu("save") },
        { label: "Save &as…", accelerator: "CmdOrCtrl+Shift+S", click: menu("save-as") },
        {
          label: "Save automatically",
          type: "checkbox",
          checked: !!settings.autoSave,
          click: (item) => {
            settings.autoSave = item.checked;
            saveSettings();
            send("menu", "auto-save", item.checked);
          },
        },
        { type: "separator" },
        {
          label: "&Export",
          submenu: [
            { label: "Fabrication package: PCF, isometrics, MTO (.zip)…", click: menu("export", "zip") },
            { label: "Material take-off (.csv)…", click: menu("export", "csv") },
            { label: "All reports (.csv in .zip)…", click: menu("export", "reports") },
            { label: "Model (.json)…", click: menu("export", "json") },
            { label: "Project for IFC (.toml)…", click: menu("export", "toml") },
            { label: "3D view image (.png)…", click: menu("export", "png") },
            { type: "separator" },
            { label: "Database backup (.sqlite in .zip)…", click: menu("export", "sqlite") },
          ],
        },
        { label: "Show the file in its &folder", click: () => doc.path && shell.showItemInFolder(doc.path) },
        { type: "separator" },
        mac ? { role: "close" } : { label: "E&xit", accelerator: "Alt+F4", click: () => win?.close() },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        // the page handles these keys itself (it knows when you are typing in a box)
        { label: "&Undo", accelerator: "CmdOrCtrl+Z", registerAccelerator: false, click: menu("undo") },
        { label: "&Redo", accelerator: "CmdOrCtrl+Y", registerAccelerator: false, click: menu("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "&Delete selected", accelerator: "Delete", registerAccelerator: false, click: menu("delete") },
        { label: "Select &none", accelerator: "Esc", registerAccelerator: false, click: menu("run", "select none") },
      ],
    },
    {
      label: "&View",
      submenu: [
        { label: "&Fit all", accelerator: "F", registerAccelerator: false, click: menu("run", "zoom") },
        { type: "separator" },
        view("Iso SE", "iso"),
        view("Iso SW", "iso sw"),
        view("Iso NE", "iso ne"),
        view("Iso NW", "iso nw"),
        view("&Plan", "plan"),
        view("Elevation &North", "north"),
        view("Elevation &East", "east"),
        view("Elevation &South", "south"),
        view("Elevation &West", "west"),
        { type: "separator" },
        { label: "Show &all", click: menu("run", "show all") },
        { label: "&Labels on / off", click: menu("run", "labels") },
        { label: "Colour by &status", click: menu("run", "color by status") },
        { label: "Colour by &line", click: menu("run", "color by line") },
        { label: "Section &off", click: menu("run", "section off") },
        { type: "separator" },
        { role: "resetZoom", label: "Actual size" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "&Tools",
      submenu: [
        { label: "&Command window", accelerator: "CmdOrCtrl+L", click: menu("focus-command") },
        { label: "&Database manager", accelerator: "CmdOrCtrl+D", click: menu("database") },
        { type: "separator" },
        { label: "Check the &model", click: menu("run", "check") },
        { label: "&Clash check", click: menu("run", "clash") },
        { label: "List &free nozzles", click: menu("run", "list free nozzles") },
        { type: "separator" },
        { label: "Developer tools", accelerator: "CmdOrCtrl+Shift+I", click: () => win?.webContents.toggleDevTools() },
        { label: "Reload the window", click: () => send("close-requested", "reload") },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "&Commands", accelerator: "F1", click: menu("help") },
        { type: "separator" },
        { label: "Where are my settings?", click: () => shell.openPath(app.getPath("userData")) },
        {
          label: "&About PlantForge Studio",
          click: () =>
            dialog.showMessageBox(win, {
              type: "info",
              title: "About PlantForge Studio",
              message: `PlantForge Studio ${app.getVersion()}`,
              detail: [
                "3D plant & piping design, desktop edition.",
                "Plant database files (.pfdb) are standard SQLite 3 databases.",
                "",
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
                `${os.type()} ${os.release()} ${process.arch}`,
              ].join("\n"),
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------ requests from the page
function installIpc() {
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    user: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return process.env.USERNAME || process.env.USER || "";
      }
    })(),
    host: os.hostname(),
    electron: process.versions.electron,
    autoSave: !!settings.autoSave,
    recent: settings.recent,
  }));

  ipcMain.handle("file:initial", () => {
    const f = pendingFile;
    pendingFile = null;
    if (!f) return null;
    try {
      return readPlantFile(f);
    } catch (e) {
      return { error: `${path.basename(f)}: ${e.message}` };
    }
  });

  ipcMain.handle("file:read", (_e, file) => {
    const f = readPlantFile(file);
    settings.openDir = path.dirname(f.path);
    return f;
  });

  ipcMain.handle("file:open-dialog", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Open a plant", defaultPath: settings.openDir ?? app.getPath("documents"), filters: OPEN_FILTERS, properties: ["openFile"] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.openDir = path.dirname(r.filePaths[0]);
    saveSettings();
    return readPlantFile(r.filePaths[0]);
  });

  /** Save the plant database: to `path` when given, else ask where. Returns where it went, or null. */
  ipcMain.handle("file:save", async (_e, { path: target, bytes, suggestedName }) => {
    // write straight back only to a database file this program opened or saved (or reopens from the
    // recent list after a crash); anything else goes through the Save dialog
    const allowed = (p) => isDatabase(p) && (known.has(path.resolve(p)) || settings.recent.some((r) => r.toLowerCase() === path.resolve(p).toLowerCase()));
    let file = target && allowed(target) ? path.resolve(target) : null;
    if (!file) {
      const r = await dialog.showSaveDialog(win, {
        title: "Save the plant database",
        defaultPath: target ? withExt(target, EXT) : path.join(settings.openDir ?? app.getPath("documents"), withExt(suggestedName || "plant", EXT)),
        filters: [{ name: "PlantForge plant database", extensions: [EXT] }],
      });
      if (r.canceled || !r.filePath) return null;
      file = withExt(r.filePath, EXT);
      settings.openDir = path.dirname(file);
    }
    known.add(file);
    writeSafely(file, Buffer.from(bytes));
    addRecent(file);
    return { path: file, name: path.basename(file) };
  });

  /** Exports (packages, reports, images): ask where, remember the folder. */
  ipcMain.handle("file:export", async (_e, { filename, data }) => {
    const ext = path.extname(filename).slice(1);
    const r = await dialog.showSaveDialog(win, {
      title: `Export ${filename}`,
      defaultPath: path.join(settings.exportDir ?? settings.openDir ?? app.getPath("documents"), filename),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All files", extensions: ["*"] }] : [],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, typeof data === "string" ? data : Buffer.from(data));
    settings.exportDir = path.dirname(r.filePath);
    saveSettings();
    return { path: r.filePath, name: path.basename(r.filePath) };
  });

  ipcMain.on("doc:state", (_e, state) => {
    doc = { path: state?.path ?? null, name: String(state?.name ?? ""), dirty: !!state?.dirty };
    setTitle();
  });

  ipcMain.handle("dialog:ask", async (_e, o) => {
    const r = await dialog.showMessageBox(win, {
      type: o.type ?? "question",
      title: "PlantForge Studio",
      message: String(o.message ?? ""),
      detail: o.detail ? String(o.detail) : undefined,
      buttons: o.buttons ?? ["OK"],
      defaultId: o.defaultId ?? 0,
      cancelId: o.cancelId ?? (o.buttons?.length ?? 1) - 1,
      noLink: true,
    });
    return r.response;
  });

  ipcMain.on("win:close-now", (_e, how) => {
    if (!win) return;
    if (how === "reload") return win.webContents.reload();
    closing = true;
    win.close();
  });

  ipcMain.on("close:handled", () => (pageAnswersClose = true));

  ipcMain.on("shell:show", (_e, file) => typeof file === "string" && shell.showItemInFolder(file));
}

// ------------------------------------------------------------------ start
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("com.plantforge.studio");
  pendingFile = fileFromArgs(process.argv) ?? null;

  app.on("second-instance", (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = fileFromArgs(argv);
    if (f) send("open-path", path.resolve(f));
  });

  app.on("open-file", (e, file) => {
    // macOS: double-click in Finder / drop on the dock icon
    e.preventDefault();
    if (win) send("open-path", file);
    else pendingFile = file;
  });

  app.whenReady().then(() => {
    loadSettings();
    protocol.handle(SCHEME, (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname);
      const file = path.normalize(path.join(APP_DIR, rel));
      if (!file.startsWith(APP_DIR + path.sep)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    // nothing outside this program is loaded; only clipboard writes (Copy PCF) are allowed
    const ses = require("electron").session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === "clipboard-sanitized-write"));
    ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_d, done) => done({ cancel: true }));

    installIpc();
    buildMenu();
    createWindow();
    app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });

  app.on("window-all-closed", () => app.quit());
}
