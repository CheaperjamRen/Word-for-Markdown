; Keep the application icon and the .md document icon visually distinct.
; Tauri registers the file association before this hook and sets SHCTX to the
; selected install scope, so the same key works for current-user installs.
; Always offer the selector, even when an older installer stored a language.
!ifndef MUI_LANGDLL_ALWAYSSHOW
  !define MUI_LANGDLL_ALWAYSSHOW
!endif

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Markdown Document\DefaultIcon" "" "$INSTDIR\icons\markdown-file.ico,0"
  StrCmp $LANGUAGE "2052" 0 +2
    WriteRegStr HKCU "Software\MarkdownDocumentApp" "InstallerLanguage" "zh-CN"
  StrCmp $LANGUAGE "2052" +2 0
    WriteRegStr HKCU "Software\MarkdownDocumentApp" "InstallerLanguage" "en-US"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\MarkdownDocumentApp"
!macroend
