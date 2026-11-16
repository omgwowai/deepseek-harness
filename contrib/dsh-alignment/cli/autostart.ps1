# autostart.ps1 — 对齐页服务的登录自启计划任务(DshAlignmentPage)。当前用户、Limited,不需要管理员。
#   -Action install    注册任务:用户登录时运行本脚本 -Action run(conhost --headless 不闪窗口,不限时)
#   -Action run        (任务调用)3390 空闲就前台跑 align.mjs serve;已是对齐页服务就退出 0;被别的程序占用就记日志、退出 1,不杀进程
#   -Action status     任务状态 + 端口占用进程
#   -Action stop       停任务,并停掉核实过 CommandLine 的对齐页服务进程
#   -Action uninstall  stop + 删除任务
# 日志: $DSH_HOME\storages\alignment-page\server.log(服务与本脚本逐行追加);崩溃输出在同目录 server.err.log
[CmdletBinding()]
param([ValidateSet('install', 'run', 'status', 'stop', 'uninstall')][string]$Action = 'status', [int]$Port = 3390)
$ErrorActionPreference = 'Stop'
$TaskName = 'DshAlignmentPage'
$align = Join-Path $PSScriptRoot 'align.mjs'
# CLI 与本脚本同目录(本插件的 cli/),DSH 数据在 $DSH_HOME(登记表、日志)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$logDir = Join-Path $dshHome 'storages\alignment-page'
$log = Join-Path $logDir 'server.log'

function Write-Log([string]$msg) {
    New-Item -ItemType Directory -Force $logDir | Out-Null
    Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + ' [autostart] ' + $msg) -Encoding utf8
    Write-Output $msg
}

# 返回 $null(端口空闲)或 @{ Pid; CommandLine; IsAlign }
function Get-PortOwner {
    $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return $null }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
    $cmd = if ($p) { [string]$p.CommandLine } else { '' }
    @{ Pid = $c.OwningProcess; CommandLine = $cmd; IsAlign = ($cmd -match 'dsh-alignment[\\/]cli[\\/]align\.mjs"?\s+serve\b') }
}

switch ($Action) {
    'install' {
        $pwshExe = (Get-Process -Id $PID).Path
        $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $arg = "--headless ""$pwshExe"" -NoLogo -NoProfile -NonInteractive -File ""$PSCommandPath"" -Action run -Port $Port"
        $taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument $arg -WorkingDirectory $dshHome
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force `
            -Description "Alignment page server on 127.0.0.1:$Port ($PSScriptRoot). Log: $log" | Out-Null
        "registered $TaskName (logon) -> $PSCommandPath -Action run -Port $Port"
    }
    'run' {
        $o = Get-PortOwner
        if ($o -and $o.IsAlign) { Write-Log "port $Port already served by alignment page PID $($o.Pid); not starting another"; exit 0 }
        if ($o) { Write-Log "ERROR port $Port is used by another program PID $($o.Pid): $($o.CommandLine)"; exit 1 }
        $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        Write-Log "starting $node $align serve --port $Port"
        $env:DSH_HOME = $dshHome
        # serve 自己逐行追加 $log；这里只把崩溃输出接到 server.err.log，避免两边同时占着 $log
        & $node $align serve --port $Port 2>> (Join-Path $logDir 'server.err.log')
        $code = $LASTEXITCODE
        Write-Log "server exited with code $code"
        exit $code
    }
    'status' {
        $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $o = Get-PortOwner
        "task: " + $(if ($t) { $t.State } else { 'not installed' })
        "port $($Port): " + $(if (-not $o) { 'free' } elseif ($o.IsAlign) { "alignment page PID $($o.Pid)" } else { "OTHER PID $($o.Pid): $($o.CommandLine)" })
        "log: $log"
    }
    { $_ -in 'stop', 'uninstall' } {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName }
        $o = Get-PortOwner
        if ($o -and $o.IsAlign) { Stop-Process -Id $o.Pid; Write-Log "stopped alignment page PID $($o.Pid) ($Action)" }
        elseif ($o) { "port $Port is used by another program PID $($o.Pid); left running" }
        if ($Action -eq 'uninstall') {
            if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "unregistered $TaskName" }
            else { "$TaskName not installed" }
        }
    }
}
