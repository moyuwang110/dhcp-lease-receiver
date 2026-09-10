# DHCP 租约接收与展示系统

Windows DHCP 服务器每天定时把 IPv4 租约推送到本服务(Web 界面 + CMDB 同步)。

```
┌─────────────────────┐  每天09:00 HTTP POST(JSON)  ┌──────────────────────────┐  自动同步  ┌─────────────────────┐
│ Windows DHCP 服务器  │ ───────────────────────────> │ <RECEIVER_URL>           │ ────────> │ veops CMDB          │
│ dhcp_export.ps1     │   X-Auth-Token 鉴权          │ FastAPI 接收 + 7 天历史   │  upsert  │ DHCP信息 (MAC_ID)   │
│ (计划任务,SYSTEM)   │                              │ 姓名映射 + CSV/Excel 导出  │           │ + HDCP_name         │
└─────────────────────┘                              └──────────────────────────┘           └─────────────────────┘
```

- **零远程依赖**:DHCP 服务器只需出网访问 `228:8000`,不依赖 WinRM / 域账号
- **Web 界面**:多服务器下拉、历史日期查询、过滤/排序/分页、CSV/Excel 导出
- **姓名映射**:支持手动编辑与批量导入(xlsx/xls/csv/md/txt),按 主机名 → IP → MAC 自动匹配
- **CMDB 同步**:每次推送自动触发,也可手动触发或命令行执行

---

## 一、目录结构

```
/data/dhcp/
├── app.py                # FastAPI 主服务(Web + API)
├── config.py             # 配置(令牌、端口、保留天数)
├── cmdb_client.py        # veops CMDB API 封装
├── cmdb_sync.py          # DHCP → CMDB 同步逻辑
├── dhcp_export.ps1       # DHCP 服务器侧导出脚本(推送)
├── register_task.ps1     # DHCP 服务器侧计划任务注册脚本
├── requirements.txt      # Python 依赖
├── static/               # Web 前端 (index.html / app.js / styles.css)
└── data/
    ├── <服务器名>/
    │   ├── latest.json       # 最近一次推送的快照
    │   └── history/          # 每日归档(YYYYMMDD_HHMMSS.json)
    └── namemap.json          # 姓名映射表(键小写)
```

---

## 二、接收端部署

### 安装依赖

```bash
cd /data/dhcp
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
```

### 启动方式

**前台调试:**

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

**后台服务(systemd)** — 已部署:

```bash
systemctl status dhcp-web     # 查看状态
systemctl restart dhcp-web    # 重启
journalctl -u dhcp-web -f     # 实时日志
```

