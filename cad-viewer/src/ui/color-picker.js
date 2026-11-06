// Colour picker popover: ByLayer / ByBlock, the AutoCAD Color Index palette (1-255, laid out
// like AutoCAD's index colour dialog) and a true colour. Calls onPick({ colorIndex, color }),
// where color is 0xRRGGBB for true colours and undefined otherwise.
import { ACI } from '../cad/aci.js';

const hex = (rgb) => '#' + rgb.toString(16).padStart(6, '0');
let open = null;

export function closeColorPicker() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener('pointerdown', open.outside, true);
  document.removeEventListener('keydown', open.esc, true);
  open = null;
}

/**
 * @param anchor element the popover opens next to
 * @param opts { value: { colorIndex, color }, allowBy: boolean (offer ByLayer/ByBlock), title, onPick }
 */
export function openColorPicker(anchor, { value = {}, allowBy = true, title = 'Color', onPick }) {
  closeColorPicker();
  const el = document.createElement('div');
  el.className = 'menu color-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  const cur = typeof value.color === 'number' ? null : value.colorIndex;
  const cell = (i) => `<button type="button" class="aci${cur === i ? ' cur' : ''}" data-aci="${i}" title="ACI ${i}" style="background:${hex(ACI[i])}"></button>`;
  let grid = '';
  // 24 hues (columns) x 10 shades (rows): index = 10 + hue * 10 + shade.
  for (let shade = 0; shade < 10; shade++) {
    for (let hue = 0; hue < 24; hue++) grid += cell(10 + hue * 10 + shade);
  }
  const basic = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(cell).join('');
  const greys = [250, 251, 252, 253, 254, 255].map(cell).join('');
  const trueVal = typeof value.color === 'number' ? hex(value.color) : hex(ACI[value.colorIndex] ?? 0xffffff);
  el.innerHTML = `
    <div class="cp-head">${title}</div>
    ${allowBy ? `<div class="cp-by"><button type="button" class="mini${cur === 256 ? ' cur' : ''}" data-aci="256">ByLayer</button><button type="button" class="mini${cur === 0 ? ' cur' : ''}" data-aci="0">ByBlock</button></div>` : ''}
    <div class="cp-grid">${grid}</div>
    <div class="cp-row">${basic}<span class="cp-gap"></span>${greys}</div>
    <label class="cp-true">True color <input type="color" value="${trueVal}" /><button type="button" class="mini" data-true>Apply</button></label>`;
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + h + 8 < window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-aci]');
    if (b) { const ci = +b.dataset.aci; closeColorPicker(); onPick({ colorIndex: ci, color: undefined }); return; }
    if (ev.target.closest('[data-true]')) {
      const v = parseInt(el.querySelector('input[type=color]').value.slice(1), 16);
      closeColorPicker();
      onPick({ colorIndex: 256, color: v });
    }
  });
  const outside = (ev) => { if (!el.contains(ev.target) && ev.target !== anchor) closeColorPicker(); };
  const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); closeColorPicker(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', esc, true);
  open = { el, outside, esc };
  el.querySelector('.cur')?.focus();
}

/** Human-readable colour of an entity: ByLayer, ByBlock, ACI n or RGB r,g,b. */
export function colorLabel(e) {
  if (typeof e.color === 'number' && e.color >= 0) return `RGB ${(e.color >> 16) & 255},${(e.color >> 8) & 255},${e.color & 255}`;
  const ci = e.colorIndex ?? 256;
  return ci === 256 ? 'ByLayer' : ci === 0 ? 'ByBlock' : `ACI ${Math.abs(ci)}`;
}
