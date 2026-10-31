# ProtoCAD Viewer

A smart viewer for engineering drawings — AutoCAD DWG/DXF, MicroStation DGN, HP-GL plot files, PDFs and images (scans, photos, SVG) — that runs in the browser and can be installed as a desktop app. The program's interface is in English; Arabic text inside drawings and PDFs is fully supported. Arabic documentation follows the English section.

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
- Files are opened inside your browser and are never uploaded. Pan/zoom (mouse, wheel, touch), zoom extents / window.
- CAD: layers panel (toggle, isolate), model space and layouts with viewports; lines, polylines, arcs, circles, ellipses, splines, TEXT/MTEXT, blocks with attributes, dimensions, hatches, leaders, tables, wipeouts, linetypes and lineweights.
- Measure distance, path length and area with endpoint/midpoint/center snapping. PDFs measure in paper millimetres and images in pixels; **Calibrate scale** (two known points) switches both to real metres.
- **Print / export vector PDF**: paper sizes A4–A0 and ANSI, orientation, plot area (extents, view, window), true scale (1:N) or fit, color/monochrome/grayscale, lineweights, title strip, live preview. Arabic and other non-Latin text plots correctly. Images print fitted to the chosen paper and orientation (whole image, current view or a window); PDFs print or download as the original.
- **Smart tools**: search texts, tags, block names, attribute values and layers; automatic block/cell BOM with attribute breakdown (CSV export); linework length per layer (CSV export).
- **AI assistant (Claude)**: ask questions in English or Arabic about the drawing, PDF or image. It receives a structured summary of the drawing (for images, the image itself) and optionally an image of the current view, and can search, zoom to and highlight items, and show/hide layers through tool calls.
- Installable PWA (works offline after first use, except the AI assistant) with OS file handling for all openable formats.

