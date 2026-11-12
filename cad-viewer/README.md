# ProtoCAD Viewer

A smart viewer for engineering drawings and models — AutoCAD DWG/DXF, MicroStation DGN, HP-GL plot files, 3D models (IFC, STEP, IGES, PCF piping files, STL, OBJ, glTF, FBX…), PDFs and images (scans, photos, SVG) — available as a **Windows (and Linux) desktop program** and as a web app that runs in the browser. The program's interface is in English; Arabic text inside drawings and PDFs is fully supported. Arabic documentation follows the English section.

---

## English

### Supported files
| Category | Formats |
|---|---|
| Drawings | **DWG** (R14 to 2018+) and the DWG family **DWT** (templates) / **DWS** (standards), **DXF**, **DGN V7** (MicroStation / Bentley ISFF, 2D and 3D), **HP-GL / HP-GL/2** plot files (`.plt .hpgl .hgl .hp2 .pen`, also inside PCL/PJL print jobs) |
| Documents | **PDF** |
| Images | **PNG, JPG, GIF, BMP, WebP, SVG, TIFF** (multi-page, CCITT G3/G4 fax, LZW, PackBits, JPEG and Deflate compressed) |
| 3D models | **IFC** (IFC2x3, IFC4, IFC4x3, also `.ifczip`), **STEP** (`.step .stp`, AP203/AP214/AP242), **IGES** (`.iges .igs`), **BREP** (OpenCascade), **PCF** piping component files (ISOGEN; AVEVA E3D/PDMS, Plant 3D, SmartPlant, CADWorx), **STL** (ASCII and binary), **OBJ** (+ MTL and textures), **glTF / GLB** (also Draco and meshopt compressed), **FBX**, **COLLADA (DAE)**, **PLY** (meshes and point clouds), **3MF** |

Known formats that cannot be read in a browser (Revit, Navisworks, SolidWorks, Inventor, CATIA, NX/Creo, Parasolid/ACIS/JT, Rhino, SketchUp, 3ds Max/Blender, DWF/DWFx, AVEVA RVM/E3D, PostScript, DGN V8) open a dialog that explains which export to use instead (e.g. Revit → IFC or FBX, Navisworks → FBX, SolidWorks/Inventor → STEP, AVEVA → PCF or IFC). The file type is chosen by extension and corrected by the file's first bytes (e.g. a PDF saved as `.plt`).

**DGN V7**: lines, line strings, shapes (with fill), curves, complex chains and shapes, ellipses and arcs (including rotated, elliptical and 3D ones via their quaternion), texts and text nodes, cells (shown as blocks, counted in the BOM), B-spline curves, points; levels become layers "Level n"; colours from the file's colour table or MicroStation's default table; line weights and the 8 line styles; UORs converted to master units from the design file settings. Dimensions, shared cells, multi-lines, tags and raster references are listed as unsupported objects.

**3D models** open in a 3D view (WebGL) with the model tree, properties, measuring and sections (see *3D models* below).

**HP-GL / HP-GL/2**: PU/PD/PA/PR, PE (polyline encoded), CI, AA/AR/AT/RT arcs, EA/ER/RA/RR rectangles, EW/WG wedges, polygon mode (PM/EP/FP) with solid and hatch fills, LB labels with DI/DR/SI/SR/LO/DT/CP, PW/WU pen widths, PC/CR pen colours, LT line types, IP/SC scaling, multiple pages (PG) placed side by side. One layer per pen ("PEN n"), units in millimetres (40 plotter units = 1 mm). RO (rotation) is ignored so the drawing is shown upright as drawn.

### Features
- Files are opened on your computer (in the desktop program or inside your browser) and are never uploaded. Pan/zoom (mouse, wheel, touch), zoom extents / window.
- CAD: layers panel (toggle, isolate), model space and layouts with viewports; lines, polylines, arcs, circles, ellipses, splines, TEXT/MTEXT, blocks with attributes, dimensions, hatches, leaders, tables, wipeouts, linetypes and lineweights.
- Measure distance, path length and area with endpoint/midpoint/center snapping. PDFs measure in paper millimetres; images measure in millimetres when the file states a scan/plot resolution (150 dpi or more, non-square pixels included) and in pixels otherwise; **Calibrate scale** (two known points) switches both to real metres.
- **Print / export vector PDF**: paper sizes A4–A0 and ANSI, orientation, plot area (extents, view, window), true scale (1:N) or fit, color/monochrome/grayscale, lineweights, title strip, live preview. Arabic and other non-Latin text plots correctly. Images print fitted to the chosen paper and orientation (whole image, current view or a window); PDFs print or download as the original.
- **Smart tools**: search texts, tags, block names, attribute values and layers; automatic block/cell BOM with attribute breakdown (CSV export); linework length per layer (CSV export).
- **AI assistant (Claude)**: ask questions in English or Arabic about the drawing, PDF or image. It receives a structured summary of the drawing (for images, the image itself) and optionally an image of the current view, and can search, zoom to and highlight items, and show/hide layers through tool calls.
- **Editing** of CAD drawings (draw, modify, properties, layers, undo/redo) and **saving as DXF** (AutoCAD 2013): see *Editing* below.
- Installable PWA (works offline after first use, except the AI assistant) with OS file handling for all openable formats.

