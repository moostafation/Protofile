# ProtoCAD Viewer

عارض ذكي لملفات أوتوكاد (DWG / DXF) وملفات PDF، يشتغل من المتصفح على أي جهاز (ويندوز، ماك، موبايل) ويتثبت كبرنامج على سطح المكتب.

A smart viewer for AutoCAD drawings (DWG / DXF) and PDF files that runs in the browser and can be installed as a desktop app. English section below.

---

## المميزات

**عرض الرسومات**
- فتح ملفات **DWG** (من R14 حتى 2018 وما بعدها) و **DXF** و **PDF** — الملفات تُفتح على جهازك ولا تُرفع لأي خادم.
- تكبير وتصغير بعجلة الماوس، سحب للتحريك، لمس بإصبعين على الموبايل، `F` لعرض الرسمة كاملة، وتكبير منطقة محددة.
- الطبقات (Layers): إظهار/إخفاء، نقرتين لعزل طبقة، ألوان الطبقات وعدد العناصر.
- مساحة الـ Model والـ Layouts مع عرض محتوى الـ Viewports.
- الخطوط، البوليلاين، الأقواس، الدواير، القطع الناقص، Splines، النصوص و MTEXT، البلوكات والـ Attributes، الأبعاد، التهشير (Solid و Pattern)، Leaders و MLeaders، الجداول، Wipeouts، أنواع الخطوط المتقطعة وسُمك الخطوط.
- خلفية داكنة أو فاتحة أو أبيض وأسود.

**القياس**
- مسافة (مع ΔX و ΔY والزاوية)، طول مسار، ومساحة ومحيط.
- التقاط (Snap) لنهايات الخطوط ومنتصفها ومراكز الدواير.
- في ملفات PDF: القياس بالمليمتر على الورق، أو **معايرة المقياس** بنقطتين معروفتين للقياس بالمتر الحقيقي.

**الطباعة وتصدير PDF**
- تصدير **PDF متجه (Vector)** بجودة طباعة: مقاسات A4 حتى A0 و ANSI، طولي/عرضي، الرسمة كاملة أو العرض الحالي أو نافذة تحددها، مقياس حقيقي (1:50، 1:100…) أو ملائمة للورقة، ملون أو أسود أو رمادي، وسُمك الخطوط.
- شريط عنوان اختياري (اسم الملف، المقياس، التاريخ) ومعاينة قبل الطباعة.
- النصوص العربية تُطبع بشكل صحيح.
- طباعة ملفات PDF الأصلية مباشرة.

**الذكاء**
- **بحث ذكي** عن أي نص أو تاج أو اسم بلوك أو قيمة Attribute أو طبقة، والنقر على النتيجة يكبّر عليها.
- **حصر البلوكات (BOM)** تلقائياً مع الأعداد وقيم الـ Attributes (مثل المقاسات)، وتصدير CSV يفتح في Excel.
- **أطوال الخطوط لكل طبقة** (مفيدة لحصر أطوال المواسير والدكت) وتصديرها CSV.
- **المساعد الذكي (Claude)**: اسأله بالعربي أو الإنجليزي عن الرسمة أو ملف الـ PDF — يلخص، يعمل جدول كميات، يراجع التاجات المكررة أو الناقصة، ويشرح الجزء الظاهر على الشاشة (يقدر يشوف صورة العرض الحالي). المساعد يقدر **يبحث في الرسمة، يعمل zoom على العناصر، ويخفي ويظهر الطبقات بنفسه**، والأرقام مثل `#12` في ردوده تكبّر على العنصر عند النقر.

## التشغيل

