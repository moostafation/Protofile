"""Writes the small DGN V7 and HPGL test files in tests/fixtures/.

Usage: python3 tests/make_format_fixtures.py
The DGN design-file settings (TCB) are taken from GDAL's smalltest.dgn (MIT/X licence),
the elements are written here following the ISFF layout used by GDAL's dgnlib.
"""
import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, 'fixtures')
UOR = 10000  # UORs per master unit (10 per mm, 1000 mm per m)


def i32(v):
    v = int(round(v)) & 0xFFFFFFFF
    return struct.pack('<HH', v >> 16, v & 0xFFFF)


def vax(v):
    """IEEE double -> VAX D-float bytes."""
    if v == 0:
        return b'\0' * 8
    m, e = math.frexp(abs(v))  # v = m * 2**e, 0.5 <= m < 1
    f = int(round((m * 2 - 1) * 2 ** 55))
    hi = (0x80000000 if v < 0 else 0) | ((e + 128) << 23) | (f >> 32)
    lo = f & 0xFFFFFFFF
    return struct.pack('<HHHH', hi >> 16, hi & 0xFFFF, lo >> 16, lo & 0xFFFF)


def u(v):
    return round(v * UOR)


def rad50(s):
    chars = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$. 0123456789'
    s = (s.upper() + '      ')[:6]
    words = []
    for k in (0, 3):
        a, b, c = (chars.index(ch) for ch in s[k:k + 3])
        words.append(a * 1600 + b * 40 + c)
    return struct.pack('<HH', *words)


