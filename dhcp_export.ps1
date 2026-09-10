# ============================================================
# DHCP 租约导出脚本(在 Windows DHCP 服务器上执行)
# 功能:读取本机所有 IPv4 租约,以 JSON 通过 HTTP POST 推送到接收端
# 用法:powershell -NoProfile -ExecutionPolicy Bypass -File dhcp_export.ps1
# ============================================================
param(
    # 接收端地址(接收程序所在机器)
    [string]$ReceiverUrl = "http://YOUR_RECEIVER_HOST:8000/api/upload",
    # 上传令牌,必须与接收端 config.py 中 UPLOAD_TOKEN 一致
    [string]$Token = "<YOUR_UPLOAD_TOKEN>"
)

$ErrorActionPreference = "Stop"

try {
    # v3:枚举所有作用域,逐个显式传入 ScopeId 获取租约(绝不出现交互提示)
    $scopes = @(Get-DhcpServerv4Scope -ErrorAction Stop)
    Write-Output ("v3: 发现 {0} 个作用域" -f $scopes.Count)
    $leases = @(
        foreach ($s in $scopes) {
            Get-DhcpServerv4Lease -ScopeId $s.ScopeId -ErrorAction SilentlyContinue
        }
    )

    $items = @($leases | ForEach-Object {
        [PSCustomObject]@{
            IPAddress       = [string]$_.IPAddress
            ScopeId         = [string]$_.ScopeId
            ClientId        = [string]$_.ClientId
            HostName        = [string]$_.HostName
            AddressState    = [string]$_.AddressState
            LeaseExpiryTime = if ($_.LeaseExpiryTime) { $_.LeaseExpiryTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" }
        }
    })

    $payload = @{
        server      = $env:COMPUTERNAME
        collectedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        leases      = $items
    }

    # 用 UTF-8 字节发送,避免中文主机名乱码
    $json  = ConvertTo-Json -InputObject $payload -Depth 5 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

    $resp = Invoke-RestMethod -Uri $ReceiverUrl -Method Post `
        -ContentType "application/json" `
        -Headers @{ "X-Auth-Token" = $Token } `
        -Body $bytes

    Write-Output ("OK: 已上传 {0} 条租约,接收端返回 {1}" -f $items.Count, $resp.status)
    exit 0
}
catch {
    Write-Error ("推送失败: {0}" -f $_)
    exit 1
}