### Run
Requires [Node.js](https://nodejs.org) 20 or newer.
```bash
cd cad-viewer
npm install
npm run dev      # development server (http://localhost:5173)
npm run build    # production build in dist/
npm run preview  # serve the production build locally
npm test         # parser/scene smoke test + DGN, HP-GL and format registry tests
```
The `dist` folder is a static site that can be hosted anywhere (GitHub Pages, Netlify, an internal server). It must be served over `http://` or `https://`, not opened as a local `index.html`.

**Install as a Windows app**: open the site in Chrome or Edge and click **Install** in the address bar. The installed app works offline after first use (except the AI assistant) and appears in "Open with" for the supported file types.

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
tests/        smoke and format tests, fixture generators, fixtures/
```
To add a format, add an entry to `src/formats/registry.js` (extensions, category, `open()` or an unsupported `hint`) and list openable extensions in `public/manifest.webmanifest` (a test checks they match). The `3d` category is reserved for 3D models.

### Known limitations
SHX fonts are substituted with Arial; 3D solids, raster images and xrefs inside DWG/DXF are not drawn; DWG support depends on LibreDWG, so unusual files may open incomplete (saving as DXF is a workaround). DGN V8 needs an export from MicroStation; DGN dimensions, tags and shared cells are not drawn and 3D DGN files are shown in plan (top) view. HP-GL files with PostScript or raster (PCL) content show only their HP-GL vectors. Very large TIFF scans (over ~48 megapixels) are displayed at reduced resolution; measurements still use the original pixel size.

### License
GPL-3.0, because DWG reading uses LibreDWG (`@mlightcad/libredwg-web`, GPL-3.0). TIFF decoding uses [UTIF.js](https://github.com/photopea/UTIF.js) (`utif2`, MIT). The test fixtures `smalltest.dgn` and `test_dgnv8.dgn` come from GDAL's autotest data (MIT/X licence).

---

## العربية

ProtoCAD Viewer عارض ذكي للرسومات الهندسية يشتغل من المتصفح على أي جهاز (ويندوز، ماك، موبايل) ويتثبت كبرنامج على سطح المكتب. **واجهة البرنامج باللغة الإنجليزية**، لكن النصوص العربية داخل الرسومات وملفات PDF بتتعرض وتتطبع بشكل صحيح، والمساعد الذكي بيرد بالعربي لو سألته بالعربي.

### الملفات المدعومة
- **رسومات**: DWG (من R14 حتى 2018 وما بعدها) وملفات DWT (القوالب) و DWS (المعايير)، و DXF، و **DGN V7** من MicroStation (ثنائي وثلاثي الأبعاد)، وملفات البلوت **HP-GL / HP-GL/2** (`.plt` و `.hpgl` و `.hgl` و `.hp2` و `.pen`) حتى لو كانت داخل ملف طباعة PCL.
- **مستندات**: PDF.
- **صور**: PNG و JPG و GIF و BMP و WebP و SVG و TIFF (متعدد الصفحات، ومنها ملفات الاسكانر المضغوطة CCITT G4).
- صيغ معروفة لا يمكن فتحها في المتصفح (Revit و Navisworks و SolidWorks و Inventor و CATIA و NX و SketchUp و DWF و AVEVA و DGN V8): البرنامج بيظهر رسالة توضح تصدّرها لأي صيغة (مثلاً Revit إلى IFC أو DWG، و DGN V8 إلى DWG أو DXF).

في ملفات DGN: المستويات (Levels) بتظهر كطبقات باسم "Level n"، والـ Cells بتظهر كبلوكات وبتتحسب في حصر الكميات (BOM). في ملفات البلوت: كل قلم (Pen) طبقة باسم "PEN n" والوحدات بالمليمتر.

### المميزات
- الملفات تُفتح على جهازك ولا تُرفع لأي خادم. تكبير وتصغير بعجلة الماوس، سحب للتحريك، لمس بإصبعين على الموبايل، `F` لعرض الرسمة كاملة، وتكبير منطقة محددة.
- الطبقات (Layers): إظهار/إخفاء، نقرتين لعزل طبقة، ألوان الطبقات وعدد العناصر. مساحة الـ Model والـ Layouts مع عرض محتوى الـ Viewports.
- **القياس**: مسافة (مع ΔX و ΔY والزاوية)، طول مسار، ومساحة ومحيط، مع التقاط (Snap) للنهايات والمنتصف والمراكز. في ملفات PDF القياس بالمليمتر على الورق، وفي الصور بالبكسل، و**معايرة المقياس** بنقطتين معروفتين تحوّل القياس للمتر الحقيقي (مفيدة جداً للرسومات الممسوحة بالاسكانر).
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

**تثبيته كبرنامج على ويندوز**: افتح الموقع في Chrome أو Edge واضغط **Install** من شريط العنوان. بعد أول استخدام يشتغل بدون إنترنت (ما عدا المساعد الذكي)، وتقدر تفتح منه كل الصيغ المدعومة من "Open with".

**تفعيل المساعد الذكي**: اعمل مفتاح API من [console.anthropic.com](https://console.anthropic.com)، وحطه من **Settings** في البرنامج. المفتاح يتحفظ في المتصفح ده بس، والطلبات بتروح مباشرة من جهازك لـ Anthropic، واستهلاك الـ API بيتحسب على حسابك.

### حدود معروفة
- خطوط SHX بتتعرض بخط Arial، والمجسمات ثلاثية الأبعاد والصور المرتبطة والـ Xrefs داخل DWG مش بتتعرض.
- ملفات DGN V8 محتاجة تصدير من MicroStation، والأبعاد (Dimensions) والـ Tags في DGN مش بتتعرض، وملفات DGN ثلاثية الأبعاد بتتعرض من أعلى (Plan).
- ملفات TIFF الضخمة جداً (أكبر من حوالي 48 ميجا بكسل) بتتعرض بدقة أقل، لكن القياس بيفضل بأبعاد البكسل الأصلية.

### الترخيص
البرنامج مرخص **GPL-3.0** لأنه بيستخدم LibreDWG. قراءة TIFF عن طريق UTIF.js (رخصة MIT)، وملفات اختبار DGN من GDAL (رخصة MIT/X).
