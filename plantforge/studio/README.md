# PlantForge Studio

**برنامج تصميم مصانع وأنابيب تفاعلي ثلاثي الأبعاد، شغّال في المتصفح، على طريقة SP3D و E3D.**

ملف واحد (`release/plantforge-studio.html`). افتحه في أي متصفح حديث، ومحتاج إنترنت بس عشان الخطوط.

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

## التشغيل من الكود

```bash
cd plantforge/studio
npm install
npm run dev        # تطوير على http://localhost:5173
npm test           # 18 اختبار للمحرك
npm run build      # dist/plantforge-studio.html (ملف واحد) + dist/artifact.html
```

## المعمارية

```
src/engine/    المحرك (TypeScript، مش مربوط بأي واجهة)
  catalog, spec      بيقروا نفس ملفات JSON و TOML بتاعة محرك Python
  routing, parts     Routing من الـ Spec، ونفس نتائج محرك Python (متراجعة مقابل ملفات PCF)
  equipment, structure, compute, connectivity, clash (GJK), autoroute, commands
  mto, pcf, iso, drawing (SVG/DXF), exportToml
src/viewer/    three.js: المشهد، والأدوات (Route، Insert، Move، Place، Measure)، والـ View cube
src/app/       React: الواجهة، والـ Command line، والـ Store (Undo/Redo)
src/assistant/ أدوات المساعد الذكي
```

ملفات الكتالوج والـ Spec واحدة للمحركين (`plantforge/plantforge/data` و `specs`). يعني أي تعديل في الـ Spec بيظهر في الاتنين.
