const CLAUDE_DOMAINS = [
  "claude.ai",
  "anthropic.com",
  "api.anthropic.com",
  "console.anthropic.com",
  "statsig.anthropic.com",
  "intercom.io",
  "intercomcdn.com",
  "sentry.io"
];

const CLAUDE_RULES = [
  "DOMAIN-SUFFIX,claude.ai,PROXY",
  "DOMAIN-SUFFIX,anthropic.com,PROXY",
  "DOMAIN-SUFFIX,statsig.com,PROXY",
  "DOMAIN-SUFFIX,statsigapi.net,PROXY",
  "DOMAIN-SUFFIX,intercom.io,PROXY",
  "DOMAIN-SUFFIX,intercomcdn.com,PROXY",
  "DOMAIN-SUFFIX,sentry.io,PROXY"
];

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function boolFlag(value) {
  return value ? "1" : "0";
}

function b64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function claudeProbeFunctions() {
  return `
claude_probe() {
  domain="$1"
  echo "DOMAIN_BEGIN $domain"
  echo "DNS_V4 $(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR==1 {print $1; exit}' || true)"
  echo "DNS_V6 $(getent ahostsv6 "$domain" 2>/dev/null | awk 'NR==1 {print $1; exit}' || true)"
  if timeout 8 bash -c "cat < /dev/null > /dev/tcp/$domain/443" 2>/dev/null; then
    echo "TCP443 ok"
  else
    echo "TCP443 failed"
  fi
  tls="$(timeout 12 openssl s_client -connect "$domain:443" -servername "$domain" -alpn h2 -brief </dev/null 2>&1 || true)"
  if printf '%s' "$tls" | grep -Eq "CONNECTION ESTABLISHED|Protocol version"; then
    echo "TLS ok"
  else
    echo "TLS failed"
  fi
  if printf '%s' "$tls" | grep -q "ALPN protocol: h2"; then
    echo "HTTP2 tls-h2"
  else
    echo "HTTP2 not-confirmed"
  fi
  tmp_body="$(mktemp)"
  curl_meta="$(curl -LfsS -o "$tmp_body" --connect-timeout 8 --max-time 18 -w '%{http_code}|%{http_version}|%{remote_ip}|%{errormsg}' "https://$domain/" 2>&1 || true)"
  echo "CURL $curl_meta"
  body_hint="$(tr '\\n' ' ' < "$tmp_body" | head -c 800 | grep -Eio 'region[^< ]* blocked|unsupported region|network[^< ]* blocked|connection reset|timeout|access denied|forbidden' | head -n 1 || true)"
  if [ -n "$body_hint" ]; then
    echo "BLOCK_HINT $body_hint"
  else
    echo "BLOCK_HINT none"
  fi
  rm -f "$tmp_body"
  echo "DOMAIN_END $domain"
}
`;
}

