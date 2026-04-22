#!/usr/bin/env bash
set -eu

PRESENCE_DIR="${PRESENCE_DIR:-$HOME/.presence}"
LOG_FILE="$PRESENCE_DIR/logs/server.log"
PID_FILE="$PRESENCE_DIR/server.pid"

mkdir -p "$PRESENCE_DIR/logs"

running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

cmd_start() {
  if running; then
    echo "server already running (pid $(cat "$PID_FILE"))"
    exit 0
  fi
  rm -f "$PID_FILE"
  cd "$(dirname "$0")/.."
  nohup npm start >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "server started pid=$(cat "$PID_FILE") log=$LOG_FILE"
}

cmd_stop() {
  if ! running; then
    echo "server not running"
    rm -f "$PID_FILE"
    exit 0
  fi
  local pid; pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  pkill -f "packages/server/src/server/index" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "server stopped"
}

cmd_status() {
  if running; then
    echo "running pid=$(cat "$PID_FILE")"
  else
    echo "not running"
  fi
}

cmd_logs() { tail -f "$LOG_FILE"; }

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  restart) cmd_stop; cmd_start ;;
  *) echo "usage: $0 {start|stop|status|restart|logs}"; exit 1 ;;
esac
