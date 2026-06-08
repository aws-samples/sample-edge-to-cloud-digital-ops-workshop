#!/bin/bash
# IoT Job handler: deploy app-deployment and device-health shadow reporters.
# Adds two systemd timer units; each fires every 30 seconds.
# Exit 0 = SUCCESS; non-zero = FAILED.
set -euo pipefail

INSTANCE_ID=$(ec2-metadata --instance-id | cut -d' ' -f2)
REGION=$(ec2-metadata --availability-zone | cut -d' ' -f2 | sed 's/.$//')
IOT_ENDPOINT=$(aws iot describe-endpoint --region "$REGION" --endpoint-type iot:Data-ATS --query endpointAddress --output text)

# ── app-deployment shadow ─────────────────────────────────────────────────────
cat > /usr/local/bin/report-app-deployment.sh <<SCRIPT
#!/bin/bash
INSTANCE_ID=\$(ec2-metadata --instance-id | cut -d' ' -f2)
REGION=\$(ec2-metadata --availability-zone | cut -d' ' -f2 | sed 's/.\$//')
IOT_ENDPOINT=\$(aws iot describe-endpoint --region "\$REGION" --endpoint-type iot:Data-ATS --query endpointAddress --output text)

COMPOSE_VER=\$(docker compose version 2>/dev/null | awk '{print \$NF}' || echo "not-installed")
PAYLOAD=\$(printf '{"state":{"reported":{"compose_version":"%s","deploy_status":"running"}}}' "\$COMPOSE_VER")

aws iot-data update-thing-shadow \\
  --region "\$REGION" \\
  --endpoint-url "https://\$IOT_ENDPOINT" \\
  --thing-name "\$INSTANCE_ID" \\
  --shadow-name app-deployment \\
  --payload "\$PAYLOAD" \\
  /dev/null
SCRIPT
chmod +x /usr/local/bin/report-app-deployment.sh

cat > /etc/systemd/system/report-app-deployment.service <<UNIT
[Unit]
Description=Report app-deployment shadow

[Service]
Type=oneshot
ExecStart=/usr/local/bin/report-app-deployment.sh
UNIT

cat > /etc/systemd/system/report-app-deployment.timer <<TIMER
[Unit]
Description=App-deployment shadow heartbeat (30 s)

[Timer]
OnBootSec=10
OnUnitActiveSec=30

[Install]
WantedBy=timers.target
TIMER

# ── device-health shadow ──────────────────────────────────────────────────────
cat > /usr/local/bin/report-device-health.sh <<SCRIPT
#!/bin/bash
INSTANCE_ID=\$(ec2-metadata --instance-id | cut -d' ' -f2)
REGION=\$(ec2-metadata --availability-zone | cut -d' ' -f2 | sed 's/.\$//')
IOT_ENDPOINT=\$(aws iot describe-endpoint --region "\$REGION" --endpoint-type iot:Data-ATS --query endpointAddress --output text)

CPU=\$(top -bn1 | grep "Cpu(s)" | awk '{print \$2}' | tr -d '%us,')
MEM=\$(free | awk '/Mem:/ {printf "%.1f", \$3/\$2*100}')
DISK=\$(df / | awk 'NR==2 {print \$5}' | tr -d '%')
UPTIME_S=\$(awk '{print int(\$1)}' /proc/uptime)
CONTAINERS=\$(docker ps -q 2>/dev/null | wc -l || echo 0)
NOW_MS=\$(date -u +%s%3N)

PAYLOAD=\$(printf '{"state":{"reported":{"cpu_pct":%s,"mem_used_pct":%s,"disk_used_pct":%s,"container_count":%s,"uptime_s":%s,"last_heartbeat":%s}}}' \\
  "\$CPU" "\$MEM" "\$DISK" "\$CONTAINERS" "\$UPTIME_S" "\$NOW_MS")

aws iot-data update-thing-shadow \\
  --region "\$REGION" \\
  --endpoint-url "https://\$IOT_ENDPOINT" \\
  --thing-name "\$INSTANCE_ID" \\
  --shadow-name device-health \\
  --payload "\$PAYLOAD" \\
  /dev/null
SCRIPT
chmod +x /usr/local/bin/report-device-health.sh

cat > /etc/systemd/system/report-device-health.service <<UNIT
[Unit]
Description=Report device-health shadow

[Service]
Type=oneshot
ExecStart=/usr/local/bin/report-device-health.sh
UNIT

cat > /etc/systemd/system/report-device-health.timer <<TIMER
[Unit]
Description=Device-health shadow heartbeat (30 s)

[Timer]
OnBootSec=5
OnUnitActiveSec=30

[Install]
WantedBy=timers.target
TIMER

# ── Enable and start both timers ──────────────────────────────────────────────
systemctl daemon-reload
systemctl enable report-app-deployment.timer report-device-health.timer
systemctl start  report-app-deployment.timer report-device-health.timer

echo "add-shadows applied successfully"
exit 0
