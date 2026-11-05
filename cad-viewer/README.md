# ProtoCAD Viewer

A smart viewer for engineering drawings — AutoCAD DWG/DXF, MicroStation DGN, HP-GL plot files, PDFs and images (scans, photos, SVG) — available as a **Windows (and Linux) desktop program** and as a web app that runs in the browser. The program's interface is in English; Arabic text inside drawings and PDFs is fully supported. Arabic documentation follows the English section.

---

## English

### Supported files
| Category | Formats |
|---|---|
| Drawings | **DWG** (R14 to 2018+) and the DWG family **DWT** (templates) / **DWS** (standards), **DXF**, **DGN V7** (MicroStation / Bentley ISFF, 2D and 3D), **HP-GL / HP-GL/2** plot files (`.plt .hpgl .hgl .hp2 .pen`, also inside PCL/PJL print jobs) |
| Documents | **PDF** |
| Images | **PNG, JPG, GIF, BMP, WebP, SVG, TIFF** (multi-page, CCITT G3/G4 fax, LZW, PackBits, JPEG and Deflate compressed) |

Known formats that cannot be read in a browser (Revit, Navisworks, SolidWorks, Inventor, CATIA, NX/Creo, SketchUp, DWF/DWFx, AVEVA RVM/E3D, PostScript, DGN V8) open a dialog that explains which export to use instead. The file type is chosen by extension and corrected by the file's first bytes (e.g. a PDF saved as `.plt`).

**DGN V7**: lines, line strings, shapes (with fill), curves, complex chains and shapes, ellipses and arcs (including rotated, elliptical and 3D ones via their quaternion), texts and text nodes, cells (shown as blocks, counted in the BOM), B-spline curves, points; levels become layers "Level n"; colours from the file's colour table or MicroStation's default table; line weights and the 8 line styles; UORs converted to master units from the design file settings. Dimensions, shared cells, multi-lines, tags and raster references are listed as unsupported objects.

**HP-GL / HP-GL/2**: PU/PD/PA/PR, PE (polyline encoded), CI, AA/AR/AT/RT arcs, EA/ER/RA/RR rectangles, EW/WG wedges, polygon mode (PM/EP/FP) with solid and hatch fills, LB labels with DI/DR/SI/SR/LO/DT/CP, PW/WU pen widths, PC/CR pen colours, LT line types, IP/SC scaling, multiple pages (PG) placed side by side. One layer per pen ("PEN n"), units in millimetres (40 plotter units = 1 mm). RO (rotation) is ignored so the drawing is shown upright as drawn.

### Features
- Files are opened on your computer (in the desktop program or inside your browser) and are never uploaded. Pan/zoom (mouse, wheel, touch), zoom extents / window.
- CAD: layers panel (toggle, isolate), model space and layouts with viewports; lines, polylines, arcs, circles, ellipses, splines, TEXT/MTEXT, blocks with attributes, dimensions, hatches, leaders, tables, wipeouts, linetypes and lineweights.
- Measure distance, path length and area with endpoint/midpoint/center snapping. PDFs measure in paper millimetres; images measure in millimetres when the file states a scan/plot resolution (150 dpi or more, non-square pixels included) and in pixels otherwise; **Calibrate scale** (two known points) switches both to real metres.
- **Print / export vector PDF**: paper sizes A4–A0 and ANSI, orientation, plot area (extents, view, window), true scale (1:N) or fit, color/monochrome/grayscale, lineweights, title strip, live preview. Arabic and other non-Latin text plots correctly. Images print fitted to the chosen paper and orientation (whole image, current view or a window); PDFs print or download as the original.
- **Smart tools**: search texts, tags, block names, attribute values and layers; automatic block/cell BOM with attribute breakdown (CSV export); linework length per layer (CSV export).
- **AI assistant (Claude)**: ask questions in English or Arabic about the drawing, PDF or image. It receives a structured summary of the drawing (for images, the image itself) and optionally an image of the current view, and can search, zoom to and highlight items, and show/hide layers through tool calls.
- Installable PWA (works offline after first use, except the AI assistant) with OS file handling for all openable formats.

