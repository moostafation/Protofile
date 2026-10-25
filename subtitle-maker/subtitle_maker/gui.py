"""Tkinter window: pick videos, choose languages, press Start."""

import json
import os
import queue
import subprocess
import sys
import threading
import traceback
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from . import instance
from .core import (DEFAULT_MODEL, MEDIA_EXTENSIONS, MODELS, VIDEO_EXTENSIONS,
                   Cancelled, Settings, SubtitleMaker, find_media)
from .languages import LANGUAGES

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
except ImportError:
    TkinterDnD = None

AUTO = "Auto-detect"
SAME = "Same as spoken (no translation)"
LANG_BY_NAME = {name: code for code, name in LANGUAGES}
NAME_BY_LANG = {code: name for code, name in LANGUAGES}
MODEL_LABELS = {f"{name} — {desc} ({size})": name for name, desc, size in MODELS}

WAITING, QUEUED, WORKING, DONE = "Waiting", "Queued", "Working…", "Done"


def _prefs_file():
    base = os.environ.get("APPDATA") or Path.home() / ".config"
    return Path(base) / "SubtitleMaker" / "settings.json"


def load_prefs():
    try:
        return json.loads(_prefs_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_prefs(prefs):
    try:
        path = _prefs_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
    except OSError:
        pass


def open_folder(path):
    path = Path(path)
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", str(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])


class App:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()   # worker/other threads -> UI thread
        self.work = queue.Queue()     # (row id, path) for the worker
        self.cancel = threading.Event()
        self.worker = None
        self.maker = None             # kept between runs so the model stays loaded
        self.rows = {}                # row id -> Path
        self.restart_when_done = False
        self.prefs = load_prefs()

        root.title("Subtitle Maker")
        scale = root.winfo_fpixels("1i") / 96
        root.geometry(f"{int(820 * scale)}x{int(640 * scale)}")
        root.minsize(int(680 * scale), int(520 * scale))
        root.protocol("WM_DELETE_WINDOW", self.on_close)

        self._build()
        root.after(100, self._poll)

    # -- layout ------------------------------------------------------------

    def _build(self):
        style = ttk.Style()
        style.configure("Start.TButton", font=("Segoe UI", 11, "bold"), padding=(18, 6))
        pad = {"padx": 10, "pady": 4}

        files = ttk.LabelFrame(self.root, text="1. Videos")
        files.pack(fill="both", expand=True, **pad)
        bar = ttk.Frame(files)
        bar.pack(fill="x", padx=6, pady=(6, 2))
        ttk.Button(bar, text="Add videos…", command=self.ask_files).pack(side="left")
        ttk.Button(bar, text="Add folder…", command=self.ask_folder).pack(side="left", padx=4)
        ttk.Button(bar, text="Remove", command=self.remove_selected).pack(side="left")
        ttk.Button(bar, text="Clear list", command=self.clear).pack(side="left", padx=4)
        ttk.Button(bar, text="Open folder", command=self.open_selected).pack(side="right")

        tree_box = ttk.Frame(files)
        tree_box.pack(fill="both", expand=True, padx=6, pady=(2, 6))
        self.tree = ttk.Treeview(tree_box, columns=("name", "folder", "status"),
                                 show="headings", height=6)
        for col, title, width in (("name", "File", 260), ("folder", "Folder", 300),
                                  ("status", "Status", 160)):
            self.tree.heading(col, text=title, anchor="w")
            self.tree.column(col, width=width, anchor="w")
        scroll = ttk.Scrollbar(tree_box, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.tree.bind("<Double-1>", lambda e: self.open_selected())
        self.tree.bind("<Delete>", lambda e: self.remove_selected())
        if getattr(self.root, "TkdndVersion", None):  # drag & drop loaded
            self.tree.drop_target_register(DND_FILES)
            self.tree.dnd_bind("<<Drop>>", self._on_drop)
            hint = "Drag videos or folders here, or use the buttons above."
        else:
            hint = "Use the buttons above to add videos or whole folders."
        ttk.Label(files, text=hint, foreground="gray").pack(anchor="w", padx=8, pady=(0, 6))

        opts = ttk.LabelFrame(self.root, text="2. Options")
        opts.pack(fill="x", **pad)
        opts.columnconfigure(1, weight=1)
        names = [name for _, name in LANGUAGES]

        self.language = tk.StringVar()
        self.target = tk.StringVar()
        self.model = tk.StringVar()
        self.keep_original = tk.BooleanVar()
        self.embed = tk.BooleanVar()
        self.overwrite = tk.BooleanVar()

        rows = (("Spoken language:", self.language, [AUTO] + names),
                ("Subtitles in:", self.target, [SAME] + names),
                ("Accuracy:", self.model, list(MODEL_LABELS)))
        for r, (label, var, values) in enumerate(rows):
            ttk.Label(opts, text=label).grid(row=r, column=0, sticky="w", padx=8, pady=3)
            ttk.Combobox(opts, textvariable=var, values=values, state="readonly",
                         height=20).grid(row=r, column=1, sticky="ew", padx=8, pady=3)

        checks = ttk.Frame(opts)
        checks.grid(row=3, column=0, columnspan=2, sticky="w", padx=4, pady=(2, 6))
        self.keep_check = ttk.Checkbutton(
            checks, text="Also keep original-language subtitles", variable=self.keep_original)
        self.keep_check.pack(anchor="w")
        ttk.Checkbutton(checks, text="Also make an MKV copy with the subtitles inside "
                        "(for TVs and phones)", variable=self.embed).pack(anchor="w")
        ttk.Checkbutton(checks, text="Replace subtitle files that already exist",
                        variable=self.overwrite).pack(anchor="w")
        ttk.Label(opts, foreground="gray", wraplength=720, justify="left",
                  text="Subtitles are saved next to each video with the same name "
                       "(movie.mp4 → movie.srt), so VLC, MPC-HC, PotPlayer, mpv, KMPlayer "
                       "and Windows Media Player load them automatically. Translation "
                       "needs internet; transcription works offline after the first "
                       "model download.").grid(row=4, column=0, columnspan=2,
                                               sticky="w", padx=8, pady=(0, 6))
        self.target.trace_add("write", lambda *a: self._sync_keep_check())

        run = ttk.Frame(self.root)
        run.pack(fill="x", **pad)
        self.start_btn = ttk.Button(run, text="Start", style="Start.TButton",
                                    command=self.start)
        self.start_btn.pack(side="left")
        self.cancel_btn = ttk.Button(run, text="Cancel", command=self.stop, state="disabled")
        self.cancel_btn.pack(side="left", padx=6)
        status = ttk.Frame(run)
        status.pack(side="left", fill="x", expand=True, padx=(8, 0))
        self.status = ttk.Label(status, text="Add some videos, then press Start.")
        self.status.pack(anchor="w")
        self.bar = ttk.Progressbar(status, maximum=1.0)
        self.bar.pack(fill="x", pady=(2, 0))

        log_box = ttk.Frame(self.root)
        log_box.pack(fill="both", padx=10, pady=(0, 10))
        self.log_text = tk.Text(log_box, height=7, state="disabled", wrap="word",
                                font=("Consolas", 9), relief="flat", background="#f4f4f4")
        log_scroll = ttk.Scrollbar(log_box, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set)
        self.log_text.pack(side="left", fill="both", expand=True)
        log_scroll.pack(side="right", fill="y")

        self._load_prefs()

    def _load_prefs(self):
        p = self.prefs
        self.language.set(NAME_BY_LANG.get(p.get("language"), AUTO))
        self.target.set(NAME_BY_LANG.get(p.get("target"), SAME))
        model = p.get("model", DEFAULT_MODEL)
        self.model.set(next((lbl for lbl, m in MODEL_LABELS.items() if m == model),
                            next(lbl for lbl, m in MODEL_LABELS.items() if m == DEFAULT_MODEL)))
        self.keep_original.set(p.get("keep_original", True))
        self.embed.set(p.get("embed", False))
        self.overwrite.set(p.get("overwrite", False))
        self._sync_keep_check()

    def _sync_keep_check(self):
        self.keep_check.configure(state="disabled" if self.target.get() == SAME else "normal")

    def settings(self):
        return Settings(
            model=MODEL_LABELS[self.model.get()],
            language=LANG_BY_NAME.get(self.language.get()),
            target=LANG_BY_NAME.get(self.target.get()),
            keep_original=self.keep_original.get(),
            embed=self.embed.get(),
            overwrite=self.overwrite.get(),
        )

    def _save_prefs(self, s):
        self.prefs.update(language=s.language, target=s.target, model=s.model,
                          keep_original=s.keep_original, embed=s.embed,
                          overwrite=s.overwrite)
        save_prefs(self.prefs)

    # -- file list -----------------------------------------------------------

    def ask_files(self):
        patterns = " ".join(f"*{e}" for e in sorted(VIDEO_EXTENSIONS))
        audio = " ".join(f"*{e}" for e in sorted(MEDIA_EXTENSIONS - VIDEO_EXTENSIONS))
        paths = filedialog.askopenfilenames(
            title="Choose videos", initialdir=self.prefs.get("last_dir"),
            filetypes=[("Videos", patterns), ("Audio", audio), ("All files", "*.*")])
        if paths:
            self.prefs["last_dir"] = str(Path(paths[0]).parent)
            self.add_paths(paths)

    def ask_folder(self):
        folder = filedialog.askdirectory(title="Choose a folder (subfolders included)",
                                         initialdir=self.prefs.get("last_dir"))
        if folder:
            self.prefs["last_dir"] = folder
            self.add_paths([folder])

    def _on_drop(self, event):
        self.add_paths(self.root.tk.splitlist(event.data))

    def add_paths(self, paths):
        known = {p: iid for iid, p in self.rows.items()}
        added = 0
        for path in find_media(paths):
            if path.suffix.lower() not in MEDIA_EXTENSIONS:
                self.log(f"Not a video, ignored: {path.name}")
                continue
            iid = known.get(path)
            if iid is None:
                iid = self.tree.insert("", "end", values=(path.name, str(path.parent), WAITING))
                self.rows[iid] = path
                known[path] = iid
            elif self.tree.set(iid, "status") in (QUEUED, WORKING):
                continue
            added += 1
            if self.busy:
                self.tree.set(iid, "status", QUEUED)
                self.work.put((iid, path))
            else:
                self.tree.set(iid, "status", WAITING)
        if not added and paths:
            self.log("No new videos found in what was added.")
        self._update_status_line()

    def remove_selected(self):
        for iid in self.tree.selection():
            if self.tree.set(iid, "status") not in (QUEUED, WORKING):
                self.tree.delete(iid)
                self.rows.pop(iid, None)
        self._update_status_line()

    def clear(self):
        for iid in list(self.rows):
            if self.tree.set(iid, "status") not in (QUEUED, WORKING):
                self.tree.delete(iid)
                del self.rows[iid]
        self._update_status_line()

    def open_selected(self):
        sel = self.tree.selection() or tuple(self.rows)[-1:]
        if sel:
            path = self.rows[sel[0]]
            srt = path.with_suffix(".srt")
            open_folder(srt if srt.exists() else path)

    # -- running ---------------------------------------------------------------

    @property
    def busy(self):
        return self.worker is not None and self.worker.is_alive()

    def start(self):
        if self.busy:
            return
        todo = [iid for iid in self.tree.get_children()
                if self.tree.set(iid, "status") not in (DONE, QUEUED, WORKING)]
        if not todo:
            self.log("Nothing to do — add some videos first.")
            return
        settings = self.settings()
        self._save_prefs(settings)
        if self.maker and (self.maker.settings.model, self.maker.settings.device) == \
                (settings.model, settings.device):
            self.maker.settings = settings
        else:
            self.maker = SubtitleMaker(settings, log=lambda m: self.events.put(("log", m)))

        self.cancel.clear()
        for iid in todo:
            self.tree.set(iid, "status", QUEUED)
            self.work.put((iid, self.rows[iid]))
        self.start_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        self.worker = threading.Thread(target=self._work, args=(self.maker,), daemon=True)
        self.worker.start()

    def stop(self):
        self.cancel.set()
        self.cancel_btn.configure(state="disabled")
        self.status.configure(text="Cancelling…")

    def _work(self, maker):
        emit = self.events.put
        while not self.cancel.is_set():
            try:
                iid, path = self.work.get_nowait()
            except queue.Empty:
                break
            emit(("status", iid, WORKING))
            emit(("log", f"— {path.name}"))
            try:
                result = maker.process(
                    path, progress=lambda f, t, n=path.name: emit(("progress", f, f"{n}: {t}")),
                    cancel=self.cancel)
                if result.status == "done":
                    emit(("status", iid, DONE))
                    emit(("log", f"Done, {result.message}"))
                else:
                    emit(("status", iid, f"Skipped: {result.message}"))
                    emit(("log", f"Skipped: {result.message}"))
            except Cancelled:
                emit(("status", iid, "Cancelled"))
            except Exception as e:
                emit(("status", iid, "Failed"))
                emit(("log", f"FAILED: {e}"))
                emit(("log", traceback.format_exc().rstrip()))
        emit(("finished",))

    def _poll(self):
        try:
            while True:
                event = self.events.get_nowait()
                kind = event[0]
                if kind == "log":
                    self.log(event[1])
                elif kind == "status":
                    if self.tree.exists(event[1]):
                        self.tree.set(event[1], "status", event[2])
                    self._update_status_line()
                elif kind == "progress":
                    self.bar["value"] = event[1]
                    self.status.configure(text=event[2])
                elif kind == "finished":
                    self._finished()
                elif kind == "external":
                    self._external(event[1], event[2])
        except queue.Empty:
            pass
        self.root.after(100, self._poll)

    def _finished(self):
        self.worker = None
        while not self.work.empty():  # left over after Cancel
            iid, _ = self.work.get_nowait()
            if self.tree.exists(iid):
                self.tree.set(iid, "status", WAITING)
        self.start_btn.configure(state="normal")
        self.cancel_btn.configure(state="disabled")
        self.bar["value"] = 0
        self._update_status_line(final=True)
        # Files can arrive from the right-click menu just as the worker exits.
        if self.restart_when_done and not self.cancel.is_set():
            self.restart_when_done = False
            if any(self.tree.set(i, "status") == WAITING for i in self.rows):
                self.start()

    def _external(self, paths, start):
        self.raise_window()
        if paths:
            self.add_paths(paths)
        if start:
            if self.busy:
                self.restart_when_done = True
            else:
                self.start()

    def _update_status_line(self, final=False):
        if self.busy and not final:
            return
        statuses = [self.tree.set(i, "status") for i in self.rows]
        done = statuses.count(DONE)
        failed = statuses.count("Failed")
        waiting = statuses.count(WAITING)
        parts = [f"{len(statuses)} file(s)", f"{done} done"]
        if failed:
            parts.append(f"{failed} failed")
        if waiting:
            parts.append(f"{waiting} waiting")
        self.status.configure(text=", ".join(parts) if statuses else
                              "Add some videos, then press Start.")

    def log(self, message):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def raise_window(self):
        self.root.deiconify()
        self.root.lift()
        self.root.attributes("-topmost", True)
        self.root.after(300, lambda: self.root.attributes("-topmost", False))
        self.root.focus_force()

    def on_close(self):
        if self.busy and not messagebox.askyesno(
                "Subtitle Maker", "Subtitles are still being made. Stop and quit?"):
            return
        self.cancel.set()
        save_prefs(self.prefs)
        self.root.destroy()


def _make_root():
    if sys.platform == "win32":
        try:  # sharp text on high-DPI screens
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    if TkinterDnD:
        try:
            return TkinterDnD.Tk()
        except Exception:  # tkdnd binary missing for this Tk version
            pass
    return tk.Tk()


def main(paths=(), autostart=False):
    sock = instance.claim()
    if sock is None and instance.send(paths, autostart):
        return  # an open window took the files

    root = _make_root()
    app = App(root)
    if sock is not None:
        instance.serve(sock, lambda p, s: app.events.put(("external", p, s)))
    if paths:
        app.add_paths(paths)
    if autostart:
        root.after(500, app.start)
    root.mainloop()
