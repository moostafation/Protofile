// Top bar, command line, toasts, help, isometric viewer and projects dialog.

import { useEffect, useMemo, useRef, useState } from "react";
import { demoDoc } from "../engine/demo";
import { PlantDoc, emptyDoc } from "../engine/doc";
import { toSvg } from "../engine/drawing";
import { lineIsometric } from "../engine/iso";
import { linePcf } from "../engine/pcf";
import { Cloud, ProjectMeta, canDownload, cloud, inClaude } from "../platform/claude";
import type { DbState } from "../db/PlantDB";
import { newDatabase, openState } from "../db/service";
import { SharedPlantMeta, deleteShared, joinShared, leaveShared, listShared, shareCurrent, sharedAvailable } from "../db/shared";
import { personName } from "../platform/people";
import { HELP, runCommand } from "./cli";
import { copyText, exportLine } from "./exporters";
import { cliHooks, hub } from "./hub";
import { Icon } from "./icons";
import { useStore } from "./store";

// ------------------------------------------------------------------ top bar
export function TopBar({ assistantAvailable, projectId, onSave }: { assistantAvailable: boolean; projectId: string | null; onSave: () => void }) {
  const s = useStore();
  const hard = (s.model.clashes ?? []).filter((c) => c.hard).length;
  const errors = s.model.todo.filter((t) => t.level === "error").length;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <path d="M3 18V9h7V4h11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="3" cy="18" r="2.2" fill="currentColor" />
            <circle cx="21" cy="4" r="2.2" fill="currentColor" />
          </svg>
        </span>
        <span className="brand-name">PlantForge</span>
        <span className="brand-sub">Studio</span>
      </div>
      <div className="tb-project">
        <span className="mono">{s.doc.project.name || "Untitled plant"}</span>
        <span className="muted">
          {[s.doc.project.area, s.doc.project.unit].filter(Boolean).join(" · ")}
          {s.dirty ? " · unsaved changes" : projectId ? " · saved" : ""}
        </span>
      </div>
      <div className="tb-status">
        <span className={`pill ${hard ? "crit" : "ok"}`} title="Hard clashes">
          {hard ? `${hard} clash${hard > 1 ? "es" : ""}` : "Clash-free"}
        </span>
        {errors > 0 && <span className="pill crit">{errors} to fix</span>}
        <button type="button" id="db-pill" className={`db-pill${s.shared ? ` ${s.shared.status}` : ""}`} onClick={() => s.set({ dbOpen: true, dbPage: "overview" })} title={s.shared ? `Shared plant database "${s.shared.name}" (${s.shared.status})` : "Plant database kept in this browser"}>
          <Icon name="database" size={14} />
          <span>{s.shared ? (s.shared.status === "live" ? "Shared · live" : `Shared · ${s.shared.status}`) : "Local DB"}</span>
          <span className="db-user">
            <Icon name="user" size={13} /> {s.user.name}
            {s.user.canApprove ? "" : " · no approve"}
          </span>
        </button>
      </div>
      <div className="tb-actions">
        <button type="button" className="btn ghost" onClick={() => s.set({ projectsOpen: true })}>
          <Icon name="folder" size={16} /> Projects
        </button>
        <button type="button" className="btn ghost" onClick={onSave} title="Save to your account">
          <Icon name="save" size={16} /> Save
        </button>
        <button type="button" className="btn ghost icon-only" onClick={() => s.set({ helpOpen: true })} aria-label="Help">
          <Icon name="help" size={17} />
        </button>
        {assistantAvailable && (
          <button type="button" id="open-assistant" className="btn accent" onClick={() => s.set({ assistantOpen: !s.assistantOpen })}>
            <Icon name="spark" size={16} /> AI Assistant
          </button>
        )}
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ command line
export function CommandBar() {
  const log = useStore((s) => s.log);
  const [v, setV] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [open, setOpen] = useState(false);
  const last = log[log.length - 1];
  return (
    <footer className="cmdbar">
      {open && (
        <div className="cmd-log" role="log">
          {log.slice(-60).map((l, i) => (
            <div key={i} className={`cmd-${l.kind}`}>
              {l.kind === "in" ? "› " : ""}
              {l.text}
            </div>
          ))}
        </div>
      )}
      <form
        className="cmd-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.trim()) return;
          runCommand(v, cliHooks);
          setHist((h) => [...h.slice(-50), v]);
          setHi(-1);
          setV("");
        }}
      >
        <button type="button" className="cmd-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Show command history">
          <Icon name="chevron" size={13} className={open ? "rot-up" : "rot-down"} />
        </button>
        <span className="cmd-prompt mono">CMD›</span>
        <input
          id="command-line"
          className="mono"
          value={v}
          placeholder="Type a command: HELP · CONNECT P-101A/N2 E-101/N1 · E 2000 while routing · NEW PUMP AT E 0 N 0"
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && hist.length) {
              const i = hi < 0 ? hist.length - 1 : Math.max(0, hi - 1);
              setHi(i);
              setV(hist[i]);
              e.preventDefault();
            }
            if (e.key === "ArrowDown" && hi >= 0) {
              const i = hi + 1;
              if (i >= hist.length) {
                setHi(-1);
                setV("");
              } else {
                setHi(i);
                setV(hist[i]);
              }
              e.preventDefault();
            }
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {last && !open && <span className={`cmd-last cmd-${last.kind}`}>{last.text}</span>}
      </form>
    </footer>
  );
}