### 3D models
Open an IFC, STEP, IGES, PCF or other 3D file (or **Open 3D piping sample** on the welcome screen). Large files are read in the background with a progress message; opening another file cancels a load still running.

**Navigation**: left-drag orbits around the point under the cursor, right- or middle-drag (or Shift+left-drag, or the Pan tool) pans, the wheel zooms towards the cursor, two fingers pinch and pan on touch screens; double-click zooms to a part (or to everything), `F` zooms to extents. **Views** has Top, Bottom, Front, Back, Left, Right and four isometric views, the **view cube** (top right) turns the model to a face, and **PERSP / ORTHO** switches perspective and orthographic projection. **Section** cuts the model open with a section box (six sliders, or *Section box around selection*) or a plane across X, Y or Z (Z gives a plan cut); **wireframe** and **X-ray** (see-through, the selection stays solid) are the next two buttons. The background follows the app theme. Z is up; Y-up formats (glTF, OBJ, FBX, DAE) are turned to Z-up.

**Model tree** (left): IFC files show the spatial structure (Project / Site / Building / Storey) with the elements of each storey grouped by IFC type; PCF files show pipelines and their components; STEP/IGES files their assembly structure; other formats their nodes and meshes. Each row has visibility (eye), isolate and zoom (double-click); the filter finds names, types and attributes. Clicking a part in the view (Shift+click adds) selects it, highlights it and opens it in the tree.

