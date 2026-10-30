// Decoding of AutoCAD text strings: %% control codes, \U+ escapes and MTEXT formatting.

const SPECIAL = { c: '⌀', d: '°', p: '±', '%': '%' };

function unicodeEscapes(s) {
  return s
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+[0-9a-fA-F]([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Single-line TEXT / ATTRIB value. */
export function decodeText(s) {
  if (!s) return '';
  return unicodeEscapes(s).replace(/%%(\d{3}|[cdpCDP%]|[uoUO])/g, (m, code) => {
    if (/^\d{3}$/.test(code)) return String.fromCharCode(parseInt(code, 10));
    const k = code.toLowerCase();
    if (k === 'u' || k === 'o') return '';
    return SPECIAL[k] ?? m;
  });
}

/** MTEXT content -> array of plain text lines (paragraph breaks preserved). */
export function decodeMText(s) {
  if (!s) return [''];
  s = unicodeEscapes(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const c = s[i + 1];
    if (c === undefined) break;
    switch (c) {
      case 'P': case 'n': out += '\n'; i++; break;
      case '~': out += ' '; i++; break;
      case '\\': case '{': case '}': out += c; i++; break;
      case 'L': case 'l': case 'O': case 'o': case 'K': case 'k': i++; break;
      case 'S': {
        // Stacked text \Snum^den; or \Snum/den; or \Snum#den;
        const end = s.indexOf(';', i + 2);
        const body = end < 0 ? s.slice(i + 2) : s.slice(i + 2, end);
        out += body.replace(/\^/, '/').replace(/#/, '/').replace(/\\/g, '');
        i = end < 0 ? s.length : end;
        break;
      }
      case 'f': case 'F': case 'H': case 'h': case 'W': case 'w': case 'Q': case 'q':
      case 'T': case 't': case 'A': case 'a': case 'C': case 'c': case 'p': case 'X': {
        const end = s.indexOf(';', i + 2);
        i = end < 0 ? s.length : end;
        break;
      }
      default:
        out += c;
        i++;
    }
  }
  return decodeText(out).replace(/\^I/g, '\t').replace(/\^J/g, '\n').split('\n');
}
