# PlantForge Studio: نسخة Desktop

نفس البرنامج اللي في المتصفح (الواجهة، و 3D، ولغة الأوامر، وقاعدة البيانات)، بس **برنامج بيتسطب على الجهاز**:

- **ملف المصنع على جهازك:** كل مصنع ملف `.pfdb` واحد، وده **SQLite 3 عادي**، يعني تقدر تفتحه بأي أداة SQL.
- **شغال Offline بالكامل:** مفيش ولا طلب بيروح للإنترنت، حتى الخطوط جوه البرنامج.
- **زي أي برنامج Windows:**
  - قوايم File و Edit و View و Tools و Help، وفيها Recent files.
  - دبل كليك على ملف `.pfdb` بيفتحه.
  - اسم الملف في الـ Title bar، وعلامة `*` لو فيه تعديل مش محفوظ.
  - سؤال "Save changes?" قبل ما تقفل.

![](img/studio.png)

## التحميل والتثبيت (Windows)

1. ادخل على الـ Repository في GitHub، وبعدين **Actions** ← **Desktop app** ← آخر Run عليه علامة ✓ خضرا.
2. من **Artifacts** نزّل **PlantForge-Studio-Windows**، وفك الـ zip. هتلاقي جواه ملفين:

| الملف | الاستخدام |
|---|---|
| `PlantForge-Studio-0.3.0-Setup.exe` | **Installer:** بيسطّب البرنامج، ويعمل اختصار على الـ Desktop وفي الـ Start menu، ويربط ملفات `.pfdb` بالبرنامج. تقدر تختار مكان التثبيت، ومش محتاج Admin. |
| `PlantForge-Studio-0.3.0-Portable.exe` | **من غير تثبيت:** ملف واحد يشتغل على طول، ينفع من فلاشة. |

> **تحذير Windows SmartScreen:** البرنامج لسه مش موقّع بشهادة (Code signing)، فـ Windows ممكن يقول "Windows protected your PC".
> اضغط **More info** وبعدين **Run anyway**.

**Linux:** نفس الخطوات، بس نزّل **PlantForge-Studio-Linux**. جواه `.AppImage` تشغّله على طول، و `.deb` لـ Ubuntu و Debian.

## ملف المصنع (`.pfdb`)

| | |
|---|---|
| **إيه اللي جواه** | المصنع كله: الكتالوج، والـ Specs، والمعدات، والخطوط، والـ Approvals، وسجل كل Transaction، وجداول التقارير. |
| **Save** `Ctrl+S` | بيحفظ في نفس الملف. أول مرة للمصنع الجديد بيسألك تحفظه فين. |
| **Save as** `Ctrl+Shift+S` | نسخة جديدة باسم تاني، والبرنامج بيكمّل شغل عليها. |
| **Open** `Ctrl+O` | بيفتح `.pfdb` أو أي `.sqlite`/`.db` من البرنامج. وكمان بيفتح Backup `.zip` أو موديل `.json` كمصنع جديد مش محفوظ. |
| **نسخة احتياطية `.bak`** | أول مرة تحفظ على ملف في أي جلسة، البرنامج بيحتفظ بالنسخة اللي كانت قبلها باسم `اسم-الملف.pfdb.bak`، زي AutoCAD. |
| **Save automatically** | من قايمة File. لو شغّلته، أي تعديل بيتحفظ في الملف لوحده بعد ثانية ونص، زي SP3D. |
| **لو البرنامج وقع أو الكهربا قطعت** | البرنامج بيحتفظ بنسخة شغل (Working copy) طول الوقت. أول ما تفتحه تاني بيرجّع التعديلات اللي ماتحفظتش، ويقولك "Recovered the unsaved changes". |
| **لو قفلت واخترت Don't save** | المرة الجاية الملف بيتفتح زي ما هو محفوظ على الهارد، والتعديلات بتتلغي فعلاً. |
| **سحب وإفلات** | اسحب ملف `.pfdb` على شباك البرنامج يفتحه. |