class Writer:
    def __init__(self, dim):
        self.dim = dim
        self.out = bytearray()

    def elem(self, etype, level, data, color=0, weight=0, style=0, complex=False, deleted=False, attrs=b''):
        body = bytearray(data)
        if len(body) % 2:
            body += b'\0'
        size = 36 + len(body) + len(attrs)
        hdr = bytearray(36)
        hdr[0] = level | (0x80 if complex else 0)
        hdr[1] = etype | (0x80 if deleted else 0)
        struct.pack_into('<H', hdr, 2, (size - 4) // 2)
        struct.pack_into('<H', hdr, 30, (36 + len(body) - 32) // 2)
        hdr[34] = style | (weight << 3)
        hdr[35] = color
        self.out += hdr + body + attrs
        return size

    def pts(self, points):
        out = bytearray()
        for p in points:
            out += i32(u(p[0])) + i32(u(p[1]))
            if self.dim == 3:
                out += i32(u(p[2] if len(p) > 2 else 0))
        return out

    def line(self, level, a, b, **kw):
        return self.elem(3, level, self.pts([a, b]), **kw)

    def linestring(self, level, points, etype=4, **kw):
        return self.elem(etype, level, struct.pack('<H', len(points)) + self.pts(points), **kw)

    def quat_z(self, deg):
        # Same convention as GDAL's DGNRotationToQuaternion.
        r = math.radians(deg)
        return i32(math.cos(-r / 2) * 2147483647) + i32(0) + i32(0) + i32(math.sin(-r / 2) * 2147483647)

    def quat_x(self, deg):
        r = math.radians(deg)
        return i32(math.cos(-r / 2) * 2147483647) + i32(math.sin(-r / 2) * 2147483647) + i32(0) + i32(0)

    def arc(self, level, c, a, b, rot, start, sweep, quat=None, **kw):
        sw = round(abs(sweep) * 360000)
        sweep_bytes = bytearray(i32(sw))
        if sweep < 0:
            sweep_bytes[1] |= 0x80
        data = i32(start * 360000) + bytes(sweep_bytes) + vax(a * UOR) + vax(b * UOR)
        if self.dim == 2:
            data += i32(rot * 360000) + vax(c[0] * UOR) + vax(c[1] * UOR)
        else:
            data += (quat or self.quat_z(rot)) + vax(c[0] * UOR) + vax(c[1] * UOR) + vax((c[2] if len(c) > 2 else 0) * UOR)
        return self.elem(16, level, data, **kw)

    def ellipse(self, level, c, a, b, rot, quat=None, **kw):
        data = vax(a * UOR) + vax(b * UOR)
        if self.dim == 2:
            data += i32(rot * 360000) + vax(c[0] * UOR) + vax(c[1] * UOR)
        else:
            data += (quat or self.quat_z(rot)) + vax(c[0] * UOR) + vax(c[1] * UOR) + vax((c[2] if len(c) > 2 else 0) * UOR)
        return self.elem(15, level, data, **kw)

    def text(self, level, p, s, height, rot=0, font=1, **kw):
        mult = i32(height * UOR * 1000 / 6)
        raw = s.encode('latin-1')
        if self.dim == 2:
            data = bytes([font, 2]) + mult + mult + i32(rot * 360000) + i32(u(p[0])) + i32(u(p[1])) + bytes([len(raw), 0]) + raw
        else:
            data = bytes([font, 2]) + mult + mult + self.quat_z(rot) + i32(u(p[0])) + i32(u(p[1])) + i32(u(p[2] if len(p) > 2 else 0)) + bytes([len(raw), 0]) + raw
        return self.elem(17, level, data, **kw)

    def complex_header(self, etype, level, members, total_words, **kw):
        return self.elem(etype, level, struct.pack('<HH', total_words, members), **kw)

    def cell(self, level, name, origin, body_words, **kw):
        pad = 4 if self.dim == 2 else 6
        trans = i32(214748 * 10000) + i32(0) + i32(0) + i32(214748 * 10000) if self.dim == 2 else b''.join(i32(214748 * 10000 if k in (0, 4, 8) else 0) for k in range(9))
        data = struct.pack('<H', body_words) + rad50(name) + struct.pack('<H', 0) + b'\0' * 8 + b'\0' * (pad * 4) + trans + self.pts([origin])
        return self.elem(2, level, data, **kw)


def fill_linkage(color):
    # User data linkage 0x0041 (shape fill): 8 words, colour in byte 8.
    return struct.pack('<HHHH', 0x1007, 0x0041, 0x0802, 0x0001) + bytes([color, 0]) + b'\0' * 6


def seed(dim):
    with open(os.path.join(FIX, 'smalltest.dgn'), 'rb') as f:
        tcb = bytearray(f.read()[:1536])
    tcb[0] = 0xC8 if dim == 3 else 0x08
    struct.pack_into('<HH', tcb, 1112, 0, 10)      # 10 UOR per mm
    struct.pack_into('<HH', tcb, 1116, 0, 1000)    # 1000 mm per m
    tcb[1120:1124] = b'm mm'
    if dim == 3:
        tcb[1214] |= 0x40
    else:
        tcb[1214] &= ~0x40 & 0xFF
    return tcb


def color_table():
    data = bytearray(struct.pack('<H', 0)) + bytes([0, 0, 0])
    pal = [(255, 255, 255)] * 255
    pal[1] = (255, 140, 0)      # orange
    pal[2] = (0, 200, 255)      # sky blue
    pal[3] = (120, 220, 80)     # green
    for c in pal:
        data += bytes(c)
    return data


def make_2d():
    w = Writer(2)
    w.out += seed(2)
    w.elem(5, 1, color_table())
    # Room outline and pipes.
    w.linestring(1, [(0, 0), (12, 0), (12, 8), (0, 8)], etype=6, color=3, weight=2)
    w.line(10, (1, 2), (11, 2), color=2, weight=4)
    w.line(10, (1, 6), (11, 6), color=2, weight=4, style=2)
    w.line(10, (1, 3), (3, 3), color=1, deleted=True)
    w.linestring(11, [(1, 1), (5, 1), (5, 4)], color=1)
    # Arcs, circles, ellipses.
    w.arc(20, (6, 4), 1.0, 1.0, 0, 0, 90, color=1)
    w.arc(20, (9, 4), 1.2, 0.6, 30, 0, 180, color=1)
    w.arc(20, (3, 6), 0.5, 1.0, 0, 90, -180, color=1)
    w.ellipse(21, (9, 6.5), 1.0, 1.0, 0, color=2)
    w.ellipse(21, (3.5, 4.5), 0.9, 0.4, 45, color=2, attrs=fill_linkage(3))
    # Curve: first/last two vertices only set the tangents.
    w.linestring(22, [(6, 7.5), (6.5, 7.0), (7, 6.5), (8, 7.2), (9, 6.8), (10, 7.4), (10.5, 7.6), (11, 7.8)], etype=11, color=3)
    # Complex chain: line + arc + line.
    start = len(w.out)
    hdr = len(w.out)
    w.complex_header(12, 23, 3, 0, color=1)
    m1 = w.line(23, (1, 7.4), (2, 7.4), complex=True, color=1)
    m2 = w.arc(23, (2, 7.0), 0.4, 0.4, 0, 90, -90, complex=True, color=1)
    m3 = w.linestring(23, [(2.4, 7.0), (2.4, 6.5), (3.0, 6.5)], complex=True, color=1)
    struct.pack_into('<H', w.out, hdr + 36, 1 + (m1 + m2 + m3) // 2)
    # Filled complex shape.
    hdr = len(w.out)
    w.complex_header(14, 24, 2, 0, color=2, attrs=fill_linkage(2))
    m1 = w.linestring(24, [(7, 0.5), (9, 0.5), (9, 1.5)], complex=True, color=2)
    m2 = w.linestring(24, [(9, 1.5), (7, 1.5), (7, 0.5)], complex=True, color=2)
    struct.pack_into("<H", w.out, hdr + 36, 1 + 8 + (m1 + m2) // 2)
    # Two VALVE cells and one PUMP cell (members already in design coordinates).
    for x in (4.0, 8.0):
        hdr = len(w.out)
        w.cell(30, 'VALVE', (x, 2), 0, color=4)
        a = w.linestring(30, [(x - 0.3, 1.8), (x + 0.3, 2.2), (x + 0.3, 1.8), (x - 0.3, 2.2)], etype=6, complex=True, color=4)
        b = w.line(30, (x, 2), (x, 2.5), complex=True, color=4)
        struct.pack_into('<H', w.out, hdr + 36, 27 + (a + b) // 2)
    hdr = len(w.out)
    w.cell(31, 'PUMP', (10.5, 4.5), 0, color=5)
    a = w.ellipse(31, (10.5, 4.5), 0.5, 0.5, 0, complex=True, color=5)
    b = w.text(31, (10.2, 4.3), 'P-1', 0.3, complex=True, color=5)
    struct.pack_into('<H', w.out, hdr + 36, 27 + (a + b) // 2)
    # Text node with two lines and a rotated label.
    hdr = len(w.out)
    w.elem(7, 40, struct.pack('<HHHBBBB', 0, 2, 1, 32, 10, 1, 2) + i32(0) + i32(0.25 * UOR * 1000 / 6) * 2 + i32(0) + i32(u(0.5)) + i32(u(9.0)))
    w.text(40, (0.5, 9.0), 'PLANT ROOM', 0.4, complex=True, color=0)
    w.text(40, (0.5, 8.4), 'CHW PUMPS', 0.25, complex=True, color=0)
    w.text(41, (6.5, 2.4), 'CHWS 150', 0.2, rot=30, color=2)
    # A point (zero-length line) and an unsupported dimension element.
    w.line(42, (11.5, 0.5), (11.5, 0.5), color=7)
    w.elem(33, 43, b'\0' * 20)
    w.out += b'\xff\xff'
    return bytes(w.out)


def make_3d():
    w = Writer(3)
    w.out += seed(3)
    w.line(1, (0, 0, 0), (10, 0, 3), color=2)
    w.linestring(1, [(0, 0, 0), (0, 6, 0), (10, 6, 2), (10, 0, 3)], color=2)
    w.arc(2, (5, 3, 1), 2.0, 2.0, 30, 0, 120, color=3)
    w.ellipse(2, (5, 3, 1), 1.5, 0.75, 30, color=1)
    w.ellipse(3, (2, 3, 0), 1.0, 1.0, 0, quat=w.quat_x(60), color=4)
    w.text(4, (1, 5, 0), 'TANK T-101', 0.4, rot=15, color=5)
    hdr = len(w.out)
    w.cell(5, 'NOZZLE', (8, 3, 0), 0, color=6)
    a = w.ellipse(5, (8, 3, 0), 0.4, 0.4, 0, complex=True, color=6)
    b = w.line(5, (7.6, 3, 0), (8.4, 3, 0), complex=True, color=6)
    struct.pack_into('<H', w.out, hdr + 36, 43 + (a + b) // 2)
    w.out += b'\xff\xff'
    return bytes(w.out)


def hpgl_plain():
    # HP-GL/1 style: semicolons, comma separators, absolute and relative moves, circles, arcs, labels.
    cmds = [
        'IN;', 'SP1;', 'PU0,0;', 'PD8000,0,8000,6000,0,6000,0,0;',
        'PU1000,1000;', 'PD3000,1000,3000,2500;', 'SP2;', 'PW0.5,2;',
        'PU5000,3000;', 'CI800;', 'PU4000,3000;', 'PD;', 'AA5000,3000,-90;', 'PU;',
        'PR;', 'PU200,200;', 'PD1000,0,0,500,-1000,0;', 'PA;',
        'SP3;', 'LT2,4;', 'PU1000,5000;', 'PD7000,5000;', 'LT;',
        'SP1;', 'SI0.4,0.6;', 'DI1,0;', 'PU1000,5500;', 'LBPLANT ROOM HPGL\x03',
        'DI0,1;', 'PU7500,1000;', 'LBRISER\x03',
        'SP0;',
    ]
    return ''.join(cmds).encode('ascii')


def hpgl2_pcl():
    # HP-GL/2 inside a PCL job: ESC E, ESC%-1B (enter HP-GL/2), space separators,
    # polyline encoded (PE), a custom label terminator and pen colours.
    def enc(v, base64=True):
        v = 2 * v if v >= 0 else 2 * -v + 1
        out = []
        while True:
            d = v % 64 if base64 else v % 32
            v //= 64 if base64 else 32
            if v == 0:
                out.append(chr(191 + d) if base64 else chr(95 + d))
                break
            out.append(chr(63 + d))
        return ''.join(out)

    pe = 'PE' + '<' + '=' + enc(2000) + enc(2000) + enc(4000) + enc(0) + enc(0) + enc(2000) + enc(-4000) + enc(0) + enc(0) + enc(-2000) + ';'
    body = ('BP;IN;NP8;PC2 255 0 0;PC3 0 160 255;SP2;PW 0.35;'
            'PU 0 0;PD 6000 0 6000 4000 0 4000 0 0;'
            'SP3;' + pe +
            'SP2;PU 4500 2000;CI 500;PU 1000 3000;PD;AR 0 500 180;PU;'
            'DT*,1;SI 0.3 0.45;PU 2200 3400;LBHPGL2 PCL*'
            'RO 0;PG;')
    return b'\x1bE\x1b%-12345X@PJL ENTER LANGUAGE=PCL\r\n\x1bE\x1b&l1O\x1b%-1B' + body.encode('latin-1') + b'\x1b%0A\x1bE\x1b%-12345X'


if __name__ == '__main__':
    os.makedirs(FIX, exist_ok=True)
    with open(os.path.join(FIX, 'plant-v7.dgn'), 'wb') as f:
        f.write(make_2d())
    with open(os.path.join(FIX, 'test3d-v7.dgn'), 'wb') as f:
        f.write(make_3d())
    with open(os.path.join(FIX, 'plot-hpgl1.plt'), 'wb') as f:
        f.write(hpgl_plain())
    with open(os.path.join(FIX, 'plot-hpgl2-pcl.plt'), 'wb') as f:
        f.write(hpgl2_pcl())
    print('fixtures written to', FIX)
