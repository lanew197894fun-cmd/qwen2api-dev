' start.vbs — 以系統管理員權限啟動 qwen2api-dev
' 雙擊此檔案即可，UAC 確認後會開啟服務視窗
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Shell.Application")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = dir & "\start.bat"
shell.ShellExecute "cmd.exe", "/C """ & bat & """", dir, "runas", 1