**لما تفتح البرنامج:**
- لو فتحته بدبل كليك على ملف، بيفتح الملف ده.
- لو فتحته من الاختصار، بيرجّع آخر مصنع كنت شغال عليه، ولو الملف اتغير على الهارد بيقراه من جديد.
- أول مرة خالص بيفتح الـ Demo unit.

## القوايم

| القايمة | فيها |
|---|---|
| **File** | New plant `Ctrl+N`، و Open `Ctrl+O`، و Open recent، و Demo unit، و Save، و Save as، و Save automatically. وفيها كمان Export (Fabrication package فيه PCF وأيزومتريك و MTO، و MTO CSV، وكل التقارير، و JSON، و IFC، وصورة PNG، و Backup للداتابيز)، و Show in folder. |
| **Edit** | Undo `Ctrl+Z`، و Redo `Ctrl+Y`، و Cut و Copy و Paste، و Delete، و Select none `Esc`. |
| **View** | Fit all `F`، وكل الـ Views (Iso، و Plan، و Elevations)، و Show all، و Labels، و Color by status/line، و Section off، و Zoom، و Full screen `F11`. |
| **Tools** | Command window `Ctrl+L`، و Database manager `Ctrl+D`، و Check، و Clash، و Free nozzles. |
| **Help** | الأوامر `F1`، و About. |

> أوامر القوايم بتشتغل بلغة أوامر البرنامج نفسها: لما تختار View ← Plan، بيظهر `view plan` في الـ Command Window، فتتعلم الأمر وانت بتستخدم القوايم.

## الفرق عن نسخة المتصفح

| | المتصفح / Claude | Desktop |
|---|---|---|
| مكان الحفظ | المتصفح، وحسابك على Claude | ملف `.pfdb` على جهازك أو على Shared drive |
| الإنترنت | محتاجه | مش محتاجه خالص |
| المستخدم في الـ Approvals | حساب Claude | اسم المستخدم بتاع Windows |
| Shared plant لايف و AI Assistant | موجودين | مش في النسخة دي، لأنهم محتاجين سيرفر Claude |

## الأمان

- الواجهة شغالة من غير Node.js ومن غير وصول للملفات. الحاجات الوحيدة اللي تقدر تطلبها: فتح وحفظ عن طريق نوافذ Windows العادية، والـ Title، ورسائل التأكيد.
- كل الطلبات للإنترنت ممنوعة، ومعاها Content Security Policy.
- الحفظ آمن: الملف بيتكتب جنب الأصلي الأول، وبعدين بيتبدّل بيه، فلو حصل قطع في النص الملف القديم مش بيبوظ.

## البناء من الكود

```bash
cd plantforge/studio  && npm install          # الواجهة
cd ../desktop         && npm install          # Electron و electron-builder
npm run dev        # يبني الواجهة ويفتح البرنامج
npm run dist:win   # Installer و Portable لـ Windows، في desktop/dist (لازم يتعمل على Windows)
npm run dist:linux # AppImage و .deb
npm run dist:mac   # .dmg (لازم يتعمل على Mac)
```

- **GitHub Actions** (`.github/workflows/desktop.yml`) بيبني Windows و Linux أوتوماتيك مع كل تعديل في `plantforge/studio` أو `plantforge/desktop`، ويرفع الملفات كـ Artifacts.
- لو عملت Tag زي `desktop-v0.3.0` وعملتله Push، الـ Workflow بيعمل كمان **GitHub Release** فيه ملفات التثبيت.

**الملفات:**
```
desktop/main.cjs     البرنامج: الشباك، والقوايم، والملفات، و Recent، ونسخة واحدة شغالة، والسؤال قبل القفل
desktop/preload.cjs  الجسر بين الواجهة والبرنامج (أقل صلاحيات)
desktop/build/       الأيقونة (svg و png و ico)
studio/src/platform/desktop.ts   نوع الجسر
studio/src/app/desktopShell.ts   فتح وحفظ الملفات، والـ Title، والـ Recovery، والـ Auto-save، وأوامر القوايم
```
