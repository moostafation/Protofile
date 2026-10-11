# PlantForge Studio

**برنامج تصميم مصانع وأنابيب تفاعلي ثلاثي الأبعاد، شغّال في المتصفح، على طريقة SP3D و E3D.**

ملف واحد (`release/plantforge-studio.html`). افتحه في أي متصفح حديث، ومحتاج إنترنت بس عشان الخطوط.
وفيه [قاعدة بيانات للمصنع زي SP3D](#قاعدة-البيانات-plant-database-زي-sp3d): كتالوج، و Approval، و Transactions، و SQL، وشغل جماعي لايف.

![](../docs/img/studio.png)

## المميزات

| | |
|---|---|
| **رسم المواسير بالماوس** | ابدأ من نوزل أو من طرف خط مفتوح، وحرّك على المحور. الماسورة والأكواع والفلانشات بتظهر قدامك لحظياً من الـ Spec، مع Snap كل 50 mm ومحاذاة مع النوزلات. ممكن كمان تكتب `E 2000` أو `U 1500` |
| **Auto-routing** | اختار نوزلين، والبرنامج يدوّر على أحسن مسار: من غير Clash، ومفضّل الـ Pipe rack، وبيتجنب الخطوط الطويلة على مستوى الرأس. بيقيّم مئات المسارات المحتملة ويختار الأفضل |
| **معدات بارامترية** | طلمبة، Vertical vessel، Horizontal drum، مبادل حراري، تانك. بتعدّل المقاسات والنوزلات (مقاس، ارتفاع، اتجاه، بروز) من الـ Properties |
| **تحريك بالـ Gizmo** | الخطوط المتوصلة بتتمط مع المعدة وهي بتتحرك (Stretch زي E3D)، والـ Legs بتفضل متعامدة |
| **Pipe racks + Shoes تلقائي** | الـ Rack بيتعمل بارامترياً، وأي ماسورة ماشية عليه بياخد Shoe عند كل Frame لوحده |
| **بلوف و Tees** | Gate و Globe و Check بالـ Hover والضغط على الماسورة. والـ Tee بيبدأ رسم الفرع على طول |
| **Clash لحظي** | GJK على كل القطع والمعدات والحديد، وفيه Clearance اختياري. الـ Clashes بتظهر في الموديل وفي قائمة، وتقدر تعمل Zoom عليها |
| **To-Do list** | أخطاء الـ Routing، والأطراف المفتوحة، واختلاف المقاسات، والمواسير القصيرة. ولكل خطأ زرار Re-route |
| **أيزومتريك فوري** | لأي خط: أبعاد حقيقية، و BOM، ولحامات، و Shoes، وملاحظات الاتصال. تنزيل SVG و DXF |
| **MTO و Line list** | بيتحدّثوا لحظياً، ومعاهم عدد اللحامات والـ Inch-dia |
| **مساعد ذكاء اصطناعي** | اكتب له بالعربي أو الإنجليزي، زي: "ضيف طلمبة احتياطي ووصّلها". هو بيحط المعدات ويوصّل ويضيف البلوف ويعمل Clash check، وكل خطوة ليها Undo |
| **حفظ وتصدير** | حفظ في حسابك على Claude، وحفظ تلقائي في المتصفح. وتصدير Zip فيه PCF و DXF و SVG و MTO و JSON و TOML (لملفات IFC عن طريق محرك Python) |
| **Command line** | `HELP` · `CONNECT A/N1 B/N2` · `NEW PUMP AT E 0 N 0` · `MOVE P-101A E 500` · `REROUTE` · `ISO` · `CLASH 50` |
| **مراجعة** | View cube، و Plan و Elevations، و Section box، و Measure، و Labels، و Undo/Redo بلا حدود |

## قاعدة البيانات (Plant Database) زي SP3D

البرنامج دلوقتي شغّال على **قاعدة بيانات SQLite حقيقية** جوه المتصفح (sql.js). كل حاجة في المصنع متخزنة فيها:
الكتالوج، والـ Specs، والمعدات والخطوط بالـ Metadata بتاعتها، وجداول التقارير، وسجل كل التعديلات.
وتقدر تفتح ملف الـ `.sqlite` بأي أداة SQL (DB Browser، DBeaver، Python، Power BI).

![](../docs/img/studio_db.png)

| | |
|---|---|
| **Catalog DB** | جداول `cat_pipe` و `cat_pipe_wall` و `cat_fitting` و `cat_flange` و `cat_valve`. بتعدّل أي رقم من الجريد، والبرنامج يعمل Re-route لكل الخطوط على طول، ويطلّع للـ To-Do أي خط مبقاش راكب |
| **Specs** | `spec` و `spec_pipe` و `spec_part` و `spec_valve` جوه نفس الداتابيز |
| **Bulkload** | زي Excel bulkload في SP3D: صدّر أي جدول CSV، عدّله في Excel، ورجّعه بـ Merge (إضافة وتعديل) أو Replace. ولو الأرقام الجديدة بايظة، الجدول بيرجع زي ما كان |
| **Model DB** | كل Object ليه OID، و Type، و System، و Permission group، و Approval status، و Revision، و Created by / Modified by مع الوقت |
| **Approval workflow** | Working ← In Review ← Approved / Rejected. الـ Object الـ Approved بيتقفل: أي تحريك أو Re-route أو مسح بيترفض لحد ما Editor يرجّعه Working. والـ Approve نفسه للـ Editors بس |
| **System hierarchy** | Area ← Unit ← Systems في الـ Explorer، وتقدر تضيف Systems وتنقل الـ Objects بينها |
| **Transactions** | كل تعديل بيتسجل: مين، وإمتى، وعمل إيه، وأنهي Objects اتأثرت (Audit trail) |
| **SQL & Reports** | كونسول SQL (قراءة بس) و 15 تقرير جاهز: Line list، و Equipment list، و Nozzle schedule، و Valve list، و MTO، و Weld summary، و Clash report، و Approval status، و Audit trail وغيرهم. وكل تقرير يتصدّر CSV، أو كلهم مرة واحدة في Zip |
| **Backup / Restore** | نسخة `.sqlite` كاملة في Zip، وترجّعها في أي وقت. والداتابيز بتتحفظ لوحدها في المتصفح |
| **Color by status** | تلوين الموديل حسب حالة الاعتماد: رمادي Working، وبرتقالي In Review، وأخضر Approved، وأحمر Rejected |

![](../docs/img/studio_db_objects.png)

### Shared plant: كذا مهندس على نفس المصنع في نفس الوقت

زي الـ Model database المركزية في SP3D. من **Projects ← Shared plants** تعمل Share للمصنع، وأي حد عنده الصفحة يفتحه ويشتغل عليه معاك:

- **مزامنة لايف:** أي حاجة زميلك يعملها تظهر عندك على طول، ومعاها Toast باسمه وبالتعديل اللي عمله.
- **من غير ما حد يمسح شغل التاني:** كل Transaction بتعمل Lease على الـ Objects اللي بتغيّرها، وبتتأكد إن محدش عدّلهم من آخر مرة شافتهم.
  لو حصل تعارض، التعديل بتاعك ما بيتحفظش، والبرنامج يعرضلك نسخة زميلك ويقولك تعيد تعديلك. ما فيش Overwrite من غير ما تحس.
- **صلاحيات:** الـ Editors بس يقدروا يغيّروا الكتالوج المشترك، والـ Viewers بيشوفوا من غير ما يعدّلوا. والـ Approval بيمشي على الكل.
- **Ids فريدة لكل جلسة:** اتنين بيضيفوا معدات في نفس اللحظة، فمش ممكن يحصل تصادم في الـ Ids.
- الداتابيز بتخزن الـ User ids بس، والأسامي بتتجاب وقت العرض.

> قفل الـ Approved وقفل الـ Lease بيطبّقهم البرنامج نفسه (Cooperative)، والسيرفر بيطبّق بس صلاحية تعديل الكتالوج.
> يعني لو حد كتب في الداتابيز بأداة تانية غير البرنامج، القفلين دول مش هيمنعوه.

## التشغيل من الكود

```bash
cd plantforge/studio
npm install
npm run dev        # تطوير على http://localhost:5173
npm test           # 28 اختبار للمحرك وقاعدة البيانات
npm run build      # dist/plantforge-studio.html (ملف واحد) + dist/artifact.html
```

## المعمارية

```
src/engine/    المحرك (TypeScript، مش مربوط بأي واجهة)
  catalog, spec      بيقروا نفس ملفات JSON و TOML بتاعة محرك Python
  routing, parts     Routing من الـ Spec، ونفس نتائج محرك Python (متراجعة مقابل ملفات PCF)
  equipment, structure, compute, connectivity, clash (GJK), autoroute, commands
  mto, pcf, iso, drawing (SVG/DXF), exportToml
  meta               Status و Revision و Who/When لكل Object، وقفل الـ Approved
src/db/        قاعدة البيانات
  schema             جداول SQLite و Views و التقارير الجاهزة
  PlantDB            حفظ وقراءة الموديل والكتالوج، و SQL، و Bulkload، و Backup
  service            ربط الداتابيز بالبرنامج (كل Transaction بتتسجل)
  shared             المصنع المشترك: مزامنة لايف، و Leases، و Version check
src/viewer/    three.js: المشهد، والأدوات (Route، Insert، Move، Place، Measure)، والـ View cube
src/app/       React: الواجهة، والـ Command line، والـ Store (Undo/Redo)
src/assistant/ أدوات المساعد الذكي
```

ملفات الكتالوج والـ Spec واحدة للمحركين (`plantforge/plantforge/data` و `specs`). يعني أي تعديل في الـ Spec بيظهر في الاتنين.
