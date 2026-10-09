#!/bin/bash
# Egress policy for repl containers (Repl). Idempotent; run as root after
# docker starts (deploy/repl-firewall.service does that).
#
# Repl containers live on per-repl bridges carved from REPL_SUBNET_POOL
# (10.213.0.0/16). They may reach the public internet (pip, npm, apt mirrors),
# but not: cloud metadata, any private/LAN/host address, other docker
# networks (postgres, collaboration), outbound mail, or the host itself; and
# their new-connection and bandwidth rates are capped per container.
set -euo pipefail
POOL=${REPL_SUBNET_POOL:-10.213.0.0/16}
NEW_CONN_RATE=${REPL_NEW_CONN_RATE:-30/sec}
NEW_CONN_BURST=${REPL_NEW_CONN_BURST:-60}
EGRESS_RATE=${REPL_EGRESS_RATE:-8mb/s}      # bytes/s per container (~64 Mbit/s)
CHAIN=REPL-EGRESS

for ipt in iptables; do
  $ipt -N $CHAIN 2>/dev/null || $ipt -F $CHAIN
  # Replies to connections someone else opened (nginx -> repl previews).
  $ipt -A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  # Inside the pool (the repl's own bridge: its nginx/backend gateways).
  $ipt -A $CHAIN -d "$POOL" -j RETURN
  # Metadata, private, shared, loopback, link-local, multicast, reserved.
  for net in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 \
             127.0.0.0/8 0.0.0.0/8 192.0.0.0/24 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
    $ipt -A $CHAIN -d "$net" -j REJECT --reject-with icmp-net-prohibited
  done
  # No outbound mail.
  $ipt -A $CHAIN -p tcp -m multiport --dports 25,465,587,2525 -j REJECT --reject-with tcp-reset
  # New-connection rate per container (scans, floods).
  $ipt -A $CHAIN -m conntrack --ctstate NEW -m hashlimit --hashlimit-above "$NEW_CONN_RATE" \
       --hashlimit-burst "$NEW_CONN_BURST" --hashlimit-mode srcip --hashlimit-name repl-new -j DROP
  # Bandwidth per container.
  $ipt -A $CHAIN -m hashlimit --hashlimit-above "$EGRESS_RATE" --hashlimit-burst 16mb \
       --hashlimit-mode srcip --hashlimit-name repl-bw -j DROP
  $ipt -A $CHAIN -j RETURN

  # Hook into Docker's user chain (FORWARD path) once.
  $ipt -N DOCKER-USER 2>/dev/null || true
  $ipt -C DOCKER-USER -s "$POOL" -j $CHAIN 2>/dev/null || $ipt -I DOCKER-USER 1 -s "$POOL" -j $CHAIN

  # Traffic to the host's own addresses takes the INPUT path, not FORWARD.
  # (Container DNS uses Docker's resolver inside the container's netns.)
  $ipt -C INPUT -s "$POOL" -j REJECT --reject-with icmp-host-prohibited 2>/dev/null \
    || $ipt -I INPUT 1 -s "$POOL" -j REJECT --reject-with icmp-host-prohibited
done
# Repl networks are IPv4-only (--ipv6 is not enabled on them); refuse IPv6
# forwarding from Docker bridges outright for safety.
ip6tables -N DOCKER-USER 2>/dev/null || true
echo "repl firewall: egress policy for $POOL installed"