function claudeTestScript() {
  return `
set -u
export LC_ALL=C
echo "CLAUDE_DIAGNOSTIC_BEGIN"
echo "TIME $(date -u +%FT%TZ)"
echo "IPV4_INFO_BEGIN"
curl -4fsS --connect-timeout 8 --max-time 15 https://ipinfo.io/json || echo '{"error":"ipv4 lookup failed"}'
echo
echo "IPV4_INFO_END"
echo "IPV6_INFO_BEGIN"
curl -6fsS --connect-timeout 8 --max-time 15 https://ipinfo.io/json || echo '{"error":"ipv6 lookup failed"}'
echo
echo "IPV6_INFO_END"
echo "BROWSER_TRACE_V4_BEGIN"
curl -4fsS --connect-timeout 8 --max-time 15 https://1.1.1.1/cdn-cgi/trace || echo "trace=ipv4 lookup failed"
echo
echo "BROWSER_TRACE_V4_END"
echo "BROWSER_TRACE_V6_BEGIN"
curl -6fsS --connect-timeout 8 --max-time 15 https://1.1.1.1/cdn-cgi/trace || echo "trace=ipv6 lookup failed"
echo
echo "BROWSER_TRACE_V6_END"
echo "RESOLVERS_BEGIN"
if command -v resolvectl >/dev/null 2>&1; then
  resolvectl dns 2>/dev/null || true
fi
grep -E '^nameserver ' /etc/resolv.conf 2>/dev/null || true
echo "RESOLVERS_END"
for resolver in $(grep -E '^nameserver ' /etc/resolv.conf 2>/dev/null | awk '{print $2}' | grep -Ev '^(127\\.|::1|0\\.0\\.0\\.0$)' | head -n 4); do
  echo "DNS_IPINFO_BEGIN $resolver"
  curl -fsS --connect-timeout 6 --max-time 10 "https://ipinfo.io/$resolver/json" || echo '{"error":"resolver lookup failed"}'
  echo
  echo "DNS_IPINFO_END $resolver"
done
echo "IPV6_SYSCTL net.ipv6.conf.all.disable_ipv6=$(sysctl -n net.ipv6.conf.all.disable_ipv6 2>/dev/null || echo unknown)"
echo "IPV6_SYSCTL net.ipv6.conf.default.disable_ipv6=$(sysctl -n net.ipv6.conf.default.disable_ipv6 2>/dev/null || echo unknown)"
${claudeProbeFunctions()}
${CLAUDE_DOMAINS.map((domain) => `claude_probe "${domain}"`).join("\n")}
echo "CLAUDE_DIAGNOSTIC_END"
`;
}

function bbrTestScript() {
  return `
set -u
echo "BBR_REPORT_BEGIN"
echo "QDISC $(sysctl net.core.default_qdisc 2>&1 || true)"
echo "CONGESTION $(sysctl net.ipv4.tcp_congestion_control 2>&1 || true)"
echo "AVAILABLE $(sysctl net.ipv4.tcp_available_congestion_control 2>&1 || true)"
echo "MODULES_BEGIN"
lsmod 2>/dev/null | grep bbr || true
echo "MODULES_END"
echo "BBR_REPORT_END"
`;
}

function bbrEnableScript() {
  return `
set -e
echo "BBR_ENABLE_BEGIN"
cat > /etc/sysctl.d/99-bbr.conf <<'BBR_SYSCTL'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
BBR_SYSCTL
sysctl --system
${bbrTestScript()}
if [ "$(sysctl -n net.core.default_qdisc 2>/dev/null || true)" = "fq" ] && [ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)" = "bbr" ]; then
  echo "BBR_STATUS enabled"
  echo "BBR 已开启"
else
  echo "BBR_STATUS failed"
  exit 1
fi
echo "BBR_ENABLE_END"
`;
}

function bbrEnableSoftScript() {
  return `
set -u
echo "BBR_ENABLE_SOFT_BEGIN"
cat > /etc/sysctl.d/99-bbr.conf <<'BBR_SYSCTL'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
BBR_SYSCTL
sysctl --system >/dev/null 2>&1 || true
${bbrTestScript()}
if [ "$(sysctl -n net.core.default_qdisc 2>/dev/null || true)" = "fq" ] && [ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)" = "bbr" ]; then
  echo "BBR_STATUS enabled"
  echo "BBR 已开启"
else
  echo "BBR_STATUS failed"
  echo "BBR 未开启"
fi
echo "BBR_ENABLE_SOFT_END"
`;
}