**Properties** (right): IFC elements show GlobalId, name, IFC type, predefined type, object type, type, tag, material, storey and quantities, then all property sets and quantity sets (also those of the element's type); PCF components show type, SKEY, item code, description, size, length, tag, end/centre/branch points, all attributes and the pipeline's attributes; other formats show the node name, triangle count, material and colour. Every selection shows its bounding box in file coordinates, with *Zoom to*, *Isolate*, *Hide* and *Section box around selection*.

**Measure → Distance** measures point to point with ΔX/ΔY/ΔZ, snapping to vertices (square), edge midpoints (triangle), edges (cross) and faces (circle); *Snap* in the menu turns snapping off, *Clear measurements* removes them. Lengths are in the file's units: IFC project units, millimetres for STEP/IGES (converted by OpenCascade), the PCF's UNITS-CO-ORDS, metres for glTF and COLLADA, the FBX unit scale, the 3MF unit; STL, OBJ and PLY store no unit (plain numbers). The status bar shows the X/Y/Z under the cursor.

**BOM** (PCF): bill of materials by item code (description from the MATERIALS section or ITEM-DESCRIPTION), size (150 × 100 mm for reducing items, 3/4" for imperial files) and quantity — pipe as total length in m (ft for imperial files), bolts by BOLT-QUANTITY, everything else counted, grouped as pipe, fittings, flanges, gaskets, bolts, valves, instruments, specials, supports and welds — plus the **pipe length per size**, for all pipelines or one; click a line to select those components; **Export CSV**. For IFC the tab lists the elements by IFC type and type name with counts and lengths from the quantity sets (CSV too).

**PCF geometry**: pipes are cylinders with the bore as diameter, elbows and bends are tubes swept through the centre point (circular when the legs are equal), tees, crosses and olets show run and branch, reducers are cones (eccentric ones follow their end points), flanges a hub and a disc on the face side, blind flanges and gaskets discs, valves a bow-tie body with flanged ends and a handwheel (a lever for ball/plug/butterfly valves, none for check valves; SPINDLE-DIRECTION is honoured), instruments a body with a head, strainers a body with their branch, caps a dome, welds rings and supports a shoe (horizontal lines) or a clamp (vertical lines). Colours follow the component type.

**Print / Export PDF** prints the current 3D view (rendered again at about 3× screen resolution on white) fitted on the chosen paper, with the title strip; **Save image (PNG)** (Views menu or print dialog) saves the view. The **AI assistant** receives a summary of the model (format, units, bounding box, element counts by type, storeys or pipelines, materials, the PCF bill of materials and pipe lengths, element names) and can search, zoom to, show/hide groups (IFC types, storeys, pipelines, component categories) and read element properties.

**Several files**: OBJ models load their MTL and textures, and `.gltf` files their `.bin` and textures, when these are chosen or dropped together with the model (web) or lie next to it (desktop program). Missing textures are listed and the model opens without them.

**Large models**: geometry is merged by material into a few large buffers (with picking cells), repeated IFC geometry is instanced, frustum culling is on, and the view renders only when something changes. Load times measured in this environment (Chromium, software WebGL): see the release notes.

### Editing
Open a DWG, DXF, DGN or PLT drawing and click **Edit** (pencil) in the toolbar to show the Draw/Modify bar (shown by default on computers). Every change can be undone; the title shows `*` while there are unsaved changes, and opening another file, closing the desktop window (or File → Quit) or leaving the web page asks first (Save / Don't save / Cancel).

**Mouse and keys in Select mode**
| Action | How |
|---|---|
| Select | click; **Shift+click** adds or removes; **Ctrl+A** selects everything (not hidden or locked layers); **Esc** clears |
| Window selection | left-drag **left → right** (blue, solid): objects entirely inside |
| Crossing selection | left-drag **right → left** (green, dashed): objects inside or touching |
| Pan | **middle-drag**, **Space+drag**, the **Pan** (hand) tool, or one finger on touch screens; the wheel zooms. In the drawing and modify tools a left-drag pans too |
| Grips | selected objects (up to 100) show blue grips: drag one, or click it (it turns red) and click/type the new point. Lines: ends and midpoint (moves); polylines: vertices and segment midpoints (straight segments move, arcs change their bulge); circles: center (moves) and quadrants (radius); arcs: ends, midpoint, center; ellipses: axes; texts, blocks and points: insertion point (block attributes have their own grips); other objects one grip that moves them |
| Erase | **Delete** (or Backspace) |
| Undo / redo | **Ctrl+Z** / **Ctrl+Y** or **Ctrl+Shift+Z**, or the toolbar arrows. Inside a command Ctrl+Z first removes the last point |

**Commands**: click a toolbar button, or type the alias (like AutoCAD) and press **Enter** or **Space**. Enter on an empty command line repeats the last command; **Esc** ends a command (lines and polylines drawn so far are kept).
| Tool | Alias | Steps |
|---|---|---|
| Line | `L` | points, continuous segments; `U` removes the last segment, `C` closes, Enter ends |
| Polyline | `PL` | points; `U` removes the last point, `C` closes, Enter (or double-click) finishes |
| Rectangle | `REC` | two corners, e.g. `@2000,1000` for the second |
| Circle | `C` | center, then radius (type it or click a point) |
| Arc | `A` | start point, a point on the arc, end point |
| Text | `T` | start point, height, rotation, then the text; Enter starts the next line, Enter on an empty line ends |
| Revision cloud | `RC` | two corners of a rectangle; `A` first sets the arc length |
| Move / Copy | `M` / `CO` | base point, second point (Copy repeats until Enter) |
| Rotate | `RO` | base point, angle in degrees (or click) |
| Scale | `SC` | base point, factor |
| Mirror | `MI` | two points of the mirror line, then `Y` to erase the source or Enter to keep it |
| Offset | `O` | distance, then object (line, polyline, circle, arc) and side; repeats until Enter |
| Explode | `X` | block references (with their array copies; attributes become text), polylines (into lines and arcs), dimensions, tables, multileaders, multilines |
| Erase | `E` | the selection |

Modify tools act on the selection; with nothing selected they first ask for objects (click, two clicks for a window/crossing, Enter to go on).

**Typed input (command line)**: while a command waits for a point, typing goes to the command line above the status bar (also tappable on phones):
- `x,y` absolute coordinates (drawing units), `@dx,dy` relative to the last point,
- `@dist<angle` polar (degrees, counter-clockwise from +X), `dist<angle` polar from the origin,
- a number alone: that distance along the direction of the cursor from the last point (horizontal/vertical with Ortho), e.g. move the cursor right and type `1500`.

**Snap** (`F3`, status bar) snaps to endpoints, midpoints, centers, insertion points, intersections and perpendicular points; **Ortho** (`F8`) keeps new points horizontal or vertical from the last one.

**Properties** (right panel) edit the selection: layer, colour (ByLayer, ByBlock, the AutoCAD colour index palette or a true colour), linetype, lineweight, and per type: line endpoints, circle/arc center, radius, diameter and angles, text content, height, rotation and width, MTEXT content, block position, rotation, scale and **attribute values** (valve tags, sizes…), polyline closed/width, dimension text override. With several objects, shared values are shown and others read *\*varies\**; a change applies to all of them. Objects on locked layers are shown but cannot be selected or changed.

**Layers panel**: `+` makes a new layer (type its name), each row has visibility (eye; double-click a row to isolate), lock and colour (click the swatch), and the `⋯` menu: Make current, Rename, Color, Lock/Unlock, Delete (empty layers only; not 0, Defpoints or the current layer). The current layer (bold, ✓, also in the Draw bar) receives new objects. Layer visibility is a view setting and is not saved.

**Saving** (`Ctrl+S`, `Ctrl+Shift+S` = Save As, toolbar, desktop File menu): drawings are saved as **DXF (AutoCAD 2013, AC1027)**, which AutoCAD, BricsCAD, DraftSight, LibreCAD, QCAD and MicroStation open. In the desktop program `Ctrl+S` writes back to the DXF that was opened (or last saved); otherwise a Save dialog (desktop) or a download (web) is used. DWG cannot be written in the browser: a DWG, DGN or HP-GL drawing is saved as DXF, and the program says so once ("use Save As DWG in AutoCAD if needed"). After saving, a note lists what was converted or left out, e.g. *1 MULTILEADER written as lines and text, 1 3DSOLID skipped*. What the DXF contains: header, classes, all tables (layers with colour, true colour, linetype, lineweight, lock/freeze/on), text and dimension styles, every block (also anonymous dimension blocks), model space, all layouts with their viewports, and the objects AutoCAD expects (dictionaries, layouts, plot styles, materials). Entities keep their handles; new objects get unique ones.

| Written as is | Converted | Not saved |
|---|---|---|
| LINE, CIRCLE, ARC, ELLIPSE, LWPOLYLINE (widths, bulges), POLYLINE 2D/3D, polyface and mesh, SPLINE, TEXT, MTEXT, INSERT + ATTRIB, ATTDEF, DIMENSION (with its block), LEADER, HATCH (all boundary edge types, pattern lines, solid, gradient), SOLID, TRACE, 3DFACE, POINT, XLINE, RAY, TOLERANCE, WIPEOUT, VIEWPORT | MULTILEADER → polylines, arrowheads and MTEXT; MLINE → polylines; ACAD_TABLE → a block reference of its graphics; IMAGE → its frame (the image file is not embedded); special dimensions → block reference | 3D solids, regions, bodies, OLE objects, proxies, DGN dimensions/tags |

Dimensions and tables keep their graphics in an anonymous block: moving, rotating, scaling or mirroring one transforms that block with it (a copy gets its own block), and a scaled dimension shows the scaled value. Dimensions are not re-generated from a dimension style. Mirrored texts stay readable (like AutoCAD's MIRRTEXT = 0). Exploded block contents take the block reference's layer (for objects on layer 0) and its ByBlock colour, linetype and lineweight, so they look the same.

**Checking saved files**: `npm run test:dxf` writes every test drawing as DXF, reads it back and compares it with the original, then audits the files with [ezdxf](https://ezdxf.mozman.at) (skipped when Python 3 with `pip install ezdxf` is not available). `DXF_SAMPLES=<folder> npm run test:dxf` adds the DWG/DXF files of a folder.

### Markup (PDFs and images)
The **Markup** bar (shown for PDFs and images; toolbar button *Markup* hides it) has Bluebeam-style review tools: **Pen** (freehand), **Line**, **Arrow**, **Rectangle**, **Ellipse**, **Revision cloud** (drag a rectangle, or the polygon cloud: click corners, double-click / Enter to finish), **Text box**, **Callout** (drag from the arrow tip to where the text goes), **Highlighter** (translucent), **Stamp** (APPROVED, REJECTED, FOR CONSTRUCTION or custom text, with author and date) and **Convert measurements** (turns the distance/path/area measurements on the page into markups with their value). Style: colour swatches or any colour, line width, fill (none, white, yellow, same as colour), opacity, text size and the author name. With the Select tool, click a markup to select it, drag it to move, drag a grip to resize, double-click a text box, callout or stamp to edit its text, `Del` deletes; `Ctrl+Z` / `Ctrl+Y` undo and redo markup changes. Markups are kept per page in page coordinates. The **Markups** side tab lists them (page, type, text, author, date; click to zoom to one) and exports the list as CSV.

**Saving** (`Ctrl+S` or the Save menu on the Markup bar; Save dialog on the desktop, a download on the web): *Save marked-up PDF* writes the PDF with the markups as real PDF annotations with appearance streams — Square/Circle (rectangle, ellipse, highlight with opacity), Line with arrow ending, Ink (pen), Polygon with cloudy border (clouds), FreeText and FreeText callout, Stamp, Line/PolyLine/Polygon measurement annotations — so Acrobat, Bluebeam and browsers show them and can still edit them. *Save flattened PDF* draws them into the page content instead. For images the output is a PDF (picture page + annotations, real size for scans) or a flattened PNG. Opening a PDF saved here gives the markups back for editing; annotations from other programs are displayed. Print / Export PDF of a sheet includes the markups. Opening another file or closing with unsaved markups asks to save first. Limits: text uses Helvetica (characters outside Latin-1 become "?" in the PDF), on pages rotated in the PDF the annotation text stays unrotated, and page thumbnails do not show markups.

### Desktop program (Windows)
**Install**
1. Download the installer:
   - released versions: the repository's **Releases** page (`ProtoCAD Viewer_<version>_x64-setup.exe`, or the `.msi`);
   - the latest build: the **Actions** tab → workflow **Desktop app** → newest successful run → **Artifacts** → `ProtoCAD-Viewer-Windows` (a zip with the `-setup.exe` and the `.msi`; you need to be signed in to GitHub).
2. Run `…-setup.exe` (installs for the current user, no administrator rights needed) or the `.msi` (per machine, for IT deployment).
3. The installers are **not code-signed**, so Windows SmartScreen shows "Windows protected your PC / Unknown publisher": click **More info → Run anyway**. Some company policies block unsigned installers; ask IT to allow it or to deploy the `.msi`.
4. The program needs Microsoft Edge WebView2, which Windows 10 and 11 normally include; when it is missing the installer downloads it (internet needed once).

**Use**: double-click a DWG, DXF, DGN, PLT, IFC, STEP, IGES, PCF, PDF or image in Explorer, use **Open with → ProtoCAD Viewer**, drag files onto the window, or **File → Open** (`Ctrl+O`). The installer registers ProtoCAD Viewer for CAD drawings (DWG, DWT, DWS, DXF, DGN, PLT/HPGL) and engineering 3D models (IFC/IFCZIP, STEP/STP, IGES/IGS, PCF; uninstalling restores the previous registration) and offers it under **Open with** for PDFs, images and 3D mesh files (STL, OBJ, glTF/GLB, FBX, DAE, PLY, 3MF, BREP) without touching your default PDF, image and 3D apps. Where you already chose a default app (e.g. AutoCAD for `.dwg`) Windows keeps it; to make ProtoCAD Viewer the default, choose **Open with → Choose another app → ProtoCAD Viewer → Always**. Save dialogs start in the open drawing's folder (otherwise the last folder used) and add the extension when you type a name without one. Opening another file while the program runs reuses the open window. **File → Open Recent** and the welcome screen list the last 10 files. **Print** opens the plot PDF in your PDF app (Edge, Acrobat…), where you choose the printer; choose *Actual size* to keep a true scale. **Export PDF**, CSV exports and *Save a copy* ask where to save. The AI assistant still needs internet access; its API key is stored on this computer only. On Linux, install the `.deb` (`sudo apt install ./ProtoCAD*.deb`; it also teaches the desktop the DGN, PLT/HPGL, DWT, DWS, IFC, STEP, PCF, FBX, DAE, PLY and BREP file types) or run the `.AppImage` from the `ProtoCAD-Viewer-Linux` artifact.

**Build it yourself** (the CI workflow `.github/workflows/desktop.yml` does the same on every push that touches `cad-viewer/`, and creates a draft release with the installers for tags like `v1.2.0`):
- All platforms: [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs) (stable).
- Windows: Visual Studio Build Tools with "Desktop development with C++" (MSVC and the Windows SDK). WebView2 is part of Windows 10/11.
- Linux (Debian/Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev build-essential file patchelf`.
- macOS (not tested): Xcode command line tools.
```bash
cd cad-viewer
npm install
npm run tauri dev                          # desktop program with live reload (uses the Vite dev server)
npm run tauri build                        # installers in src-tauri/target/release/bundle/
npm run tauri build -- --bundles nsis,msi  # only the Windows installers (or deb,appimage on Linux)
```
The desktop program is a [Tauri 2](https://tauri.app) shell (`src-tauri/`, Rust) around the same web app. `src/platform.js` holds the few differences (native Open/Save dialogs, printing through the PDF app, recent files, files from Explorer); the web build does not load any of it.

### Web app
Requires [Node.js](https://nodejs.org) 20 or newer.
```bash
cd cad-viewer
npm install
npm run dev      # development server (http://localhost:5173)
npm run build    # production build in dist/
npm run preview  # serve the production build locally
npm test         # parser/scene smoke test, DGN, HP-GL, format registry and file association tests,
                 # PCF reader/BOM/3D model tests, editing tests and the DXF writer round trip
npm run test:dxf # DXF round trip + ezdxf audit of the written files (needs Python 3 with ezdxf)
```
The `dist` folder is a static site that can be hosted anywhere (GitHub Pages, Netlify, an internal server). It must be served over `http://` or `https://`, not opened as a local `index.html`.

**Install the web app**: open the site in Chrome or Edge and click **Install** in the address bar. The installed app works offline after first use (except the AI assistant) and appears in "Open with" for the supported file types.

**3D view**: needs WebGL (every current browser; on old graphics drivers turn on hardware acceleration).

**AI assistant**: create an API key at [console.anthropic.com](https://console.anthropic.com) and paste it in **Settings**, then choose the model (default Claude Opus 5.5) and thinking effort. The key is stored only in this browser and requests go directly from your device to Anthropic. What is sent: the drawing summary (layers, blocks and counts, texts), the image for image files, and an image of the current view when that option is on. API usage is billed to your account.

### Project layout
```
src/
  formats/    format registry (extensions, magic bytes, loaders, unsupported-format hints),
              DGN V7, HP-GL and PCF readers (PCF bill of materials), image documents (raster, SVG, TIFF)
  view3d/     3D models (loaded on demand): viewer (three.js), merged geometry and picking, model
              tree/properties/BOM UI, IFC (web-ifc) and STEP/IGES/BREP (occt-import-js) workers,
              three.js loaders for STL/OBJ/glTF/PLY/FBX/DAE/3MF, PCF piping geometry
  cad/        DXF parser and writer, DWG loading (LibreDWG WebAssembly in a worker), drawing model, tessellation into primitives
  render/     canvas renderer, interactive viewer, vector PDF export (jsPDF)
  pdf/        PDF viewing, text extraction and search (pdf.js)
  edit/       editing: document with undo/redo (model.js), entity geometry (transform, grips, offset,
              explode, new entities), edit operations (ops.js)
  tools/      picking and snapping index, select/measure/window tools, drawing and modify tools,
              command line parsing, analysis (search, BOM, summaries)
  markup/     PDF/image markups: model, drawing and undo (markup.js), tools, PDF annotations (pdf-lib)
  ai/         Claude assistant with tool use
  ui/         icons, markdown rendering, colour picker, properties editor
  platform.js web/desktop differences (dialogs, saving, printing, OS file handling)
src-tauri/    desktop program (Tauri 2, Rust): window, menu, file dialogs, file associations,
              single instance, recent files, CSP and permissions (tauri.conf.json, capabilities/)
tests/        smoke and format tests, fixture generators, fixtures/
```
To add a format, add an entry to `src/formats/registry.js` (extensions, category, `open()` or an unsupported `hint`) and list openable extensions in `public/manifest.webmanifest`; desktop associations come from the registry too: CAD drawings and 3D formats marked `associate` go to `fileAssociations` of `src-tauri/tauri.conf.json` (and the Linux MIME file), the other openable types to the "Open with" lists of `src-tauri/windows/open-with.nsh` / `open-with.wxs` and the Linux desktop file (tests check all of them against the registry). 3D formats (category `3d`) return a model for `src/view3d` (see `open3d.js`).

### Known limitations
3D: IFC geometry comes from web-ifc (some complex booleans or rare representation types may be simplified or missing; IFC4x3 alignments are not drawn); STEP/IGES are triangulated by OpenCascade (no PMI or exact B-rep measuring: snapping works on the triangulated surface); KTX2/Basis-compressed glTF textures, animations and skinning are not shown (the model shows in its rest pose); RVM/NWD/RVT need an export (see above); very large models are limited by the browser's memory (WebAssembly has at most 4 GB).
SHX fonts are substituted with Arial; 3D solids, raster images and xrefs inside DWG/DXF are not drawn; DWG support depends on LibreDWG, so unusual files may open incomplete (saving as DXF is a workaround). DGN V8 needs an export from MicroStation; DGN dimensions, tags and shared cells are not drawn and 3D DGN files are shown in plan (top) view. HP-GL files with PostScript or raster (PCL) content show only their HP-GL vectors. Editing: drawings are saved as DXF only (not DWG); dimensions are transformed with their graphics but not re-generated from their style; the lock state of layers in DWG files is not read (LibreDWG reports every layer locked, so DWG layers open unlocked); objects with a tilted 3D orientation (extrusion not along Z) are not moved/rotated; complex linetypes keep their dashes but lose embedded shapes and text when saved. Very large TIFF pages (over ~32 megapixels) are displayed at reduced resolution (Info says so); measurements still use the original pixel size.

### License
GPL-3.0, because DWG reading uses LibreDWG (`@mlightcad/libredwg-web`, GPL-3.0). TIFF decoding uses [UTIF.js](https://github.com/photopea/UTIF.js) (`utif2`, MIT). 3D: [three.js](https://threejs.org) (`three` 0.186.1, MIT; its Draco decoder is Apache-2.0), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (0.0.78, MPL-2.0) and [occt-import-js](https://github.com/kovacsv/occt-import-js) (0.0.23, LGPL-2.1, OpenCascade). The test fixtures `smalltest.dgn` and `test_dgnv8.dgn` come from GDAL's autotest data (MIT/X licence).

---

## العربية

ProtoCAD Viewer عارض ذكي للرسومات الهندسية، متاح **كبرنامج ويندوز يتثبت على الجهاز** (وكمان لينكس)، وكموقع يشتغل من المتصفح على أي جهاز (ويندوز، ماك، موبايل). **واجهة البرنامج باللغة الإنجليزية**، لكن النصوص العربية داخل الرسومات وملفات PDF بتتعرض وتتطبع بشكل صحيح، والمساعد الذكي بيرد بالعربي لو سألته بالعربي.

### الملفات المدعومة
- **رسومات**: DWG (من R14 حتى 2018 وما بعدها) وملفات DWT (القوالب) و DWS (المعايير)، و DXF، و **DGN V7** من MicroStation (ثنائي وثلاثي الأبعاد)، وملفات البلوت **HP-GL / HP-GL/2** (`.plt` و `.hpgl` و `.hgl` و `.hp2` و `.pen`) حتى لو كانت داخل ملف طباعة PCL.
- **مستندات**: PDF.
- **صور**: PNG و JPG و GIF و BMP و WebP و SVG و TIFF (متعدد الصفحات، ومنها ملفات الاسكانر المضغوطة CCITT G4).
- **نماذج ثلاثية الأبعاد**: IFC (و IFCZIP) و STEP و IGES و BREP، وملفات المواسير **PCF** (من AVEVA و Plant 3D و SmartPlant و CADWorx)، و STL و OBJ و glTF/GLB و FBX و DAE و PLY و 3MF.
- صيغ معروفة لا يمكن فتحها في المتصفح (Revit و Navisworks و SolidWorks و Inventor و CATIA و NX و SketchUp و DWF و AVEVA و DGN V8): البرنامج بيظهر رسالة توضح تصدّرها لأي صيغة (مثلاً Revit إلى IFC أو DWG، و DGN V8 إلى DWG أو DXF).

في ملفات DGN: المستويات (Levels) بتظهر كطبقات باسم "Level n"، والـ Cells بتظهر كبلوكات وبتتحسب في حصر الكميات (BOM). في ملفات البلوت: كل قلم (Pen) طبقة باسم "PEN n" والوحدات بالمليمتر.

### المميزات
- الملفات تُفتح على جهازك ولا تُرفع لأي خادم. تكبير وتصغير بعجلة الماوس، سحب للتحريك، لمس بإصبعين على الموبايل، `F` لعرض الرسمة كاملة، وتكبير منطقة محددة.
- الطبقات (Layers): إظهار/إخفاء، نقرتين لعزل طبقة، ألوان الطبقات وعدد العناصر. مساحة الـ Model والـ Layouts مع عرض محتوى الـ Viewports.
- **القياس**: مسافة (مع ΔX و ΔY والزاوية)، طول مسار، ومساحة ومحيط، مع التقاط (Snap) للنهايات والمنتصف والمراكز. في ملفات PDF القياس بالمليمتر على الورق، وفي الصور بالمليمتر لو الملف فيه دقة مسح ضوئي (150 dpi أو أكتر) وإلا بالبكسل، و**معايرة المقياس** بنقطتين معروفتين تحوّل القياس للمتر الحقيقي (مفيدة جداً للرسومات الممسوحة بالاسكانر).
- **الطباعة وتصدير PDF**: PDF متجه بجودة طباعة (A4 حتى A0 و ANSI، طولي/عرضي، مقياس حقيقي أو ملائمة للورقة، ملون أو أسود أو رمادي، وسُمك الخطوط) مع معاينة. الصور بتتطبع ملائمة لمقاس الورق والاتجاه المختار. النصوص العربية تُطبع بشكل صحيح.
- **العرض ثلاثي الأبعاد**: دوران وتحريك وتكبير بالماوس واللمس، مناظر قياسية (Top / Front / Iso…) ومكعب اتجاهات، منظور أو Orthographic، **قطاع** (Section box أو مستوى قطع)، Wireframe و X-ray، شجرة النموذج (طوابق IFC أو خطوط المواسير في PCF) مع إظهار/إخفاء وعزل، خصائص العنصر (Property sets في IFC وكل بيانات المكوّن في PCF)، قياس المسافة مع ΔX و ΔY و ΔZ والالتقاط على الرؤوس والحواف والأسطح، و**جدول كميات (BOM)** لملفات PCF بأكواد المواد والمقاسات وطول المواسير لكل مقاس مع تصدير CSV، وطباعة المنظر الحالي PDF أو حفظه صورة PNG.
- **بحث ذكي** عن النصوص والتاجات والبلوكات والطبقات، و**حصر البلوكات (BOM)** وأطوال الخطوط لكل طبقة مع تصدير CSV.
- **التعديل على الرسمة**: زر **Edit** بيظهر أدوات الرسم (خط، Polyline، مستطيل، دائرة، قوس، نص، Revision cloud) والتعديل (نقل، نسخ، تدوير، تكبير، Mirror، Offset، Explode، مسح) بنفس اختصارات AutoCAD (`L`، `PL`، `M`، `CO`...)، مع إدخال الإحداثيات بالكتابة (`x,y` و `@dx,dy` و `@المسافة<الزاوية` أو رقم المسافة)، و Snap و Ortho (`F8`)، وتعديل الخصائص (الطبقة واللون وقيم الـ Attributes زي التاجات والمقاسات)، وإدارة الطبقات، و Undo/Redo. الحفظ بصيغة **DXF** (AutoCAD 2013) بـ `Ctrl+S`، وملفات DWG بتتحفظ DXF (AutoCAD بيفتحها، ومنه Save As DWG لو محتاج).
- **المساعد الذكي (Claude)**: اسأله بالعربي أو الإنجليزي عن الرسمة أو ملف الـ PDF أو الصورة — يلخص، يعمل جدول كميات، يراجع التاجات، ويشرح الجزء الظاهر على الشاشة، ويقدر يبحث ويعمل zoom ويخفي ويظهر الطبقات بنفسه.

### التشغيل
محتاج [Node.js](https://nodejs.org) إصدار 20 أو أحدث:
```bash
cd cad-viewer
npm install
npm run dev      # للتطوير: افتح الرابط اللي يظهر (http://localhost:5173)
npm run build    # نسخة نهائية في مجلد dist
npm run preview  # تشغيل النسخة النهائية محلياً
npm test         # اختبارات قراءة الملفات
```
ملاحظة: ملفات IFC و STEP و IGES و PCF بتتفتح تلقائياً بالبرنامج على ويندوز، وملفات STL و OBJ و FBX و glTF وغيرها بتظهر في "Open with".

مجلد `dist` موقع ثابت تقدر ترفعه على أي استضافة، ولازم يتفتح عن طريق `http://` أو `https://`.

**تثبيت برنامج الويندوز**: نزّل ملف التثبيت `…-setup.exe` (أو `.msi`) من صفحة **Releases** في المستودع، أو من تبويب **Actions** ← **Desktop app** ← آخر تشغيل ناجح ← **Artifacts** ← `ProtoCAD-Viewer-Windows`، وشغّله. ملف التثبيت مش موقّع رقمياً، فويندوز هيظهر رسالة SmartScreen "Unknown publisher": اضغط **More info** ثم **Run anyway**. بعد التثبيت تقدر تفتح ملفات DWG و DXF و DGN و PLT و PDF والصور بالدبل كليك أو من "Open with" أو بالسحب على نافذة البرنامج، والطباعة بتفتح ملف PDF في برنامج الـ PDF عندك (اختار Actual size عشان المقياس يفضل مظبوط). البرنامج محتاج WebView2 الموجود أصلاً في ويندوز 10 و 11، ولو مش موجود ملف التثبيت بينزّله.

**تثبيت نسخة الموقع كتطبيق**: افتح الموقع في Chrome أو Edge واضغط **Install** من شريط العنوان. بعد أول استخدام يشتغل بدون إنترنت (ما عدا المساعد الذكي)، وتقدر تفتح منه كل الصيغ المدعومة من "Open with".

**تفعيل المساعد الذكي**: اعمل مفتاح API من [console.anthropic.com](https://console.anthropic.com)، وحطه من **Settings** في البرنامج. المفتاح يتحفظ في المتصفح ده بس، والطلبات بتروح مباشرة من جهازك لـ Anthropic، واستهلاك الـ API بيتحسب على حسابك.

### حدود معروفة
- خطوط SHX بتتعرض بخط Arial، والمجسمات ثلاثية الأبعاد والصور المرتبطة والـ Xrefs داخل DWG مش بتتعرض.
- ملفات DGN V8 محتاجة تصدير من MicroStation، والأبعاد (Dimensions) والـ Tags في DGN مش بتتعرض، وملفات DGN ثلاثية الأبعاد بتتعرض من أعلى (Plan).
- ملفات TIFF الضخمة جداً (أكبر من حوالي 32 ميجا بكسل) بتتعرض بدقة أقل، لكن القياس بيفضل بأبعاد البكسل الأصلية.

### الترخيص
البرنامج مرخص **GPL-3.0** لأنه بيستخدم LibreDWG. قراءة TIFF عن طريق UTIF.js (رخصة MIT)، وملفات اختبار DGN من GDAL (رخصة MIT/X).
