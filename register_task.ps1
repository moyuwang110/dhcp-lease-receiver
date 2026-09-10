# ============================================================
# 注册每天 09:00 执行的定时任务(在 Windows DHCP 服务器上运行)
# 前提:dhcp_export.ps1 已复制到 C:\Scripts\ 下
# 说明:
#   1. 注册 SYSTEM 计划任务需要管理员权限,脚本会自动弹 UAC 提权
#   2. 若 Register-ScheduledTask 被安全软件/组策略拦截,
#      自动降级改用 schtasks.exe 命令行注册
# ============================================================
$ErrorActionPreference = "Continue"

# --- 打印当前身份状态,便于排查 ---
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host ("当前用户 : {0}" -f $identity.Name)
Write-Host ("管理员权限: {0}" -f $(if ($isAdmin) { "是" } else { "否" }))

# --- 非管理员则自动提权重启自身 ---
if (-not $isAdmin) {
    Write-Host "正在弹出 UAC 提权窗口,请在弹窗中点击[是]..." -ForegroundColor Yellow
    Start-Process powershell.exe `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"" `
        -Verb RunAs
    exit
}

$scriptPath = "C:\Scripts\dhcp_export.ps1"
if (-not (Test-Path $scriptPath)) {
    Write-Host "未找到脚本: $scriptPath ,请先复制 dhcp_export.ps1 到 C:\Scripts\" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}

$taskName = "DHCP Lease Export"
$registered = $false

# --- 方式一:PowerShell cmdlet 注册 ---
try {
    $action    = New-ScheduledTaskAction -Execute "powershell.exe" `
                   -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Scripts\dhcp_export.ps1"
    $trigger   = New-ScheduledTaskTrigger -Daily -At 09:00
    $taskPrin  = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $taskPrin -Settings $settings -Force -ErrorAction Stop | Out-Null
    $registered = $true
    Write-Host "[方式一] Register-ScheduledTask 注册成功" -ForegroundColor Green
}
catch {
    Write-Host "[方式一] Register-ScheduledTask 失败: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "自动改用 schtasks.exe 命令行注册..." -ForegroundColor Yellow
}

# --- 方式二:schtasks.exe 命令行注册(降级方案) ---
if (-not $registered) {
    $tr = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Scripts\dhcp_export.ps1"
    & schtasks.exe /Create /F /TN $taskName /SC DAILY /ST 09:00 /RU SYSTEM /RL HIGHEST /TR $tr
    if ($LASTEXITCODE -eq 0) {
        $registered = $true
        Write-Host "[方式二] schtasks.exe 注册成功" -ForegroundColor Green
    } else {
        Write-Host "[方式二] schtasks.exe 也失败 (退出码 $LASTEXITCODE)" -ForegroundColor Red
        Write-Host ""
        Write-Host "两种方式均被拒绝,通常是安全软件或域策略禁止普通方式注册计划任务。" -ForegroundColor Red
        Write-Host "替代方案:" -ForegroundColor Cyan
        Write-Host "  1. 让域管理员通过组策略(GPO)统一下发该计划任务;"
        Write-Host "  2. 或在计划任务程序(taskschd.msc)图形界面中手动创建,程序填:"
        Write-Host "     powershell.exe  参数: -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Scripts\dhcp_export.ps1"
        Read-Host "按回车键退出"
        exit 1
    }
}

# --- 立即运行一次验证 ---
Write-Host "立即试运行一次..."
if ($registered) {
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { & schtasks.exe /Run /TN $taskName | Out-Null }
}
Start-Sleep -Seconds 8

try {
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    Write-Host ("最近一次运行结果: {0}  上次运行时间: {1}" -f $info.LastTaskResult, $info.LastRunTime)
}
catch {
    & schtasks.exe /Query /TN $taskName /V /FO LIST
}
Write-Host "(LastTaskResult = 0 表示成功)" -ForegroundColor Yellow
Write-Host "现在打开 http://YOUR_RECEIVER_HOST:8000 查看数据" -ForegroundColor Cyan
Write-Host ""
Read-Host "按回车键关闭窗口"