// ------------------------------------------------------------------ toasts
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ modal shell
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ help
export function Help() {
  const set = useStore((s) => s.set);
  return (
    <Modal title="Working in PlantForge Studio" onClose={() => set({ helpOpen: false })}>
      <div className="help">
        <section>
          <h3>Mouse</h3>
          <ul>
            <li>Left-drag orbits · right-drag pans · wheel zooms to the cursor</li>
            <li>Click selects · double-click selects the whole line or equipment and zooms to it</li>
            <li>The cube in the corner snaps to plan and elevations</li>
          </ul>
        </section>
        <section>
          <h3>Routing a pipe (Piping › Route pipe)</h3>
          <ul>
            <li>Click a free nozzle, a line's open end, or the grid</li>
            <li>Move along an axis: the pipe, elbows and flanges preview live from the spec</li>
            <li>It snaps to 50 mm and to nozzle alignments (hold Shift for free length)</li>
            <li>Click to add a bend, or type <code>E 2000</code>, <code>U 1500</code>, <code>S 800</code></li>
            <li>Hover a free nozzle to see an auto-route to it, click to finish there</li>
            <li>Enter finishes with an open end, Shift+Enter with a flange, Backspace removes a point</li>
          </ul>
        </section>
        <section>
          <h3>Keys</h3>
          <ul>
            <li>Ctrl+Z / Ctrl+Y undo and redo · Delete removes the selected object · F fits all · Esc cancels</li>
            <li>R rotates equipment while placing · Tab turns a tee branch while inserting</li>
          </ul>
        </section>
        <section>
          <h3>Command line</h3>
          <ul className="mono small">
            {HELP.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </section>
        <p className="note">
          Dimensions come from ASME B36.10M, B16.9, B16.5 (Class 150) and B16.10 tables compiled for development. Check them against your licensed standards before issuing drawings.
        </p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ isometric viewer
export function IsoView() {
  const s = useStore();
  const id = s.isoLine!;
  const [zoom, setZoom] = useState(1);
  const [dl, setDl] = useState(false);
  useEffect(() => {
    canDownload().then(setDl);
  }, []);
  const svg = useMemo(() => {
    try {
      return toSvg(lineIsometric(s.model, id));
    } catch {
      return "";
    }
  }, [s.model, id]);
  const res = s.model.lines.get(id);
  return (
    <Modal title="Isometric" onClose={() => s.set({ isoLine: null })} wide>
      <div className="iso-tools">
        <select id="iso-line" value={id} onChange={(e) => s.set({ isoLine: e.target.value })} aria-label="Line">
          {[...s.model.lines.values()].map((l) => (
            <option key={l.doc.id} value={l.doc.id}>
              {l.doc.number}
            </option>
          ))}
        </select>
        <div className="seg">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.6, z - 0.25))} aria-label="Zoom out">
            −
          </button>
          <span className="mono">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Zoom in">
            +
          </button>
        </div>
        <span className="grow" />
        {dl && (
          <>
            <button type="button" className="btn" onClick={() => exportLine(id, "svg")}>
              <Icon name="download" size={15} /> SVG
            </button>
            <button type="button" className="btn" onClick={() => exportLine(id, "zip")}>
              <Icon name="download" size={15} /> DXF + PCF (.zip)
            </button>
          </>
        )}
        <button type="button" className="btn" disabled={!res || !!res.error} onClick={async () => s.toast((await copyText(linePcf(s.model, res!))) ? "PCF copied" : "Copy is blocked here", "info")}>
          <Icon name="copy" size={15} /> Copy PCF
        </button>
      </div>
      <div className="iso-paper">
        <div className="iso-scale" style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ projects
export function Projects({ projectId, setProjectId, onSave }: { projectId: string | null; setProjectId: (id: string | null) => void; onSave: () => Promise<void> }) {
  const s = useStore();
  const [c, setC] = useState<Cloud | null | undefined>(undefined);
  const [list, setList] = useState<ProjectMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const refresh = async (cl: Cloud | null) => {
    if (!cl) return;
    try {
      setList(await cl.list());
    } catch {
      setList([]);
    }
  };
  useEffect(() => {
    cloud().then((cl) => {
      setC(cl);
      refresh(cl);
    });
  }, []);
  const finish = (id: string | null, label: string) => {
    setProjectId(id);
    s.set({ projectsOpen: false });
    setTimeout(() => hub.viewer?.setView("iso-sw"), 50);
    s.toast(label);
  };
  const open = async (doc: PlantDoc, id: string | null, label: string) => {
    await newDatabase(doc, label, id);
    finish(id, label);
  };
  const openSaved = async (state: DbState | { doc: PlantDoc }, id: string, label: string) => {
    await openState(state, label, id);
    finish(id, label);
  };
  return (
    <Modal title="Projects" onClose={() => s.set({ projectsOpen: false })}>
      <div className="projects">
        <div className="proj-actions">
          <button type="button" className="btn" onClick={() => open({ ...emptyDoc(), project: { name: "New plant", plant: "", area: "A-100", unit: "U-100" } }, null, "Started a new plant")}>
            <Icon name="plus" size={15} /> New plant
          </button>
          <button type="button" className="btn" onClick={() => open(demoDoc(), null, "Loaded the demo unit")}>
            <Icon name="iso" size={15} /> Demo unit
          </button>
          <button type="button" className="btn" onClick={() => file.current?.click()}>
            <Icon name="upload" size={15} /> Import .json
          </button>
          <input
            ref={file}
            id="import-file"
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const doc = JSON.parse(await f.text()) as PlantDoc;
                if (doc.version !== 1 || !Array.isArray(doc.lines)) throw new Error("not a PlantForge model");
                open(doc, null, `Imported ${f.name}`);
              } catch (err) {
                s.toast(`Could not import: ${(err as Error).message}`, "error");
              }
            }}
          />
        </div>
        <SharedPlants onDone={(label) => finish(null, label)} />
        <h3>Saved in your account (private)</h3>
        {c === undefined && <p className="muted">Checking…</p>}
        {c === null && (
          <p className="muted">
            {inClaude() ? "Saving to your account needs you to be signed in to Claude." : "Saving to your account works when this page is opened in Claude."} Your latest work is also kept in this browser.
          </p>
        )}
        {c && (
          <>
            <button
              type="button"
              className="btn accent"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await onSave();
                await refresh(c);
                setBusy(false);
              }}
            >
              <Icon name="save" size={15} /> Save “{s.doc.project.name}”
            </button>
            {list.length === 0 ? (
              <p className="muted">No saved projects yet.</p>
            ) : (
              <ul className="proj-list">
                {list.map((p) => (
                  <li key={p.id} className={p.id === projectId ? "on" : ""}>
                    <button
                      type="button"
                      className="proj-open"
                      onClick={async () => {
                        const state = await c.load(p.id);
                        if (state) openSaved(state, p.id, `Opened ${p.name}`);
                      }}
                    >
                      <span className="mono">{p.name}</span>
                      <span className="muted">
                        {p.equipment} equipment · {p.lines} lines · {new Date(p.updatedAt).toLocaleString()}
                      </span>
                    </button>
                    {confirmId === p.id ? (
                      <span className="confirm">
                        <button
                          type="button"
                          className="btn small danger"
                          onClick={async () => {
                            await c.remove(p.id);
                            if (p.id === projectId) setProjectId(null);
                            setConfirmId(null);
                            refresh(c);
                          }}
                        >
                          Delete
                        </button>
                        <button type="button" className="btn small" onClick={() => setConfirmId(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="icon-btn" aria-label={`Delete ${p.name}`} onClick={() => setConfirmId(p.id)}>
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ shared plants (team database)
function SharedPlants({ onDone }: { onDone: (label: string) => void }) {
  const s = useStore();
  const [ok, setOk] = useState<boolean | undefined>(undefined);
  const [list, setList] = useState<SharedPlantMeta[]>([]);
  const [busy, setBusy] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const refresh = async () => {
    try {
      setList(await listShared());
    } catch {
      setList([]);
    }
  };
  useEffect(() => {
    sharedAvailable().then((a) => {
      setOk(a);
      if (a) refresh();
    });
  }, []);
  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      if (done) onDone(done);
      else await refresh();
    } catch (e) {
      s.toast(`${label} did not work: ${(e as Error).message}`, "error");
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="shared-sec" aria-label="Shared plants">
      <h3>Shared plants · team database</h3>
      <p className="muted small">
        Everyone who can open this page works on the same plant at the same time, like SP3D&apos;s Model database: changes appear live for the others, approved objects stay locked, and two people changing the same object never overwrite each other.
      </p>
      {ok === undefined && <p className="muted">Checking…</p>}
      {ok === false && <p className="muted">{inClaude() ? "Sign in to Claude to work on shared plants." : "Shared plants work when this page is opened in Claude."}</p>}
      {ok && (
        <>
          <div className="proj-actions">
            {s.shared ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  leaveShared();
                  refresh();
                }}
              >
                Leave “{s.shared.name}”
              </button>
            ) : (
              <button type="button" id="share-plant" className="btn accent" disabled={!!busy} onClick={() => run("Sharing", () => shareCurrent(), `Shared “${s.doc.project.name}” with everyone who can open this page`)}>
                <Icon name="database" size={15} /> Share “{s.doc.project.name}”
              </button>
            )}
            {busy && <span className="muted">{busy}…</span>}
          </div>
          {list.length === 0 ? (
            <p className="muted">No shared plants yet.</p>
          ) : (
            <ul className="proj-list" id="shared-list">
              {list.map((p) => (
                <li key={p.id} className={s.shared?.plantId === p.id ? "on" : ""}>
                  <button type="button" className="proj-open" disabled={!!busy || s.shared?.plantId === p.id} onClick={() => run("Opening", () => joinShared(p.id), `Opened shared plant ${p.name}`)}>
                    <span className="mono">
                      {p.name}
                      {s.shared?.plantId === p.id ? " · open" : ""}
                    </span>
                    <span className="muted">
                      {p.objects} objects · shared by {personName(p.createdBy) || "someone"} · {new Date(p.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  {s.user.canApprove &&
                    (confirmId === p.id ? (
                      <span className="confirm">
                        <button
                          type="button"
                          className="btn small danger"
                          onClick={() => {
                            setConfirmId(null);
                            run("Deleting", () => deleteShared(p.id));
                          }}
                        >
                          Delete for everyone
                        </button>
                        <button type="button" className="btn small" onClick={() => setConfirmId(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="icon-btn" aria-label={`Delete ${p.name}`} onClick={() => setConfirmId(p.id)}>
                        <Icon name="trash" size={15} />
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