服务文件:[/etc/systemd/system/dhcp-web.service](file:///etc/systemd/system/dhcp-web.service)

### 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DHCP_UPLOAD_TOKEN` | `<YOUR_UPLOAD_TOKEN>` | 上传令牌,DHCP 端脚本必须带 `X-Auth-Token` 一致 |
| `DHCP_DATA_DIR` | `/data/dhcp/data` | 数据存储目录 |
| `DHCP_RETENTION_DAYS` | `7` | 历史快照保留天数 |
| `DHCP_BIND_HOST` | `0.0.0.0` | 监听地址 |
| `DHCP_BIND_PORT` | `8000` | 监听端口 |
| `LOG_LEVEL` | `INFO` | 日志级别 |

详见 [config.py](file:///data/dhcp/config.py)。

### 防火墙

```bash
firewall-cmd --add-port=8000/tcp --permanent
firewall-cmd --reload
```

---

## 三、DHCP 服务器部署(每台执行一次)

1. 把 [dhcp_export.ps1](file:///data/dhcp/dhcp_export.ps1) 复制到 `C:\Scripts\dhcp_export.ps1`
2. 以**管理员**身份打开 PowerShell,执行 [register_task.ps1](file:///data/dhcp/register_task.ps1)
   - 注册名为 **DHCP Lease Export** 的计划任务,每天 **09:00** 以 `SYSTEM` 身份运行
   - 脚本会自动弹 UAC 提权
   - 若 `Register-ScheduledTask` 被安全软件拦截,自动降级为 `schtasks.exe` 注册
   - 注册完立即试运行一次,`LastTaskResult = 0` 即成功
3. 浏览器打开 `http://<RECEIVER_HOST>:8000` 查看数据

### 手动执行一次(验证)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Scripts\dhcp_export.ps1
```

输出 `OK: 已上传 N 条租约,接收端返回 ok` 即成功。

### 修改接收端地址 / 令牌

编辑 `dhcp_export.ps1` 顶部:

```powershell
[string]$ReceiverUrl = "http://YOUR_RECEIVER_HOST:8000/api/upload"
[string]$Token       = "<YOUR_UPLOAD_TOKEN>"
```

---

## 四、Web 界面功能

打开 `http://YOUR_RECEIVER_HOST:8000`:

- **服务器下拉**:自动列出已推送过的 DHCP 服务器(按 `latest.json` 识别)
- **数据日期下拉**:查看历史某天的快照
- **搜索框**:对 IP / 主机名 / ClientId / ScopeId 模糊匹配
- **过滤器**:ScopeId、地址状态(Active / Inactive / Reserved 等)
- **排序**:点击列头切换升/降序
- **分页**:每页 50 条
- **自动刷新**:关闭 / 30 秒 / 60 秒 / 5 分钟
- **导出**:CSV / Excel,带当前过滤条件
- **姓名映射**:网页右上角按钮,手动增删改或批量导入

### 姓名映射规则

- **键类型**:主机名(如 `dc01`)、IP(如 `192.168.1.100`)、MAC(如 `0088-6536-1e4a`)
- **大小写不敏感**:键统一小写存储
- **智能匹配**:`host.corp.com` 自动按 `host` 匹配;MAC 多分隔符自动归一化
- **匹配优先级**:主机名 → IP → MAC
- **批量导入**:支持 `.xlsx` / `.xls` / `.csv` / `.md` / `.txt`
  - 至少两列:第一列键(MAC/IP/主机名),第二列姓名
  - 也支持 `key:value` 或 `key=value` 行格式
- **下载模板**:Web 界面提供 `导入模板.csv` 下载

---

## 五、API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | 接收推送,需请求头 `X-Auth-Token` |
| GET  | `/api/servers` | 已推送数据的服务器列表及最近采集时间 |
| GET  | `/api/dates?server=` | 某服务器可用的历史日期 |
| GET  | `/api/leases?server=&date=&q=&scope=&state=&page=&page_size=&sort_by=&sort_dir=` | 租约列表 |
| GET  | `/api/export?server=&fmt=csv\|xlsx&…` | 导出文件(带当前过滤) |
| GET  | `/api/namemap` | 获取姓名映射表 |
| POST | `/api/namemap` | 新增/更新单条 `{"key": "姓名"}` |
| DELETE | `/api/namemap/{key}` | 删除单条 |
| POST | `/api/namemap/import` | 批量导入(multipart,字段名 `file`) |
| GET  | `/api/namemap/template` | 下载导入模板 |
| POST | `/api/cmdb/sync` | 手动触发 CMDB 同步,`{"server": "DC01"}` 或 `{"server": "all"}` |

---

## 六、CMDB 同步

每次推送数据落盘后,服务自动在后台线程触发 CMDB 同步,无需人工干预。

### 配置

在 [cmdb_client.py](file:///data/dhcp/cmdb_client.py) 中:

```python
BASE_URL  = "http://<CMDB_HOST>:8000"
API_KEY   = "<YOUR_CMDB_API_KEY>"
API_SECRET = "<YOUR_CMDB_API_SECRET>"
```

### 同步字段

| CMDB 字段 | 来源 | 说明 |
|---|---|---|
| `MAC_ID` | DHCP `ClientId` | 唯一键,格式 `0088-6536-1e4a` |
| `DHCP_IPAddress` | DHCP `IPAddress` | 必填 |
| `HostName` | DHCP `HostName` | |
| `AddressState` | DHCP `AddressState` | Active / Inactive 等 |
| `LeaseExpiryTime` | DHCP `LeaseExpiryTime` | 仅日期 `yyyy-MM-dd` |
| `HDCP_name` | 姓名映射 | 仅匹配到才提交,未提交保持 CMDB 原值 |

### 同步策略

- `exist_policy=replace`:已存在则更新,不存在则新建
- **同一 MAC 多个 IP**:按文件顺序保留最后一条(确定性去重)
- **未提交字段**:CMDB 端原值保留(已实测不会清空)
- **并行写入**:8 线程并发 upsert

### 手动同步

```bash
# 同步指定服务器
python3 cmdb_sync.py DC01

# 同步所有服务器
python3 cmdb_sync.py
```

或通过 API:

```bash
curl -X POST http://YOUR_RECEIVER_HOST:8000/api/cmdb/sync \
  -H 'Content-Type: application/json' \
  -d '{"server": "all"}'
```

---

## 七、常见问题

| 问题 | 处理 |
|---|---|
| 计划任务 `LastTaskResult` 非 0 | 手动运行 `dhcp_export.ps1` 看报错;常见是 `Get-DhcpServerv4Lease` 权限不足(SYSTEM 通常可读;若策略限制,改任务运行账户为 DHCP Administrators 成员) |
| 手动运行 `dhcp_export.ps1` 提示 `输入 ScopeId:` | 这是 PowerShell 默认行为。当前 v3 脚本会枚举 `Get-DhcpServerv4Scope` 后逐个 `Get-DhcpServerv4Lease -ScopeId $s.ScopeId`,不应再出现该提示 |
| 连接 228 超时 | 检查 228 的 8000 端口防火墙:`firewall-cmd --add-port=8000/tcp --permanent && firewall-cmd --reload` |
| 返回 401 | 两端令牌不一致(脚本 `$Token` 与 `config.UPLOAD_TOKEN`) |
| 中文主机名乱码 | 脚本已用 UTF-8 字节发送;确认 DHCP 服务器 PowerShell 5.1+(默认即是) |
| 姓名映射匹配不到 | 在 Web 上"姓名映射"页面确认键已存在;MAC 键统一为 `0088-6536-1e4a` 格式;主机名键可带可不带域名后缀 |
| CMDB 同步失败 | 查看 `journalctl -u dhcp-web` 日志,常见是 API key/secret 不对或网络不通 |
| DHCP 服务器多台 | 每台都部署脚本即可,`server` 字段自动取 Windows 计算机名 |

---

## 八、数据存储格式

`data/<服务器名>/latest.json`:

```json
{
  "server": "DC01",
  "collectedAt": "2026-09-10 09:00:12",
  "receivedAt": "2026-09-10T09:00:13.456+08:00",
  "leases": [
    {
      "IPAddress": "192.168.1.100",
      "ScopeId": "192.168.1.0",
      "ClientId": "00-88-65-36-1E-4A",
      "HostName": "pc-zhangsan",
      "AddressState": "Active",
      "LeaseExpiryTime": "2026-09-11 09:00:00"
    }
  ]
}
```

`data/<服务器名>/history/YYYYMMDD_HHMMSS.json`:与 `latest.json` 同结构,用于按日期查询历史快照。

`data/namemap.json`:

```json
{
  "0088-6536-1e4a": "张三",
  "192.168.1.100": "示例用户A",
  "dc01": "DC 服务器"
}
```
