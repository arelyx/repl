#!/bin/bash
# Repl container entrypoint: virtual display + VNC bridge, then the agent.
# Runs as user `runner` (uid 1000). X failures must never stop the agent.
export DISPLAY=:0
export HOME=/home/runner
cd /home/runner/app 2>/dev/null || cd /home/runner

# Only the agent gets the token; everything else (including the X session
# and anything the user launches from it) starts without it.
agent_token="${REPL_AGENT_TOKEN:-}"
unset REPL_AGENT_TOKEN

rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 2>/dev/null

(
  Xvfb :0 -screen 0 960x600x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  # wait for the X socket (max ~5s)
  for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X0 ] && break; sleep 0.1; done
  fluxbox >/tmp/fluxbox.log 2>&1 &
  x11vnc -display :0 -forever -shared -nopw -localhost -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &
  # Loopback only: websockify can't check the agent token, so the agent
  # proxies /vnc/* to it after checking.
  websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
  wait
) &

REPL_AGENT_TOKEN="$agent_token" exec python3 /opt/replagent/agent.py
