import { useRef, useState } from "react";
import { INSTRUCTIONS, assistantTools, modelSummary } from "../assistant/assistant";
import type { PlantDoc } from "../engine/doc";
import { sampleFn } from "../platform/claude";
import { Icon } from "./icons";
import { useStore } from "./store";

interface Msg {
  role: "user" | "assistant";
  text: string;
  actions?: string[];
  snapshot?: PlantDoc;
  failed?: boolean;
}

const EXAMPLES = [
  "Add a standby pump P-102B next to P-101A and connect it to the drum and the discharge",
  "Move E-101 3 m east and fix any lines that break",
  "Check the model for clashes and fix what you can",
  "أضف تانك جديد T-102 جنب T-101 ووصّل مخرج المبادل عليه",
];

const ERRORS: Record<string, string> = {
  not_granted: "The assistant needs your permission to use Claude. Allow it when asked, or reopen the page.",
  sampling_disabled: "Claude is not available for this account.",
  rate_limited: "Too many requests right now. Try again in a minute.",
  tools_unavailable: "This view cannot let Claude operate the model.",
  session_expired: "Please sign in to Claude again.",
  refused: "Claude declined that request. Try rephrasing it.",
};

export function Assistant() {
  const s = useStore();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const scroll = () => setTimeout(() => list.current?.scrollTo({ top: list.current.scrollHeight }), 30);

  const send = async (text: string) => {
    const sample = await sampleFn();
    if (!sample || !text.trim() || busy) return;
    const snapshot = useStore.getState().doc;
    const actions: string[] = [];
    const history = msgs.slice(-6).map((m) => ({ role: m.role, content: m.text || "(no reply)" }));
    setMsgs((m) => [...m, { role: "user", text }, { role: "assistant", text: "", actions, snapshot }]);
    setInput("");
    setBusy(true);
    setStatus("Thinking…");
    scroll();
    ctl.current = new AbortController();
    const update = (patch: Partial<Msg>) =>
      setMsgs((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch, actions: [...actions] };
        return copy;
      });
    const tools = assistantTools((label) => {
      actions.push(label);
      setStatus(`Working: ${label}`);
      update({});
      scroll();
    });
    const turns = [
      { role: "user" as const, content: `${INSTRUCTIONS}\n\nCurrent model (summary):\n${JSON.stringify(modelSummary()).slice(0, 12000)}` },
      ...history,
      { role: "user" as const, content: text },
    ];
    try {
      const res = await sample(turns, {
        tools,
        signal: ctl.current.signal,
        onText: ({ text: t }: { text: string }) => {
          update({ text: t });
          scroll();
        },
      });
      update({ text: res.text });
    } catch (e) {
      const err = e as { code?: string; text?: string };
      if (err.code !== "cancelled") update({ text: err.text || ERRORS[err.code ?? ""] || "Something went wrong. Try again.", failed: true });
    } finally {
      setBusy(false);
      setStatus("");
      scroll();
    }
  };

  return (
    <aside className="assistant" aria-label="AI assistant">
      <div className="as-head">
        <div>
          <span className="eyebrow">Design assistant</span>
          <h2>Ask PlantForge AI</h2>
        </div>
        <button type="button" className="icon-btn" onClick={() => s.set({ assistantOpen: false })} aria-label="Close assistant">
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="as-list" ref={list}>
        {msgs.length === 0 && (
          <div className="as-intro">
            <p>Describe what you want built or checked. The assistant places equipment, routes lines with the auto-router, adds valves and runs clash checks. Every change lands in Undo.</p>
            <div className="as-examples">
              {EXAMPLES.map((e) => (
                <button key={e} type="button" className="chip-btn" onClick={() => send(e)} dir="auto">
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`as-msg ${m.role}${m.failed ? " failed" : ""}`} dir="auto">
            {m.text || (m.role === "assistant" && busy && i === msgs.length - 1 ? <span className="muted">{status}</span> : null)}
            {m.actions && m.actions.length > 0 && (
              <ul className="as-actions">
                {m.actions.map((a, k) => (
                  <li key={k}>
                    <Icon name="tick" size={12} /> {a}
                  </li>
                ))}
              </ul>
            )}
            {m.role === "assistant" && m.snapshot && m.actions && m.actions.length > 0 && !(busy && i === msgs.length - 1) && (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  useStore.getState().apply(m.snapshot!, "Undo assistant changes");
                  useStore.getState().toast("Assistant changes undone", "info");
                }}
              >
                <Icon name="undo" size={13} /> Undo these changes
              </button>
            )}
          </div>
        ))}
      </div>
      <form
        className="as-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          id="assistant-input"
          value={input}
          dir="auto"
          rows={2}
          placeholder="e.g. connect the tank outlet T-101/N1 to a new pump P-103"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {busy ? (
          <button type="button" className="btn" onClick={() => ctl.current?.abort()}>
            <Icon name="stop" size={15} /> Stop
          </button>
        ) : (
          <button type="submit" className="btn accent" disabled={!input.trim()}>
            <Icon name="send" size={15} /> Send
          </button>
        )}
      </form>
    </aside>
  );
}
