// `npm run test:dxf`: writes every test drawing as DXF (tests/dxf-writer.test.mjs, which also
// round-trips them through our parser) and audits the files with Python's ezdxf. Skips the
// audit, without failing, when Python or ezdxf is not installed.
// DXF_SAMPLES=<folder> adds the .dwg/.dxf files of that folder (e.g. example_*.dwg).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'protocad-dxf-'));
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' });
let code = run(process.execPath, [path.join(here, 'dxf-writer.test.mjs'), '--out', out, ...process.argv.slice(2)]).status;
if (code === 0) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = run(py, [path.join(here, 'dxf_audit.py'), out]);
  if (r.error || r.status === 2) console.log('DXF audit skipped: Python 3 with ezdxf is needed (pip install ezdxf).');
  else code = r.status;
}
fs.rmSync(out, { recursive: true, force: true });
process.exit(code ?? 1);
