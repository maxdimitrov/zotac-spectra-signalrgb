# Launch FireStorm elevated under Frida and trace its NvAPI calls.
# Pure ASCII on purpose (PS 5.1).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    exit
}
Get-Process FireStorm -ErrorAction SilentlyContinue | Stop-Process -Force
$py = 'C:\Users\maxa2\AppData\Local\Python\pythoncore-3.14-64\python.exe'
try {
    & $py "$here\trace_firestorm.py" "$here\nvapi_hook.js" "$here\firestorm_trace.log"
} catch {
    Write-Host $_ -ForegroundColor Red
}
Read-Host 'Trace finished. Press Enter to close this window'
