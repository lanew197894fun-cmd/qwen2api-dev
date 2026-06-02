' Launch start.bat as admin — Windows Terminal if available, else cmd.exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set UAC = CreateObject("Shell.Application")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' --- Find Windows Terminal: bundled → Microsoft Store → PATH ---
wt = ""

' 1. Bundled portable version
bundled = dir & "\terminal\terminal-1.24.11321.0\WindowsTerminal.exe"
If fso.FileExists(bundled) Then wt = bundled

' 2. Microsoft Store install
If wt = "" Then
  store = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\WindowsApps\wt.exe"
  If fso.FileExists(store) Then wt = store
End If

' 3. where.exe lookup
If wt = "" Then
  On Error Resume Next
  out = shell.Exec("%COMSPEC% /c where wt.exe 2>nul").StdOut.ReadAll()
  If Trim(out) <> "" Then
    lines = Split(out, vbCrLf)
    If fso.FileExists(Trim(lines(0))) Then wt = Trim(lines(0))
  End If
  On Error Goto 0
End If

' --- Launch ---
If wt <> "" Then
  UAC.ShellExecute wt, "-d """ & dir & """ cmd /c start.bat", dir, "runas", 1
Else
  UAC.ShellExecute "cmd.exe", "/K ""cd /d " & dir & " && call start.bat""", dir, "runas", 1
End If