### Desktop program (Windows)
**Install**
1. Download the installer:
   - released versions: the repository's **Releases** page (`ProtoCAD Viewer_<version>_x64-setup.exe`, or the `.msi`);
   - the latest build: the **Actions** tab → workflow **Desktop app** → newest successful run → **Artifacts** → `ProtoCAD-Viewer-Windows` (a zip with the `-setup.exe` and the `.msi`; you need to be signed in to GitHub).
2. Run `…-setup.exe` (installs for the current user, no administrator rights needed) or the `.msi` (per machine, for IT deployment).
3. The installers are **not code-signed**, so Windows SmartScreen shows "Windows protected your PC / Unknown publisher": click **More info → Run anyway**. Some company policies block unsigned installers; ask IT to allow it or to deploy the `.msi`.
4. The program needs Microsoft Edge WebView2, which Windows 10 and 11 normally include; when it is missing the installer downloads it (internet needed once).

**Use**: double-click a DWG, DXF, DGN, PLT, PDF or image in Explorer, use **Open with → ProtoCAD Viewer**, drag files onto the window, or **File → Open** (`Ctrl+O`). The installer registers ProtoCAD Viewer for all supported file types (uninstalling restores the previous registration). Where you already chose a default app (e.g. AutoCAD for `.dwg`, Edge for `.pdf`) Windows keeps it; to make ProtoCAD Viewer the default, choose **Open with → Choose another app → ProtoCAD Viewer → Always**. Opening another file while the program runs reuses the open window. **File → Open Recent** and the welcome screen list the last 10 files. **Print** opens the plot PDF in your PDF app (Edge, Acrobat…), where you choose the printer; choose *Actual size* to keep a true scale. **Export PDF**, CSV exports and *Save a copy* ask where to save. The AI assistant still needs internet access; its API key is stored on this computer only. On Linux, install the `.deb` (`sudo apt install ./ProtoCAD*.deb`) or run the `.AppImage` from the `ProtoCAD-Viewer-Linux` artifact.

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
npm test         # parser/scene smoke test + DGN, HP-GL, format registry and file association tests
```
The `dist` folder is a static site that can be hosted anywhere (GitHub Pages, Netlify, an internal server). It must be served over `http://` or `https://`, not opened as a local `index.html`.

**Install the web app**: open the site in Chrome or Edge and click **Install** in the address bar. The installed app works offline after first use (except the AI assistant) and appears in "Open with" for the supported file types.

