# لغة أوامر PlantForge

لغة أوامر خاصة بالبرنامج، مش نسخة من E3D ولا AutoCAD. الأمر بيتكتب **زي جملة**: فعل وبعده الحاجة وبعده التفاصيل.
تقدر تكتبه **بالإنجليزي أو بالعربي**، وتقدر تكتب كذا أمر ورا بعض.

```
add pump P-102 at 5000,3000 rot 90
connect P-101A.N2 to E-101.N1
move pumps north 1m
ضيف طلمبة عند 5000,3000 ثم وصل P-101A.N2 مع E-101.N1
```

## القواعد الأساسية

| | المعنى | مثال |
|---|---|---|
| **العنصر باسمه** | الـ Tag أو رقم الخط، وجزء من رقم الخط كفاية لو مميّز | `P-101A` · `4"-P-1002-A1A` · `P-1002` |
| **النوزل بنقطة** | المعدة.النوزل | `P-101A.N2` · `V-101.N1` |
| **التي والبلف على الخط** | `T1` أول Tee على الخط من البداية، و `V2` تاني بلف | `P-1002.T1` · `P-1002.V2` |
| **`it`** | آخر حاجة اتعملت أو اتلاقت (بالعربي: ده، دي) | `add pump at 0,0 then rotate it 90` |
| **مجموعات** | أنواع كاملة، أو `selection`، أو `all`، أو Wildcard | `pumps` · `lines` · `racks` · `equipment` · `P-10*` · `*-CW-*` |
| **فلتر `where`** | بيفلتر المجموعة اللي قبله على طول | `lines where nps>=6 and spec=A1A` · `equipment where status=approved` |
| **أكتر من عنصر** | بـ `and` أو بفاصلة | `C-201 and D-201` · `P-101A, P-101B` |
| **مكان مطلق** | E,N أو E,N,EL بالـ mm، أو خطوات، أو مكان بالنسبة لعنصر | `at 5000,3000` · `at e5000 n3000` · `at V-101 east 4000` |
| **خطوة / إزاحة** | اتجاه ومسافة | `east 500` · `up 1.5m` · `s200` · `شرق 2000` |
| **وحدات** | mm افتراضي، و m و cm و in و ft، والزوايا بالدرجات | `2.5m` · `90` · `90deg` |
| **مقاس الماسورة** | بعلامة البوصة | `6"` · `1-1/2"` |
| **نص** | بين علامتين | `'Feed pump'` |
| **تسلسل** | `;` أو `then` أو `ثم` | `add pump P-9 at 0,0; rotate it 180` |
| **اسم لوحده** | لو كتبت اسم عنصر بس، البرنامج بيروحله | `C-201` |

## الأوامر

### إنشاء
| الأمر | مثال |
|---|---|
| `add <pump/vessel/column/drum/exchanger/tank> [TAG] [at …] [rot …] [D=… H=…] [x<عدد> [spacing …]]` | `add column C-301 at 45000,-8000 H=24000` · `add pump at V-101 south 6000 x2 spacing 2500 east` |
| `add rack [TAG] at … [along x/y] [length …] [width …] [levels a,b]` | `add rack at 0,-20000 along x length 30m levels 5000,7000` |
| `add nozzle <مقاس> on <معدة> [facing …] [elev …] [top] [station …] [as '…']` | `add nozzle 3" on V-101 facing east elev 4000 as 'Drain'` |
| `add <gate/globe/check> valve on <خط> [at <mm> / mid / near start / near end]` | `add gate valve on P-1002 near start` |
| `add tee on <خط> [at <mm>] [branch <اتجاه>]` | `add tee on P-2004 at 2000 branch up` |
| `add system '<اسم>'` | `add system 'Steam'` |
| `copy <عناصر> [إزاحة / to …] [x<عدد>] [as TAG]` | `copy P-201A east 2500 x3` · `copy V-101 to 20000,15000 as V-102` |

### المواسير
| الأمر | مثال |
|---|---|
| `connect <نوزل/تي> to <نوزل/تي> [size …] [spec …] [as '…']` | `connect P-101A.N2 to E-101.N1` (الراوتر بيلاقي مسار من غير Clash ومفضّل الـ Rack) |
| `route from <نوزل / at مكان> <خطوات…> [to <نوزل> / flanged]` | `route from V-101.N2 down 1500 east 3000 to P-101A.N2` |
| `route` أو `route from <نوزل>` لوحدها | بتبدأ الرسم بالماوس، وبعدها تكتب `east 2000` و `up 1500` و `to E-101.N1` و `finish` |
| `reroute <خطوط / معدة / all>` | `reroute P-101A` (كل الخطوط اللي على الطلمبة) |

