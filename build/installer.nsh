; ─────────────────────────────────────────────────────────────────────────────
; IDM Lite - Custom NSIS Installer Script
; ─────────────────────────────────────────────────────────────────────────────

; Required headers (safe to include even if already included elsewhere)
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; ── Installer-only code (skip when building the uninstaller) ──────────────────
!ifndef BUILD_UNINSTALLER

Var StartupCheckbox
Var StartupEnabled

Function StartupPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateGroupBox} 0 0 100% 72u "Startup Options / Tùy chọn khởi động"
  Pop $0

  ${NSD_CreateLabel} 12u 16u 76% 20u "How should IDM Lite start after installation?"
  Pop $0

  ${NSD_CreateCheckbox} 12u 42u 80% 12u "Launch IDM Lite with Windows (runs hidden in system tray)"
  Pop $StartupCheckbox
  ${NSD_SetState} $StartupCheckbox ${BST_CHECKED}

  nsDialogs::Show
FunctionEnd

Function StartupPageLeave
  ${NSD_GetState} $StartupCheckbox $StartupEnabled
FunctionEnd

!endif ; BUILD_UNINSTALLER

; ── electron-builder Macros ───────────────────────────────────────────────────

; Force per-user installation, skip the "Just Me / All Users" selection page
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
  StrCpy $isForceMachineInstall "0"
!macroend

; Add our custom startup page right after the Welcome page
!macro customWelcomePage
  !ifndef BUILD_UNINSTALLER
    !insertmacro MUI_PAGE_WELCOME
    Page custom StartupPageCreate StartupPageLeave
  !endif
!macroend

; After installation: auto-uninstall old version + handle startup flag
!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ; ── Auto-remove previous version if it exists ──────────────────────────────
    ; electron-builder stores the uninstaller path in registry under the AppID
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\idmlite" "UninstallString"
    ${If} $R0 != ""
      ; Run previous uninstaller silently, keep install directory (_?=) to avoid deletion race
      ExecWait '"$R0" /S _?=$INSTDIR'
    ${EndIf}
    ; ───────────────────────────────────────────────────────────────────────────

    ; Write startup flag if user opted in
    ${If} $StartupEnabled == ${BST_CHECKED}
      ; Flag file → Electron reads on first launch and registers login item
      CreateDirectory "$APPDATA\IDMLite"
      FileOpen $0 "$APPDATA\IDMLite\startup_requested.flag" w
      FileClose $0
    ${EndIf}
  !endif
!macroend

; On uninstall: remove startup registry entry and leftover flag file
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "IDMLite"
  Delete "$APPDATA\IDMLite\startup_requested.flag"
!macroend
