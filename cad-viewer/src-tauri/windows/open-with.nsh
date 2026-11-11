; ProtoCAD Viewer NSIS installer hooks (tauri.conf.json > bundle > windows > nsis > installerHooks).
;
; CAD drawings (DWG, DXF, DGN, PLT...) are associated through tauri.conf.json `fileAssociations`.
; PDFs, images and 3D mesh formats (STL, OBJ, glTF, FBX, DAE, PLY, 3MF, BREP; Windows 3D Viewer,
; Paint 3D or a 3D program usually owns them) are only offered under "Open with": a ProgID per type, listed in the type's
; OpenWithProgids and in Applications\<exe>\SupportedTypes. The `.ext` default value is never
; written, so the user's default PDF viewer and image apps stay as they are. Installing over a
; version that did take the default gives it back (from the backup that version kept).
; tests/formats.test.mjs checks that these lists match the format registry.

!macro PROTOCAD_PROGID PROGID DESC
  WriteRegStr SHCTX "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro PROTOCAD_OPEN_WITH EXT PROGID
  Push $R0
  Push $R1
  Push $R2
  ; An earlier version made itself the default app for this type: restore the previous default.
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $R0 == "${PROGID}"
    ReadRegStr $R1 SHCTX "Software\Classes\.${EXT}" "${PROGID}_backup"
    ; A backup that is itself a ProtoCAD class (left by an earlier update) is no real previous default.
    StrCpy $R2 $R1 9
    ${If} $R1 == ""
    ${OrIf} $R2 == "ProtoCAD."
      DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
    ${Else}
      WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "$R1"
    ${EndIf}
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${PROGID}_backup"
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro PROTOCAD_REMOVE_OPEN_WITH EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PROTOCAD_PROGID "ProtoCAD.PDF" "PDF document"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.PNG" "PNG image"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.JPEG" "JPEG image"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.GIF" "GIF image"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.BMP" "BMP image"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.WEBP" "WebP image"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.SVG" "SVG image"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.TIFF" "TIFF image"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.BREP" "BREP 3D model"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.STL" "STL 3D model"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.OBJ" "OBJ 3D model"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.GLTF" "glTF 3D model"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.FBX" "FBX 3D model"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.DAE" "COLLADA 3D model"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.PLY" "PLY 3D model"
  !insertmacro PROTOCAD_PROGID "ProtoCAD.3MF" "3MF 3D model"
  !insertmacro PROTOCAD_OPEN_WITH "pdf" "ProtoCAD.PDF"
  !insertmacro PROTOCAD_OPEN_WITH "png" "ProtoCAD.PNG"
  !insertmacro PROTOCAD_OPEN_WITH "jpg" "ProtoCAD.JPEG"
  !insertmacro PROTOCAD_OPEN_WITH "jpeg" "ProtoCAD.JPEG"
  !insertmacro PROTOCAD_OPEN_WITH "gif" "ProtoCAD.GIF"
  !insertmacro PROTOCAD_OPEN_WITH "bmp" "ProtoCAD.BMP"
  !insertmacro PROTOCAD_OPEN_WITH "webp" "ProtoCAD.WEBP"
  !insertmacro PROTOCAD_OPEN_WITH "svg" "ProtoCAD.SVG"
  !insertmacro PROTOCAD_OPEN_WITH "tif" "ProtoCAD.TIFF"
  !insertmacro PROTOCAD_OPEN_WITH "tiff" "ProtoCAD.TIFF"
  !insertmacro PROTOCAD_OPEN_WITH "brep" "ProtoCAD.BREP"
  !insertmacro PROTOCAD_OPEN_WITH "stl" "ProtoCAD.STL"
  !insertmacro PROTOCAD_OPEN_WITH "obj" "ProtoCAD.OBJ"
  !insertmacro PROTOCAD_OPEN_WITH "gltf" "ProtoCAD.GLTF"
  !insertmacro PROTOCAD_OPEN_WITH "glb" "ProtoCAD.GLTF"
  !insertmacro PROTOCAD_OPEN_WITH "fbx" "ProtoCAD.FBX"
  !insertmacro PROTOCAD_OPEN_WITH "dae" "ProtoCAD.DAE"
  !insertmacro PROTOCAD_OPEN_WITH "ply" "ProtoCAD.PLY"
  !insertmacro PROTOCAD_OPEN_WITH "3mf" "ProtoCAD.3MF"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  ; Tell Explorer the associations changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Updates reinstall right away: keep the entries.
  ${If} $UpdateMode <> 1
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "pdf" "ProtoCAD.PDF"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "png" "ProtoCAD.PNG"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "jpg" "ProtoCAD.JPEG"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "jpeg" "ProtoCAD.JPEG"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "gif" "ProtoCAD.GIF"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "bmp" "ProtoCAD.BMP"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "webp" "ProtoCAD.WEBP"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "svg" "ProtoCAD.SVG"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "tif" "ProtoCAD.TIFF"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "tiff" "ProtoCAD.TIFF"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "brep" "ProtoCAD.BREP"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "stl" "ProtoCAD.STL"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "obj" "ProtoCAD.OBJ"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "gltf" "ProtoCAD.GLTF"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "glb" "ProtoCAD.GLTF"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "fbx" "ProtoCAD.FBX"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "dae" "ProtoCAD.DAE"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "ply" "ProtoCAD.PLY"
    !insertmacro PROTOCAD_REMOVE_OPEN_WITH "3mf" "ProtoCAD.3MF"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.PDF"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.PNG"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.JPEG"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.GIF"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.BMP"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.WEBP"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.SVG"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.TIFF"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.BREP"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.STL"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.OBJ"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.GLTF"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.FBX"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.DAE"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.PLY"
    DeleteRegKey SHCTX "Software\Classes\ProtoCAD.3MF"
    DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
