Option Explicit

Dim shell, nodePath, tsxPath, startupPath, logPath, command, exitCode

If WScript.Arguments.Count <> 4 Then
    WScript.Quit 2
End If

nodePath = WScript.Arguments(0)
tsxPath = WScript.Arguments(1)
startupPath = WScript.Arguments(2)
logPath = WScript.Arguments(3)
command = Quote(nodePath) & " " & Quote(tsxPath) & " " & Quote(startupPath) & " --log-path " & Quote(logPath)

Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