**AI assistant**: create an API key at [console.anthropic.com](https://console.anthropic.com) and paste it in **Settings**, then choose the model (default Claude Opus 5.5) and thinking effort. The key is stored only in this browser and requests go directly from your device to Anthropic. What is sent: the drawing summary (layers, blocks and counts, texts), the image for image files, and an image of the current view when that option is on. API usage is billed to your account.

### Project layout
```
src/
  formats/    format registry (extensions, magic bytes, loaders, unsupported-format hints),
              DGN V7 and HP-GL readers, image documents (raster, SVG, TIFF)
  cad/        DXF parser, DWG loading (LibreDWG WebAssembly in a worker), drawing model, tessellation into primitives
  render/     canvas renderer, interactive viewer, vector PDF export (jsPDF)
  pdf/        PDF viewing, text extraction and search (pdf.js)
  tools/      picking and snapping index, measure/select/window tools, analysis (search, BOM, summaries)
  ai/         Claude assistant with tool use
  ui/         icons and markdown rendering
  platform.js web/desktop differences (dialogs, saving, printing, OS file handling)
src-tauri/    desktop program (Tauri 2, Rust): window, menu, file dialogs, file associations,
              single instance, recent files, CSP and permissions (tauri.conf.json, capabilities/)
tests/        smoke and format tests, fixture generators, fixtures/
```
To add a format, add an entry to `src/formats/registry.js` (extensions, category, `open()` or an unsupported `hint`) and list openable extensions in `public/manifest.webmanifest` and in `fileAssociations` of `src-tauri/tauri.conf.json` (tests check that both match the registry). The `3d` category is reserved for 3D models.

### Known limitations
SHX fonts are substituted with Arial; 3D solids, raster images and xrefs inside DWG/DXF are not drawn; DWG support depends on LibreDWG, so unusual files may open incomplete (saving as DXF is a workaround). DGN V8 needs an export from MicroStation; DGN dimensions, tags and shared cells are not drawn and 3D DGN files are shown in plan (top) view. HP-GL files with PostScript or raster (PCL) content show only their HP-GL vectors. Very large TIFF pages (over ~32 megapixels) are displayed at reduced resolution (Info says so); measurements still use the original pixel size.

### License
GPL-3.0, because DWG reading uses LibreDWG (`@mlightcad/libredwg-web`, GPL-3.0). TIFF decoding uses [UTIF.js](https://github.com/photopea/UTIF.js) (`utif2`, MIT). The test fixtures `smalltest.dgn` and `test_dgnv8.dgn` come from GDAL's autotest data (MIT/X licence).

---

## العربية

ProtoCAD Viewer عارض ذكي للرسومات الهندسية، متاح **كبرنامج ويندوز يتثبت على الجهاز** (وكمان لينكس)، وكموقع يشتغل من المتصفح على أي جهاز (ويندوز، ماك، موبايل). **واجهة البرنامج باللغة الإنجليزية**، لكن النصوص العربية داخل الرسومات وملفات PDF بتتعرض وتتطبع بشكل صحيح، والمساعد الذكي بيرد بالعربي لو سألته بالعربي.

### الملفات المدعومة
- **رسومات**: DWG (من R14 حتى 2018 وما بعدها) وملفات DWT (القوالب) و DWS (المعايير)، و DXF، و **DGN V7** من MicroStation (ثنائي وثلاثي الأبعاد)، وملفات البلوت **HP-GL / HP-GL/2** (`.plt` و `.hpgl` و `.hgl` و `.hp2` و `.pen`) حتى لو كانت داخل ملف طباعة PCL.
- **مستندات**: PDF.
- **صور**: PNG و JPG و GIF و BMP و WebP و SVG و TIFF (متعدد الصفحات، ومنها ملفات الاسكانر المضغوطة CCITT G4).
- صيغ معروفة لا يمكن فتحها في المتصفح (Revit و Navisworks و SolidWorks و Inventor و CATIA و NX و SketchUp و DWF و AVEVA و DGN V8): البرنامج بيظهر رسالة توضح تصدّرها لأي صيغة (مثلاً Revit إلى IFC أو DWG، و DGN V8 إلى DWG أو DXF).

في ملفات DGN: المستويات (Levels) بتظهر كطبقات باسم "Level n"، والـ Cells بتظهر كبلوكات وبتتحسب في حصر الكميات (BOM). في ملفات البلوت: كل قلم (Pen) طبقة باسم "PEN n" والوحدات بالمليمتر.

### المميزات
- الملفات تُفتح على جهازك ولا تُرفع لأي خادم. تكبير وتصغير بعجلة الماوس، سحب للتحريك، لمس بإصبعين على الموبايل، `F` لعرض الرسمة كاملة، وتكبير منطقة محددة.
- الطبقات (Layers): إظهار/إخفاء، نقرتين لعزل طبقة، ألوان الطبقات وعدد العناصر. مساحة الـ Model والـ Layouts مع عرض محتوى الـ Viewports.
- **القياس**: مسافة (مع ΔX و ΔY والزاوية)، طول مسار، ومساحة ومحيط، مع التقاط (Snap) للنهايات والمنتصف والمراكز. في ملفات PDF القياس بالمليمتر على الورق، وفي الصور بالمليمتر لو الملف فيه دقة مسح ضوئي (150 dpi أو أكتر) وإلا بالبكسل، و**معايرة المقياس** بنقطتين معروفتين تحوّل القياس للمتر الحقيقي (مفيدة جداً للرسومات الممسوحة بالاسكانر).
- **الطباعة وتصدير PDF**: PDF متجه بجودة طباعة (A4 حتى A0 و ANSI، طولي/عرضي، مقياس حقيقي أو ملائمة للورقة، ملون أو أسود أو رمادي، وسُمك الخطوط) مع معاينة. الصور بتتطبع ملائمة لمقاس الورق والاتجاه المختار. النصوص العربية تُطبع بشكل صحيح.
- **بحث ذكي** عن النصوص والتاجات والبلوكات والطبقات، و**حصر البلوكات (BOM)** وأطوال الخطوط لكل طبقة مع تصدير CSV.
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