محتاج [Node.js](https://nodejs.org) إصدار 20 أو أحدث.

```bash
cd cad-viewer
npm install
npm run dev      # للتطوير: افتح الرابط اللي يظهر (http://localhost:5173)
npm run build    # نسخة نهائية في مجلد dist
npm run preview  # تشغيل النسخة النهائية محلياً
npm test         # اختبار سريع لقراءة ملف DXF التجريبي
```

مجلد `dist` بعد البناء موقع ثابت (Static) تقدر ترفعه على أي استضافة (GitHub Pages أو Netlify أو سيرفر الشركة). لازم يتفتح عن طريق `http://` أو `https://` وليس بفتح `index.html` مباشرة من الجهاز.

### تثبيته كبرنامج على ويندوز
افتح الموقع في Chrome أو Edge، ومن شريط العنوان اضغط **تثبيت (Install)**. بعد التثبيت يظهر كبرنامج مستقل، وبعد أول استخدام يقدر يشتغل بدون إنترنت (ما عدا المساعد الذكي)، وتقدر تفتح منه ملفات DWG و DXF و PDF مباشرة من "Open with".

### تفعيل المساعد الذكي
1. اعمل مفتاح API من [console.anthropic.com](https://console.anthropic.com).
2. من **الإعدادات** في البرنامج حط المفتاح، واختار الموديل (الافتراضي Claude Opus 5.5) ومستوى التفكير.

المفتاح يتحفظ في المتصفح ده بس، والطلبات بتروح مباشرة من جهازك لـ Anthropic. اللي بيتبعت هو ملخص الرسمة (الطبقات، البلوكات وأعدادها، النصوص) وصورة العرض الحالي لو الاختيار مفعل. استهلاك الـ API بيتحسب على حسابك.

## حدود معروفة
- خطوط SHX الخاصة بأوتوكاد بتتعرض بخط Arial، فشكل الحروف ممكن يختلف شوية.
- المجسمات ثلاثية الأبعاد (3DSOLID) والصور المرتبطة (Raster images) والـ Xrefs مش بتتعرض (الصور بتظهر كإطار).
- قراءة DWG معتمدة على مكتبة LibreDWG مفتوحة المصدر؛ بعض الملفات المعقدة جداً ممكن تتفتح ناقصة. لو ملف ما اتفتحش، احفظه DXF من أوتوكاد.

## الترخيص
البرنامج بيستخدم [LibreDWG](https://www.gnu.org/software/libredwg/) عن طريق `@mlightcad/libredwg-web` وهي مرخصة GPL-3.0، عشان كده البرنامج نفسه مرخص **GPL-3.0**.

---

## English

### Features
- Open **DWG** (R14 to 2018+), **DXF** and **PDF** files locally in the browser; nothing is uploaded.
- Pan/zoom (mouse, wheel, touch), zoom extents / window, layers panel (toggle, isolate), model space and layouts with viewports.
- Renders lines, polylines (bulges, widths), arcs, circles, ellipses, splines, TEXT/MTEXT, blocks with attributes, dimensions, solid and pattern hatches, leaders, multileaders, tables, wipeouts, linetypes and lineweights.
- Measure distance, path length and area with endpoint/midpoint/center snapping; PDF scale calibration.
- **Print / export vector PDF**: paper sizes A4–A0 and ANSI, orientation, plot area (extents, view, window), true scale (1:N) or fit, color/monochrome/grayscale, lineweights, title strip, live preview. Arabic and other non-Latin text plots correctly.
- **Smart tools**: search texts, tags, block names, attribute values and layers; automatic block BOM with attribute breakdown (CSV export); linework length per layer (CSV export).
- **AI assistant (Claude)**: ask questions in Arabic or English about the drawing or PDF. It receives a structured summary of the drawing (and optionally an image of the current view) and can search, zoom to and highlight items, and show/hide layers through tool calls.
- Installable PWA (works offline after first use, except the AI assistant) with OS file handling for `.dwg`, `.dxf` and `.pdf`.

### Run
```bash
npm install
npm run dev      # development server
npm run build    # production build in dist/
npm test         # parser/scene smoke test
```

### Project layout
```
src/
  cad/        DXF parser, DWG loading (LibreDWG WebAssembly in a worker), drawing model, tessellation into primitives
  render/     canvas renderer, interactive viewer, vector PDF export (jsPDF)
  pdf/        PDF viewing, text extraction and search (pdf.js)
  tools/      picking and snapping index, measure/select/window tools, analysis (search, BOM, summaries)
  ai/         Claude assistant with tool use
  ui/         icons and markdown rendering
tests/        smoke test and the script that generates the sample drawing
```

### Known limitations
SHX fonts are substituted with Arial; 3D solids, raster images and xrefs are not drawn; DWG support depends on LibreDWG, so unusual files may open incomplete (saving as DXF is a workaround).

### License
GPL-3.0, because DWG reading uses LibreDWG (`@mlightcad/libredwg-web`, GPL-3.0).
