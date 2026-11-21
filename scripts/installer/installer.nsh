!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装东启勘流"
  !define MUI_WELCOMEPAGE_TEXT "${APP_DESCRIPTION}$\r$\n$\r$\n开发单位  ${COMPANY_NAME}"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInit
  ${If} $installMode != "CurrentUser"
    MessageBox MB_OK|MB_ICONSTOP "东启勘流安装包供当前 Windows 用户安装。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Function FundSiftDirectoryPre
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      StrCpy $INSTDIR $0
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE FundSiftDirectoryPre
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

!macro customCheckAppRunning
  InitPluginsDir
  File "/oname=$PLUGINSDIR\fundsift-close-app.ps1" "${BUILD_RESOURCES_DIR}\fundsift-close-app.ps1"
  nsExec::ExecToLog /TIMEOUT=150000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -File "$PLUGINSDIR\fundsift-close-app.ps1" -Executable "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $R0
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONSTOP "东启勘流未能安全退出。请等待正在处理的操作完成，关闭东启勘流后重新运行安装程序。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customFinishPage
  Function FundSiftFinish
    ClearErrors
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    IfErrors 0 +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "东启勘流安装完成，请从开始菜单打开。"
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE FundSiftFinish
  !define MUI_FINISHPAGE_TITLE "东启勘流安装完成"
  !define MUI_FINISHPAGE_TEXT "点击完成以启动东启勘流。"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInstall
  ${If} ${Silent}
    Call FundSiftFinish
  ${EndIf}
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  InitPluginsDir
  File "/oname=$PLUGINSDIR\fundsift-remove-app.ps1" "${BUILD_RESOURCES_DIR}\fundsift-remove-app.ps1"
  File "/oname=$PLUGINSDIR\fundsift-installed-files.json" "$%FUNDSIFT_NSIS_REMOVAL_MANIFEST%"
  nsExec::ExecToLog '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -File "$PLUGINSDIR\fundsift-remove-app.ps1" -Directory "$INSTDIR" -Manifest "$PLUGINSDIR\fundsift-installed-files.json"'
  Pop $R0
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONSTOP "东启勘流的程序文件仍被占用或无法替换。请关闭程序后重试。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  RMDir "$INSTDIR"
!macroend
