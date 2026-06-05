' start.vbs — 以系統管理員權限啟動 qwen2api-dev（隱藏視窗）
' 雙擊此檔案即可，UAC 確認後會在背景執行，不顯示終端機輸出
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Shell.Application")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = dir & "\start.bat"
' 0 = SW_HIDE (隱藏視窗), 1 = SW_SHOWNORMAL
shell.ShellExecute "cmd.exe", "/C \"" & bat & "\"", dir, "runas", 0

