import ezdxf, math, sys
from ezdxf.enums import TextEntityAlignment
doc = ezdxf.new('R2018', setup=True)
doc.header['$INSUNITS'] = 4
doc.header['$DIMASZ'] = 200
DIM = {'dimlfac': 1, 'dimtxt': 250, 'dimasz': 200, 'dimexe': 120, 'dimexo': 120, 'dimgap': 60}
msp = doc.modelspace()
for name, color, lt in [('A-WALL', 7, 'Continuous'), ('P-PIPE-CHW', 4, 'Continuous'), ('P-PIPE-HW', 1, 'DASHED'), ('P-VALVE', 2, 'Continuous'), ('TEXT', 3, 'Continuous'), ('DIM', 8, 'Continuous'), ('HATCH', 9, 'Continuous'), ('EQUIP', 6, 'Continuous')]:
    doc.layers.add(name, color=color, linetype=lt)
# walls
msp.add_lwpolyline([(0,0),(20000,0),(20000,12000),(0,12000)], close=True, dxfattribs={'layer':'A-WALL','const_width':200})
msp.add_lwpolyline([(10000,0),(10000,5000),(10000,6000,),(10000,12000)], dxfattribs={'layer':'A-WALL'})
# pipes with bulge
msp.add_lwpolyline([(1000,2000,0,0,0),(8000,2000,0,0,0.414),(9000,3000,0,0,0),(9000,10000,0,0,0)], format='xyseb', dxfattribs={'layer':'P-PIPE-CHW'})
msp.add_lwpolyline([(1000,2500),(8000,2500),(8500,3000),(8500,10000)], dxfattribs={'layer':'P-PIPE-HW', 'linetype':'BYLAYER'})
msp.add_line((11000,2000),(19000,2000), dxfattribs={'layer':'P-PIPE-CHW'})
msp.add_line((11000,2500),(19000,2500), dxfattribs={'layer':'P-PIPE-HW'})
# valve block
valve = doc.blocks.new('GATE_VALVE', base_point=(0,0))
valve.add_lwpolyline([(-150,-100),(150,100),(150,-100),(-150,100)], close=True)
valve.add_line((0,0),(0,200))
valve.add_line((-80,200),(80,200))
valve.add_attdef('TAG', (0,-250), dxfattribs={'height':80}).set_placement((0,-250), align=TextEntityAlignment.MIDDLE_CENTER)
valve.add_attdef('SIZE', (0,-370), dxfattribs={'height':60}).set_placement((0,-370), align=TextEntityAlignment.MIDDLE_CENTER)
for i,(x,y) in enumerate([(3000,2000),(6000,2000),(9000,6000),(13000,2000),(16000,2000),(3000,2500),(14000,2500)]):
    ref = msp.add_blockref('GATE_VALVE', (x,y), dxfattribs={'layer':'P-VALVE','rotation': 90 if x==9000 else 0})
    ref.add_auto_attribs({'TAG': f'V-{101+i}', 'SIZE': 'DN100' if y==2000 else 'DN80'})
# pump block
pump = doc.blocks.new('PUMP', base_point=(0,0))
pump.add_circle((0,0), 400)
pump.add_lwpolyline([(0,400),(600,400),(600,250)])
pump.add_text('P', dxfattribs={'height':300}).set_placement((0,0), align=TextEntityAlignment.MIDDLE_CENTER)
msp.add_blockref('PUMP', (1000,6000), dxfattribs={'layer':'EQUIP'})
msp.add_blockref('PUMP', (1000,8500), dxfattribs={'layer':'EQUIP', 'xscale':-1})
msp.add_text('CHW PUMP P-101', dxfattribs={'layer':'TEXT','height':200}).set_placement((1600,6000), align=TextEntityAlignment.LEFT)
msp.add_text('HW PUMP P-102', dxfattribs={'layer':'TEXT','height':200, 'rotation': 15}).set_placement((1600,8500))
msp.add_mtext('GENERAL NOTES:\\P1. ALL PIPES ARE \\fArial|b1;SCH 40\\fArial|b0; STEEL.\\P2. INSULATE CHW PIPES 25 mm.\\P3. %%c100 MAIN HEADER', dxfattribs={'layer':'TEXT','char_height':180, 'width':5000, 'insert':(11000,11000), 'attachment_point':1})
# equipment: chiller with hatch
msp.add_lwpolyline([(12000,5000),(18000,5000),(18000,9000),(12000,9000)], close=True, dxfattribs={'layer':'EQUIP'})
h = msp.add_hatch(color=256, dxfattribs={'layer':'HATCH'})
h.set_pattern_fill('ANSI31', scale=200)
h.paths.add_polyline_path([(12000,5000),(18000,5000),(18000,9000),(12000,9000)], is_closed=True)
h2 = msp.add_hatch(color=5, dxfattribs={'layer':'HATCH'})
ep = h2.paths.add_edge_path()
ep.add_line((14000,6000),(16000,6000)); ep.add_arc((16000,7000),1000, -90, 90); ep.add_line((16000,8000),(14000,8000)); ep.add_arc((14000,7000),1000,90,270)
msp.add_text('غرفة المضخات - الدور الأرضي', dxfattribs={'layer':'TEXT','height':300}).set_placement((10000,-3200), align=TextEntityAlignment.MIDDLE_CENTER)
msp.add_text('CHILLER CH-1', dxfattribs={'layer':'TEXT','height':250}).set_placement((15000,9300), align=TextEntityAlignment.BOTTOM_CENTER)
msp.add_circle((5000,9000), 700, dxfattribs={'layer':'EQUIP'})
msp.add_arc((5000,9000), 1000, 0, 120, dxfattribs={'layer':'EQUIP'})
msp.add_ellipse((7000,9000), major_axis=(800,300), ratio=0.4, dxfattribs={'layer':'EQUIP'})
msp.add_spline([(2000,11000),(3000,11500),(4000,10500),(5000,11200),(6000,11000)], dxfattribs={'layer':'EQUIP'})
s = msp.add_solid([(19000,10000),(19500,10000),(19000,10500),(19500,10500)], dxfattribs={'layer':'HATCH','color':1})
# dimensions
d = msp.add_linear_dim(base=(0,-1500), p1=(0,0), p2=(20000,0), dimstyle='EZDXF', override=DIM, dxfattribs={'layer':'DIM'}); d.render()
d = msp.add_linear_dim(base=(21500,0), p1=(20000,0), p2=(20000,12000), angle=90, dimstyle='EZDXF', override=DIM, dxfattribs={'layer':'DIM'}); d.render()
d = msp.add_radius_dim(center=(5000,9000), radius=700, angle=45, dimstyle='EZ_RADIUS', override=DIM, dxfattribs={'layer':'DIM'}); d.render()
msp.add_leader([(9000,6000),(10500,7500),(11500,7500)], dxfattribs={'layer':'DIM'})
# layout with viewport
lay = doc.layouts.get('Layout1')
lay.page_setup(size=(420,297), margins=(10,10,10,10), units='mm')
lay.add_viewport(center=(200,150), size=(380,250), view_center_point=(10000,6000), view_height=16000)
lay.add_lwpolyline([(5,5),(415,5),(415,292),(5,292)], close=True)
lay.add_text('SHEET 1 - CHW PLANT', dxfattribs={'height':5}).set_placement((300,15))
doc.saveas(sys.argv[1])
print('ok')
