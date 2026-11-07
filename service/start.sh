#!/bin/sh
# TV Watch on the Pi. ./start.sh mic [plughw:1]   live from a USB mic / sound card (./start.sh devices lists them)
#                     ./start.sh demo              loop the NBA / soccer clips (switch sport in the app)
#                     ./start.sh stop
# Add --ntfy TOPIC (also push to the ntfy app) or any other tvwatch.py flag after the mode. Log: run.log
cd "$(dirname "$0")"
mode=${1:-mic}; shift 2>/dev/null
case "$mode" in
  stop) [ -f tvwatch.pid ] && kill "$(cat tvwatch.pid)" 2>/dev/null; rm -f tvwatch.pid; echo stopped; exit 0 ;;
  devices) arecord -l; exit 0 ;;
  demo) set -- --file nba=demo.wav,soccer=demo_soccer.wav --loop --dry-run "$@" ;;
  mic) dev=${1:-$(arecord -l | sed -n 's/^card \([0-9]*\):.*USB.*/plughw:\1/p' | head -1)}
       [ $# -gt 0 ] && shift
       [ -z "$dev" ] && { echo "no USB audio device: plug in the mic (./start.sh devices)"; exit 1; }
       set -- --device "$dev" "$@" ;;
  *) echo "usage: ./start.sh mic [device] | demo | stop | devices"; exit 2 ;;
esac
[ -f tvwatch.pid ] && kill "$(cat tvwatch.pid)" 2>/dev/null && sleep 1   # the running one, once the new one can start
setsid sh -c 'echo $$ > tvwatch.pid; exec python3 tvwatch.py "$@" > run.log 2>&1 < /dev/null' sh "$@" < /dev/null > /dev/null 2>&1 &
sleep 3; head -3 run.log; echo "phone app: TV Watch (finds the Pi by itself) · web: http://$(hostname).local:8080"
