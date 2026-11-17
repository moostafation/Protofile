// AutoCAD-style command window, docked above the status bar: a few lines of history (scrollable,
// resizable, collapsible; F2 expands it), the prompt with clickable [options], and the input with
// command autocomplete. Up/Down recall earlier input; Enter or Space submits (an empty input repeats
// the last command, which the app decides). The app supplies the behaviour through `opts`:
//   submit(text)          run the input (a command, or the answer to the active prompt)
//   cancel()              Esc on an empty input
//   suggest(text)         autocomplete entries [{ name, alias, desc }] (only when no command waits)
//   waiting()             a command is waiting for input (no autocomplete, Space is literal in text)
//   textInput()           the active prompt takes free text (Space does not submit)
//   onLayout(px)          height the docked window takes from the drawing area changed
import { promptParts } from '../tools/cmdline.js';

const MAX_LINES = 500;
const MAX_RECALL = 100;
const KEY = 'protocad.cmdwin';

export class CommandWindow {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.hist = root.querySelector('#cmdHist');
    this.promptEl = root.querySelector('#cmdPrompt');
    this.input = root.querySelector('#cmdInput');
    this.list = root.querySelector('#cmdSuggest');
    this.toggleBtn = root.querySelector('#cmdToggle');
    this.grip = root.querySelector('#cmdGrip');
    this.prompt = '';
    this.answered = true;
    this.recall = [];
    this.recallAt = -1;
    this.items = [];
    this.active = -1;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* storage unavailable */ }
    this.lines = Math.min(12, Math.max(1, saved.lines || 3));
    this.collapsed = saved.collapsed ?? window.innerWidth <= 860;
    this.expanded = false;
    this.docked = -1;
    this.bind();
    new ResizeObserver(() => this.layout()).observe(root);
    this.applySize();
  }

  get small() { return window.innerWidth <= 860; }
  /** History lines are on screen (messages need no toast). */
  get showsHistory() { return !this.root.hidden && !this.collapsed; }

  // ---------------------------------------------------------------- history
  /** Adds a line to the history. kind: 'echo' (prompt + answer), 'msg', 'result', 'error'. */
  log(text, kind = 'msg') {
    for (const line of String(text).split('\n')) {
      const div = document.createElement('div');
      div.className = `cmd-l ${kind}`;
      div.textContent = line;
      this.hist.append(div);
    }
    while (this.hist.childElementCount > MAX_LINES) this.hist.firstElementChild.remove();
    this.hist.scrollTop = this.hist.scrollHeight;
    // Collapsed: the latest message still shows briefly in place of the prompt's tooltip.
    if (kind === 'error' || kind === 'result') this.root.classList.add('flash');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.root.classList.remove('flash'), 1200);
  }

  /** The answer typed to the current prompt goes into the history next to it. */
  echo(answer) {
    this.log(`${this.prompt || 'Command:'} ${answer}`.trimEnd(), 'echo');
    this.answered = true;
  }

  // ---------------------------------------------------------------- prompt
  setPrompt(text) {
    if (text === this.prompt) return;
    // A prompt answered by a click (not typed) still goes into the history, like AutoCAD.
    if (this.prompt && !this.answered && this.prompt !== 'Command:') this.log(this.prompt, 'echo');
    this.prompt = text;
    this.answered = false;
    this.root.classList.remove('bad');
    this.promptEl.replaceChildren();
    for (const part of promptParts(text)) {
      if (part.key) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cmd-opt';
        b.textContent = part.text;
        b.title = part.key;
        b.dataset.key = part.key;
        this.promptEl.append(b);
      } else this.promptEl.append(part.text);
    }
    this.updateSuggest();
  }

  // ---------------------------------------------------------------- layout
  applySize() {
    const rows = this.collapsed ? 0 : this.lines;
    this.root.style.setProperty('--cmd-rows', rows);
    this.root.classList.toggle('collapsed', this.collapsed);
    this.root.classList.toggle('expanded', this.expanded);
    this.toggleBtn.setAttribute('aria-expanded', String(!this.collapsed));
    this.hist.scrollTop = this.hist.scrollHeight;
    this.layout();
    try { localStorage.setItem(KEY, JSON.stringify({ lines: this.lines, collapsed: this.collapsed })); } catch { /* storage unavailable */ }
  }

  /** Reports the height the window takes from the drawing area (the F2 history floats over it). */
  layout() {
    const h = this.root.hidden ? 0 : this.root.offsetHeight;
    if (h !== this.docked) { this.docked = h; this.opts.onLayout?.(h); }
  }

  setVisible(on) {
    if (this.root.hidden === !on) return;
    this.root.hidden = !on;
    if (!on) this.closeSuggest();
    this.applySize();
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this.expanded = false;
    this.applySize();
  }

  /** F2: a tall history over the drawing (the drawing area does not change size). */
  toggleExpanded() {
    this.expanded = !this.expanded;
    if (this.expanded && this.collapsed) { this.collapsed = false; this.expandedFromCollapsed = true; }
    else if (!this.expanded && this.expandedFromCollapsed) { this.collapsed = true; this.expandedFromCollapsed = false; }
    this.applySize();
  }

  // ---------------------------------------------------------------- autocomplete
  updateSuggest() {
    const text = this.input.value;
    this.items = this.opts.waiting() ? [] : this.opts.suggest(text);
    this.active = -1;
    if (!this.items.length || document.activeElement !== this.input) { this.closeSuggest(); return; }
    this.list.replaceChildren(...this.items.map((it, i) => {
      const li = document.createElement('li');
      li.dataset.i = i;
      li.innerHTML = '<b></b><span class="cmd-alias"></span><span class="cmd-desc"></span>';
      li.children[0].textContent = it.name;
      li.children[1].textContent = it.alias ? `(${it.alias})` : '';
      li.children[2].textContent = it.desc;
      return li;
    }));
    this.list.hidden = false;
  }

  closeSuggest() {
    this.list.hidden = true;
    this.items = [];
    this.active = -1;
  }

  highlight(i) {
    this.active = i;
    [...this.list.children].forEach((li, k) => li.classList.toggle('active', k === i));
    this.list.children[i]?.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- input
  submit(text) {
    this.closeSuggest();
    const t = text.trim();
    if (t && this.recall.at(-1) !== text) { this.recall.push(text); if (this.recall.length > MAX_RECALL) this.recall.shift(); }
    this.recallAt = -1;
    this.opts.submit(text);
  }

  /** Puts typed characters into the input (keys pressed while the drawing has the focus). */
  type(ch) {
    this.input.value += ch;
    this.input.focus();
    this.updateSuggest();
  }

  bind() {
    const input = this.input;
    input.addEventListener('keydown', (ev) => {
      const open = !this.list.hidden && this.items.length;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const down = ev.key === 'ArrowDown';
        if (open) { const n = this.items.length; this.highlight(down ? (this.active + 1) % n : this.active <= 0 ? n - 1 : this.active - 1); return; }
        if (!this.recall.length) return;
        if (this.recallAt < 0) this.recallAt = this.recall.length;
        this.recallAt = Math.max(0, Math.min(this.recall.length, this.recallAt + (down ? 1 : -1)));
        input.value = this.recall[this.recallAt] ?? '';
        return;
      }
      if (ev.key === 'Tab' && open) {
        ev.preventDefault();
        input.value = this.items[Math.max(0, this.active)].name;
        this.updateSuggest();
        return;
      }
      if (ev.key === 'Enter' || (ev.key === ' ' && !this.opts.textInput())) {
        ev.preventDefault();
        const pick = open && this.active >= 0 ? this.items[this.active].name : null;
        this.submit(pick ?? input.value);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (open) { this.closeSuggest(); return; }
        if (input.value) { input.value = ''; this.opts.changed?.(); return; }
        input.blur();
        this.opts.cancel();
        return;
      }
      if (ev.key === 'F2') { ev.preventDefault(); this.toggleExpanded(); }
    });
    input.addEventListener('input', () => {
      this.root.classList.remove('bad');
      this.recallAt = -1;
      this.updateSuggest();
      this.opts.changed?.();
    });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) this.closeSuggest(); }, 120));
    input.addEventListener('focus', () => this.updateSuggest());
    this.list.addEventListener('pointerdown', (ev) => {
      const li = ev.target.closest('li');
      if (!li) return;
      ev.preventDefault();
      this.submit(this.items[+li.dataset.i].name);
    });
    // [Options] in the prompt answer it with their key letters.
    this.promptEl.addEventListener('click', (ev) => {
      const b = ev.target.closest('.cmd-opt');
      if (!b) return;
      ev.preventDefault();
      input.value = '';
      this.submit(b.dataset.key);
    });
    this.toggleBtn.addEventListener('click', () => this.toggleCollapsed());
    this.hist.addEventListener('dblclick', () => this.toggleExpanded());
    // Drag the top edge to show more or fewer history lines.
    this.grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      this.grip.setPointerCapture(ev.pointerId);
      const y0 = ev.clientY, l0 = this.collapsed ? 0 : this.lines;
      const move = (e) => {
        const n = Math.round(l0 + (y0 - e.clientY) / 18);
        const collapsed = n < 1;
        const lines = Math.min(12, Math.max(1, n));
        if (collapsed !== this.collapsed || (!collapsed && lines !== this.lines)) {
          this.collapsed = collapsed;
          if (!collapsed) this.lines = lines;
          this.expanded = false;
          this.applySize();
        }
      };
      const up = () => { this.grip.removeEventListener('pointermove', move); this.grip.removeEventListener('pointerup', up); this.grip.removeEventListener('pointercancel', up); };
      this.grip.addEventListener('pointermove', move);
      this.grip.addEventListener('pointerup', up);
      this.grip.addEventListener('pointercancel', up);
    });
  }
}