function autofixScript(target, payload = {}) {
  const sshPort = Number(payload.sshPort) || 22;
  const servicePort = Number(payload.servicePort) || 443;
  const serverName = String(payload.serverName || "www.cloudflare.com");
  const serverConfigJson = String(payload.serverConfigJson || "");

  return `
set -u
export LC_ALL=C
AUTOFIX_TARGET=${shellQuote(target)}
FORCE_LEVEL3=${shellQuote(boolFlag(payload.force))}
INPUT_SSH_PORT=${shellQuote(String(sshPort))}
SERVICE_PORT=${shellQuote(String(servicePort))}
SERVER_NAME=${shellQuote(serverName)}
XRAY_CONFIG_B64=${shellQuote(b64(serverConfigJson))}
CLAUDE_RULES_B64=${shellQuote(b64(CLAUDE_RULES.join("\\n")))}
AUTOFIX_TIME="$(date -u +%FT%TZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_FILE="/root/vps-helper-autofix-report.md"
OBSIDIAN_FILE="$HOME/Obsidian/VPS/VPS 配置.md"
CLIENT_DIR="/root/vps-helper-client"
mkdir -p "$CLIENT_DIR" "$(dirname "$OBSIDIAN_FILE")"

declare -a ISSUES ACTIONS FILES BACKUPS ROLLBACKS REMAINING
AUTOFIX_STATUS="success"

add_issue() { ISSUES+=("$1"); }
add_action() { ACTIONS+=("$1"); }
add_file() {
  case " \${FILES[*]} " in
    *" $1 "*) ;;
    *) FILES+=("$1") ;;
  esac
}
add_backup() {
  case " \${BACKUPS[*]} " in
    *" $1 "*) ;;
    *) BACKUPS+=("$1") ;;
  esac
}
add_rollback() {
  case " \${ROLLBACKS[*]} " in
    *" $1 "*) ;;
    *) ROLLBACKS+=("$1") ;;
  esac
}
mark_remaining() {
  REMAINING+=("$1")
  if [ "$AUTOFIX_STATUS" = "success" ]; then
    AUTOFIX_STATUS="partial"
  fi
}
backup_file() {
  file="$1"
  if [ -e "$file" ]; then
    backup="$file.bak.$STAMP"
    cp -a "$file" "$backup"
    add_file "$file"
    add_backup "$backup"
    add_rollback "cp -a '$backup' '$file'"
    printf '%s\\n' "$backup"
  fi
}
detect_ssh_port() {
  port="$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}' || true)"
  if [ -z "$port" ] && [ -f /etc/ssh/sshd_config ]; then
    port="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2; exit}' /etc/ssh/sshd_config 2>/dev/null || true)"
  fi
  printf '%s\\n' "\${port:-$INPUT_SSH_PORT}"
}
resolver_ips() {
  {
    if command -v resolvectl >/dev/null 2>&1; then
      resolvectl dns 2>/dev/null | awk '{for (i=2; i<=NF; i++) print $i}'
    fi
    grep -E '^nameserver ' /etc/resolv.conf 2>/dev/null | awk '{print $2}'
  } | grep -Ev '^(127\\.|::1|0\\.0\\.0\\.0$)' | awk '!seen[$0]++'
}
ipv4_info() { curl -4fsS --connect-timeout 8 --max-time 12 https://ipinfo.io/json 2>/dev/null || printf '{}'; }
ipv6_info() { curl -6fsS --connect-timeout 8 --max-time 12 https://ipinfo.io/json 2>/dev/null || printf '{}'; }
ip_json_field() {
  printf '%s' "$1" | sed -n "s/.*\\"$2\\":[[:space:]]*\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1
}
country_from_ip() {
  curl -fsS --connect-timeout 6 --max-time 10 "https://ipinfo.io/$1/json" 2>/dev/null | sed -n 's/.*"country":[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1
}
org_from_ip() {
  curl -fsS --connect-timeout 6 --max-time 10 "https://ipinfo.io/$1/json" 2>/dev/null | sed -n 's/.*"org":[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1
}
dns_resolves() {
  getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1 {print $1; exit}'
}
claude_http_probe() {
  curl -LfsS -o /tmp/vps-helper-probe.$$ --connect-timeout 8 --max-time 18 -w '%{http_code}|%{http_version}|%{remote_ip}|%{errormsg}' "https://$1/" 2>&1 || true
}
claude_block_hint() {
  if [ ! -f /tmp/vps-helper-probe.$$ ]; then
    printf 'none\\n'
    return
  fi
  hint="$(tr '\\n' ' ' < /tmp/vps-helper-probe.$$ | head -c 800 | grep -Eio 'region[^< ]* blocked|unsupported region|network[^< ]* blocked|connection reset|timeout|access denied|forbidden' | head -n 1 || true)"
  printf '%s\\n' "\${hint:-none}"
}
is_bbr_enabled() {
  [ "$(sysctl -n net.core.default_qdisc 2>/dev/null || true)" = "fq" ] && [ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)" = "bbr" ]
}
has_ipv6_exit() {
  curl -6fsS --connect-timeout 6 --max-time 8 https://ipinfo.io/ip >/dev/null 2>&1
}
ipv6_country_mismatch() {
  v4_country="$1"
  v6_json="$(ipv6_info)"
  v6_country="$(ip_json_field "$v6_json" country)"
  [ -n "$v6_country" ] && [ -n "$v4_country" ] && [ "$v6_country" != "$v4_country" ]
}
claude_failed() {
  status="$(claude_http_probe claude.ai)"
  rm -f /tmp/vps-helper-probe.$$ 2>/dev/null || true
  code="$(printf '%s' "$status" | cut -d'|' -f1)"
  case "$code" in
    2*|3*) return 1 ;;
    000|4*|5*|"") return 0 ;;
    *) return 0 ;;
  esac
}
chatgpt_reachable() {
  code="$(curl -LfsS -o /dev/null --connect-timeout 8 --max-time 18 -w '%{http_code}' https://chatgpt.com/ 2>/dev/null || true)"
  case "$code" in
    2*|3*|4*|5*) return 0 ;;
    *) return 1 ;;
  esac
}
dns_needs_fix() {
  v4_country="$1"
  resolver_failed="0"
  resolver_cn="0"
  resolver_mismatch="0"
  resolved_claude="$(dns_resolves claude.ai)"
  [ -n "$resolved_claude" ] || resolver_failed="1"
  for resolver in $(resolver_ips); do
    country="$(country_from_ip "$resolver")"
    case "$country" in
      CN) resolver_cn="1" ;;
    esac
    if [ -n "$v4_country" ] && [ -n "$country" ] && [ "$country" != "$v4_country" ]; then
      resolver_mismatch="1"
    fi
  done
  [ "$resolver_failed" = "1" ] || [ "$resolver_cn" = "1" ] || [ "$resolver_mismatch" = "1" ]
}
write_dns_config() {
  backup_file /etc/systemd/resolved.conf >/dev/null || true
  cat > /etc/systemd/resolved.conf <<'DNS_CONF'
[Resolve]
DNS=1.1.1.1 8.8.8.8 9.9.9.9
FallbackDNS=1.0.0.1 8.8.4.4
DNSStubListener=no
DNS_CONF
  add_file /etc/systemd/resolved.conf
  add_action "已切换 systemd-resolved 到 1.1.1.1 / 8.8.8.8 / 9.9.9.9。"
  add_rollback "cp -a '/etc/systemd/resolved.conf.bak.$STAMP' '/etc/systemd/resolved.conf' && systemctl restart systemd-resolved"
  systemctl restart systemd-resolved >/dev/null 2>&1 || true
  ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  add_file /etc/resolv.conf
  add_rollback "ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf"
}
write_ipv6_disable() {
  backup_file /etc/sysctl.d/99-disable-ipv6.conf >/dev/null || true
  cat > /etc/sysctl.d/99-disable-ipv6.conf <<'IPV6_CONF'
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
IPV6_CONF
  add_file /etc/sysctl.d/99-disable-ipv6.conf
  add_action "已写入 sysctl 关闭 IPv6。"
  add_rollback "rm -f '/etc/sysctl.d/99-disable-ipv6.conf' && sysctl --system"
  sysctl --system >/dev/null 2>&1 || true
}
write_bbr_config() {
  backup_file /etc/sysctl.d/99-bbr.conf >/dev/null || true
  cat > /etc/sysctl.d/99-bbr.conf <<'BBR_CONF'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
BBR_CONF
  add_file /etc/sysctl.d/99-bbr.conf
  add_action "已写入 BBR sysctl 配置。"
  add_rollback "rm -f '/etc/sysctl.d/99-bbr.conf' && sysctl --system"
  sysctl --system >/dev/null 2>&1 || true
}
write_claude_rules() {
  mkdir -p "$CLIENT_DIR"
  printf '%s' "$CLAUDE_RULES_B64" | base64 -d > "$CLIENT_DIR/claude-proxy-rules.txt"
  add_file "$CLIENT_DIR/claude-proxy-rules.txt"
  add_action "已更新 Claude 分流规则文件。"
}
standard_xray_config() {
  uuid="$(cat /proc/sys/kernel/random/uuid)"
  shortid="$(openssl rand -hex 8 2>/dev/null | tr -d '\\n')"
  if command -v xray >/dev/null 2>&1; then
    x25519="$(xray x25519 2>/dev/null || true)"
  else
    x25519=""
  fi
  private_key="$(printf '%s\\n' "$x25519" | sed -n 's/^Private key: //p' | head -n 1)"
  public_key="$(printf '%s\\n' "$x25519" | sed -n 's/^Public key: //p' | head -n 1)"
  if [ -n "$XRAY_CONFIG_B64" ]; then
    printf '%s' "$XRAY_CONFIG_B64" | base64 -d
  else
    cat <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "vless-reality",
      "listen": "0.0.0.0",
      "port": $SERVICE_PORT,
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "$uuid",
            "flow": "xtls-rprx-vision",
            "email": "autofix"
          }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "$SERVER_NAME:443",
          "xver": 0,
          "serverNames": ["$SERVER_NAME"],
          "privateKey": "$private_key",
          "shortIds": ["$shortid"]
        }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["http", "tls", "quic"]
      }
    }
  ],
  "outbounds": [{ "protocol": "freedom", "tag": "direct" }]
}
EOF
  fi
}
xray_needs_fix() {
  [ -f /usr/local/etc/xray/config.json ] || return 0
  systemctl is-active --quiet xray || return 0
  command -v xray >/dev/null 2>&1 || return 0
  xray test -config /usr/local/etc/xray/config.json >/dev/null 2>&1 || return 0
  grep -q '"security"[[:space:]]*:[[:space:]]*"reality"' /usr/local/etc/xray/config.json || return 0
  grep -q 'xtls-rprx-vision' /usr/local/etc/xray/config.json || return 0
  grep -Eq '"shortIds?"[[:space:]]*:' /usr/local/etc/xray/config.json || return 0
  ss -tulpen 2>/dev/null | grep -q ":$SERVICE_PORT" || return 0
  return 1
}
fix_xray() {
  add_issue "Xray 未运行、配置错误、Reality 参数缺失或 $SERVICE_PORT 未监听。"
  if ! command -v xray >/dev/null 2>&1; then
    add_action "检测到未安装 Xray，使用官方安装脚本补装最新版。"
    bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install >/dev/null 2>&1 || true
  fi
  install -d -m 755 /usr/local/etc/xray
  backup_file /usr/local/etc/xray/config.json >/dev/null || true
  standard_xray_config > /usr/local/etc/xray/config.json
  add_file /usr/local/etc/xray/config.json
  add_action "已写入标准 VLESS + REALITY + XTLS Vision 配置。"
  add_rollback "cp -a '/usr/local/etc/xray/config.json.bak.$STAMP' '/usr/local/etc/xray/config.json' && systemctl restart xray"
  if command -v xray >/dev/null 2>&1; then
    xray test -config /usr/local/etc/xray/config.json >/dev/null 2>&1 || mark_remaining "Xray 新配置校验仍失败。"
  fi
  systemctl enable xray >/dev/null 2>&1 || true
  systemctl restart xray >/dev/null 2>&1 || true
}
fix_dns_if_needed() {
  v4_country="$1"
  if dns_needs_fix "$v4_country"; then
    add_issue "DNS resolver 地区异常、疑似国内 DNS 或 Claude 域名解析失败。"
    write_dns_config
    dig claude.ai +short 2>/dev/null >/dev/null || true
    dig api.anthropic.com +short 2>/dev/null >/dev/null || true
  fi
}
fix_ipv6_if_needed() {
  v4_country="$1"
  if has_ipv6_exit || ipv6_country_mismatch "$v4_country"; then
    add_issue "检测到 IPv6 出口或 IPv6 地区与 IPv4 不一致，存在 Claude 走 IPv6 失败或泄露风险。"
    write_ipv6_disable
  fi
}
fix_bbr_if_needed() {
  if ! is_bbr_enabled; then
    add_issue "BBR 未开启。"
    write_bbr_config
    if ! is_bbr_enabled; then
      mark_remaining "BBR 仍未开启，可能是内核版本过低或系统不支持。"
    fi
  fi
}
fix_firewall_if_needed() {
  current_ssh_port="$(detect_ssh_port)"
  if ! command -v ufw >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y ufw >/dev/null 2>&1 || true
  fi
  if [ "$FORCE_LEVEL3" != "1" ]; then
    add_issue "防火墙修复属于 Level 3，高风险动作默认跳过。"
    mark_remaining "如需自动开放 SSH/$current_ssh_port 和 443，请使用 autofix --force。"
    return
  fi
  add_issue "UFW 未启用或缺少 SSH/443 放行规则。"
  add_action "按当前 SSH 端口 $current_ssh_port 和 443/tcp 重建最小安全放行规则。"
  add_rollback "ufw delete allow $current_ssh_port/tcp && ufw delete allow 443/tcp"
  ufw allow "$current_ssh_port/tcp" >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  ufw status >/dev/null 2>&1 || mark_remaining "UFW 启用后状态检查失败。"
}
need_firewall_fix() {
  current_ssh_port="$(detect_ssh_port)"
  ufw status 2>/dev/null | grep -q "$current_ssh_port/tcp" || return 0
  ufw status 2>/dev/null | grep -q "443/tcp" || return 0
  ufw status 2>/dev/null | grep -qi "Status: active" || return 0
  return 1
}
run_claude_fix() {
  v4_json="$(ipv4_info)"
  v4_country="$(ip_json_field "$v4_json" country)"
  fix_dns_if_needed "$v4_country"
  fix_ipv6_if_needed "$v4_country"
  write_claude_rules
  fix_bbr_if_needed
  if xray_needs_fix; then
    fix_xray
  else
    systemctl restart xray >/dev/null 2>&1 || true
    add_action "已重启 Xray。"
  fi
  if need_firewall_fix; then
    fix_firewall_if_needed
  fi
  if chatgpt_reachable && claude_failed; then
    add_issue "ChatGPT 可访问但 Claude 仍不可用，可能是 Anthropic 对当前出口 IP / ASN 风控，或 serverName / fingerprint / HTTP2 指纹问题。"
  fi
}
snapshot_state() {
  stage="$1"
  v4_json="$(ipv4_info)"
  v6_json="$(ipv6_info)"
  v4_ip="$(ip_json_field "$v4_json" ip)"
  v4_country="$(ip_json_field "$v4_json" country)"
  v4_org="$(ip_json_field "$v4_json" org)"
  v6_ip="$(ip_json_field "$v6_json" ip)"
  v6_country="$(ip_json_field "$v6_json" country)"
  dns_list="$(resolver_ips | paste -sd ', ' -)"
  xray_state="$(systemctl is-active xray 2>/dev/null || echo inactive)"
  qdisc="$(sysctl -n net.core.default_qdisc 2>/dev/null || echo unknown)"
  congestion="$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo unknown)"
  ssh_port="$(detect_ssh_port)"
  echo "\${stage}_IPV4=$v4_ip"
  echo "\${stage}_COUNTRY=$v4_country"
  echo "\${stage}_ASN=$v4_org"
  echo "\${stage}_IPV6=$v6_ip"
  echo "\${stage}_IPV6_COUNTRY=$v6_country"
  echo "\${stage}_DNS=$dns_list"
  echo "\${stage}_BBR=$qdisc/$congestion"
  echo "\${stage}_XRAY=$xray_state"
  echo "\${stage}_SSH_PORT=$ssh_port"
}
capture_claude_summary() {
  claude_status="$(claude_http_probe claude.ai)"
  hint="$(claude_block_hint)"
  api_status="$(claude_http_probe api.anthropic.com)"
  rm -f /tmp/vps-helper-probe.$$ 2>/dev/null || true
  echo "CLAUDE_STATUS $claude_status"
  echo "CLAUDE_API_STATUS $api_status"
  echo "CLAUDE_HINT $hint"
}
write_report() {
  pre_state="$(snapshot_state PRE)"
  post_state="$(snapshot_state POST)"
  claude_state="$(capture_claude_summary)"
  {
    echo "# VPS Helper AutoFix Report"
    echo
    echo "- 修复时间: $AUTOFIX_TIME"
    echo "- 修复目标: $AUTOFIX_TARGET"
    echo "- 执行级别: $( [ "$FORCE_LEVEL3" = "1" ] && echo "Level 1 + 2 + 3" || echo "Level 1 + 2" )"
    echo "- 修复结果: $AUTOFIX_STATUS"
    echo
    echo "## 修复前状态"
    printf '%s\n' "$pre_state" | sed 's/^/- /'
    echo
    echo "## 发现的问题"
    if [ \${#ISSUES[@]} -eq 0 ]; then
      echo "- 未发现需要自动修复的问题。"
    else
      printf '%s\n' "\${ISSUES[@]}" | sed 's/^/- /'
    fi
    echo
    echo "## 执行的修复动作"
    if [ \${#ACTIONS[@]} -eq 0 ]; then
      echo "- 未执行任何配置修改。"
    else
      printf '%s\n' "\${ACTIONS[@]}" | sed 's/^/- /'
    fi
    echo
    echo "## 修改过的文件"
    if [ \${#FILES[@]} -eq 0 ]; then
      echo "- 无"
    else
      printf '%s\n' "\${FILES[@]}" | sed 's/^/- /'
    fi
    echo
    echo "## 备份文件位置"
    if [ \${#BACKUPS[@]} -eq 0 ]; then
      echo "- 无"
    else
      printf '%s\n' "\${BACKUPS[@]}" | sed 's/^/- /'
    fi
    echo
    echo "## 回滚命令"
    if [ \${#ROLLBACKS[@]} -eq 0 ]; then
      echo "- 无需回滚"
    else
      printf '%s\n' "\${ROLLBACKS[@]}" | sed 's/^/- /'
    fi
    echo
    echo "## 修复后状态"
    printf '%s\n' "$post_state" | sed 's/^/- /'
    echo
    echo "## Claude 复测"
    printf '%s\n' "$claude_state" | sed 's/^/- /'
    echo
    echo "## 仍然失败的项目"
    if [ \${#REMAINING[@]} -eq 0 ]; then
      echo "- 无"
    else
      printf '%s\n' "\${REMAINING[@]}" | sed 's/^/- /'
    fi
    echo
    echo "## 下一步建议"
    if [ \${#REMAINING[@]} -gt 0 ]; then
      echo "- Claude 若仍失败，优先怀疑出口 IP / ASN 被 Anthropic 风控，建议更换出口。"
      echo "- 如需继续处理防火墙高风险修复，重新执行并加 --force。"
    else
      echo "- 重新导入客户端规则，并确认 Claude 相关域名全走代理。"
      echo "- 若 Claude 仍偶发失败，建议更换出口 IP 或更换更干净的住宅 / 家宽 ASN。"
    fi
  } > "$REPORT_FILE"
  if [ -f "$OBSIDIAN_FILE" ]; then
    backup_file "$OBSIDIAN_FILE" >/dev/null || true
  fi
  cp "$REPORT_FILE" "$OBSIDIAN_FILE"
}

run_target() {
  case "$AUTOFIX_TARGET" in
    all)
      v4_json="$(ipv4_info)"
      v4_country="$(ip_json_field "$v4_json" country)"
      fix_dns_if_needed "$v4_country"
      fix_bbr_if_needed
      write_claude_rules
      fix_ipv6_if_needed "$v4_country"
      if xray_needs_fix; then
        fix_xray
      fi
      run_claude_fix
      ;;
    claude)
      run_claude_fix
      ;;
    dns)
      v4_json="$(ipv4_info)"
      fix_dns_if_needed "$(ip_json_field "$v4_json" country)"
      ;;
    ipv6)
      v4_json="$(ipv4_info)"
      fix_ipv6_if_needed "$(ip_json_field "$v4_json" country)"
      ;;
    bbr)
      fix_bbr_if_needed
      ;;
    xray)
      if xray_needs_fix; then
        fix_xray
      else
        add_action "Xray 当前状态正常，无需修复。"
      fi
      ;;
    firewall)
      if need_firewall_fix; then
        fix_firewall_if_needed
      else
        add_action "防火墙当前状态正常，无需修复。"
      fi
      ;;
    *)
      add_issue "未知 autofix 目标: $AUTOFIX_TARGET"
      AUTOFIX_STATUS="failed"
      mark_remaining "请使用 all / claude / dns / ipv6 / bbr / xray / firewall。"
      ;;
  esac
}

echo "AUTOFIX_BEGIN"
run_target
write_report
echo "AUTOFIX_TARGET $AUTOFIX_TARGET"
echo "AUTOFIX_STATUS $AUTOFIX_STATUS"
echo "AUTOFIX_REPORT $REPORT_FILE"
echo "AUTOFIX_OBSIDIAN $OBSIDIAN_FILE"
echo "AUTOFIX_FIXED_COUNT \${#ACTIONS[@]}"
echo "AUTOFIX_ISSUE_COUNT \${#ISSUES[@]}"
echo "AUTOFIX_REMAINING_COUNT \${#REMAINING[@]}"
if [ \${#ISSUES[@]} -gt 0 ]; then
  printf '%s\n' "\${ISSUES[@]}" | sed 's/^/AUTOFIX_ISSUE /'
fi
if [ \${#ACTIONS[@]} -gt 0 ]; then
  printf '%s\n' "\${ACTIONS[@]}" | sed 's/^/AUTOFIX_ACTION /'
fi
if [ \${#REMAINING[@]} -gt 0 ]; then
  printf '%s\n' "\${REMAINING[@]}" | sed 's/^/AUTOFIX_REMAINING /'
fi
echo "AUTOFIX_REPORT_BEGIN"
cat "$REPORT_FILE"
echo "AUTOFIX_REPORT_END"
echo "AUTOFIX_END"
`;
}

function helperActionScript(action, payload = {}) {
  switch (action) {
    case "claude-test":
    case "claude-report":
      return claudeTestScript();
    case "bbr-test":
    case "bbr-report":
      return bbrTestScript();
    case "bbr-enable":
      return bbrEnableScript();
    case "enable-bbr-soft":
      return bbrEnableSoftScript();
    case "autofix-all":
      return autofixScript("all", payload);
    case "autofix-claude":
      return autofixScript("claude", payload);
    case "autofix-dns":
      return autofixScript("dns", payload);
    case "autofix-ipv6":
      return autofixScript("ipv6", payload);
    case "autofix-bbr":
      return autofixScript("bbr", payload);
    case "autofix-xray":
      return autofixScript("xray", payload);
    case "autofix-firewall":
      return autofixScript("firewall", payload);
    default:
      return "";
  }
}

module.exports = {
  CLAUDE_DOMAINS,
  CLAUDE_RULES,
  helperActionScript
};
