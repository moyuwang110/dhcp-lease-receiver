"""接收端配置:环境变量可覆盖默认值。"""
import os

# 上传令牌:DHCP 服务器脚本必须在请求头 X-Auth-Token 中携带同样的值
UPLOAD_TOKEN = os.environ.get("DHCP_UPLOAD_TOKEN", "<YOUR_UPLOAD_TOKEN>")

# 数据保存目录
DATA_DIR = os.environ.get("DHCP_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))

# 历史快照保留天数(可查询最近 N 天)
RETENTION_DAYS = int(os.environ.get("DHCP_RETENTION_DAYS", "7"))

# 服务监听
HOST = os.environ.get("DHCP_BIND_HOST", "0.0.0.0")
PORT = int(os.environ.get("DHCP_BIND_PORT", "8000"))