### تعديل
| الأمر | مثال |
|---|---|
| `move <عناصر> <إزاحة>` أو `move <عناصر> to <مكان>` | `move P-101A east 500` · `move pumps north 1m` (المواسير بتتمط معاها) |
| `rotate <عناصر> [by] [زاوية]` | `rotate P-102` (90 افتراضي) |
| `set <عناصر> key=value …` | `set P-101A rot=90 desc='Duty pump'` · `set lines where nps>=6 color=blue` · `set pumps system='Feed pumps'` |
| `set <نوزل> …` | `set V-101.N1 nps=6 elev=7500` |
| `rename <عنصر> to <اسم>` | `rename P-102 to P-103` |
| `delete <عناصر>` أو `delete <خط>.V1` | `delete P-102` · `delete P-1002.V2` |

الخصائص اللي تقدر تغيرها:
- **المعدات:** `tag` و `desc` و `rot` و `e` و `n` و `el`، ومقاساتها (`D` و `H` و `skirt` و `L` و `cl` و `shaftZ` و `motorL` …).
- **الخطوط:** `number` و `spec` و `nps` و `fluid` و `color`.
- **الراكات:** `length` و `width` و `bay` و `levels` و `along`.
- **أي عنصر:** `status` و `group` و `system`.

### بحث وعرض
| الأمر | مثال |
|---|---|
| `find <عناصر>` | `find lines where nps>=6` · `find *-CW-*` |
| `select <عناصر>` / `select none` | `select pumps` |
| `zoom [عناصر]` | `zoom C-201` |
| `view iso / iso ne / plan / north …` | `view plan` |
| `hide` / `show` / `isolate` | `isolate C-201 and D-201` · `hide racks` · `show all` |
| `color by status / line` | `color by status` |
| `labels on/off` · `section <عناصر>/off` | `section C-201` |

### فحص وبيانات
| الأمر | مثال |
|---|---|
| `info <عنصر/نوزل>` | `info C-201` · `info V-101.N2` |
| `list <عناصر> [where …]` | `list lines where nps>=6` · `list free nozzles` · `list valves on P-1002` · `list systems` |
| `count …` | `count valves` · `count lines where errors=yes` |
| `measure <أ> to <ب>` | `measure P-101A to P-101B`: المسافة والخلوص بين الاتنين |
| `check` | ملخص: Clashes وأخطاء ونوزلات فاضية وعناصر مش معتمدة |
| `clash [clearance]` | `clash 50` |
| `approve` / `submit` / `reject` / `reopen` | `approve lines where errors=no` |
| `sql SELECT …` | `sql SELECT nps, COUNT(*) FROM line GROUP BY nps` |
| `report <اسم>` | `report valve list` |

### مخرجات وجلسة
| الأمر | مثال |
|---|---|
| `iso <خط>` · `export zip/mto/json/ifc/png/database/reports` · `save` | `export zip P-1002` |
| `undo [n]` · `redo [n]` · `again` · `history` · `clear` · `help [أمر]` | `undo 3` |
| `macro <اسم> <أوامر…>` ثم `<اسم> [قيم]` | `macro pair add pump at $1 x2 spacing 3000 east` ثم `pair 70000,0` |

## بالعربي

كل الأوامر ليها كلمات عربي، مثلاً:
- الأفعال: ضيف، وصل، ارسم، انسخ، حرك، لف، غير/خلي، امسح، دور، اختار، قرب، اخفي، اظهر، اعزل، معلومات، قائمة، كام، قيس، افحص، اعتمد، قدم، ارفض، افتح، صدر، احفظ، تراجع، تاني.
- الأنواع: طلمبة، فيسل، عمود، درم، مبادل، تانك، راك، نوزل، بلف، تي، خط/خطوط.
- الاتجاهات: شرق، غرب، شمال، جنوب، فوق، تحت.
- الكلمات المساعدة: عند (at)، مع/الى/لحد (to)، على (on)، من (from)، و (and)، ثم (then)، ده/دي (it).

```
ضيف طلمبة P-160 عند 56000,6000
حرك P-160 شرق 1000
وصل P-160.N2 مع E-150.N1
اعتمد P-160
```

## المساعدة وأنت بتكتب

- **اقتراحات:** وانت بتكتب بيظهر لك اللي ممكن يجي بعد كده. `Tab` بيكمّل، والأسهم بتختار.
- **الاقتراحات بتفهم السياق:** بعد `connect P-150.N2 to` بيقترح النوزلات الفاضية من نفس المقاس الأول.
- **الـ Syntax:** شكل الأمر بيظهر تحت الاقتراحات.
- **لو كتبت غلط:** البرنامج بيقولك "Did you mean move?" أو "Did you mean P-101A?".
- **`help` و `help <أمر>`:** بيعرضوا الأوامر والتفاصيل والأمثلة.
