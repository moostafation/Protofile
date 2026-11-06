"""Audits DXF files with ezdxf (the reference DXF library): every file must load without
structure errors and ezdxf's auditor must report zero errors. Fixes (repairs ezdxf would
make) are listed too and also fail the check, so files open cleanly in AutoCAD.
Usage: python3 tests/dxf_audit.py <files or folders...>. Exit code 2: ezdxf is not installed.
"""
import os
import sys

try:
    import ezdxf
    from ezdxf import recover
except ImportError:
    print('ezdxf is not installed (pip install ezdxf): DXF audit skipped')
    sys.exit(2)

files = []
for arg in sys.argv[1:]:
    if os.path.isdir(arg):
        files += sorted(os.path.join(arg, f) for f in os.listdir(arg) if f.lower().endswith('.dxf'))
    else:
        files.append(arg)

failed = 0
for path in files:
    name = os.path.basename(path)
    try:
        doc = ezdxf.readfile(path)
    except Exception as ex:  # structure errors
        failed += 1
        print('FAIL', name, 'does not load:', ex)
        continue
    auditor = doc.audit()
    _, rec = recover.readfile(path)
    problems = [f'error {e.code}: {e.message}' for e in auditor.errors]
    problems += [f'fix {e.code}: {e.message}' for e in auditor.fixes]
    problems += [f'recover: {e.message}' for e in rec.errors + rec.fixes]
    if doc.dxfversion != 'AC1027':
        problems.append(f'version {doc.dxfversion}, expected AC1027')
    if problems:
        failed += 1
        print('FAIL', name)
        for p in problems[:20]:
            print('    ', p)
    else:
        msp = doc.modelspace()
        print('  ok', name, f'{len(msp)} model space entities, {len(doc.blocks)} blocks, {len(doc.layouts) - 1} layouts, ezdxf audit clean')
print(f'{len(files) - failed} passed, {failed} failed (ezdxf {ezdxf.__version__})')
sys.exit(1 if failed else 0)
