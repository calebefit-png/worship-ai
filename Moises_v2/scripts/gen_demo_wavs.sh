#!/usr/bin/env bash
# Gera os 4 arquivos de demonstração (WAV PCM 16b/mono/44100Hz, 10s cada)
# com tons distintos para demonstrar o player em modo demo.
set -u
FFMPEG="${FFMPEG:-$(node -e "console.log(require('ffmpeg-static'))")}"
D="$(cd "$(dirname "$0")/.." && pwd)/server/processed/demo"
mkdir -p "$D"

"$FFMPEG" -y -f lavfi -i "sine=frequency=440:duration=10" \
  -ar 44100 -ac 1 -c:a pcm_s16le "$D/vocals.wav" >/dev/null 2>&1

"$FFMPEG" -y -f lavfi -i "noise=white:duration=10" \
  -ar 44100 -ac 1 -af "lowpass=f=200" -c:a pcm_s16le "$D/drums.wav" >/dev/null 2>&1

"$FFMPEG" -y -f lavfi -i "sine=frequency=80:duration=10" \
  -ar 44100 -ac 1 -c:a pcm_s16le "$D/bass.wav" >/dev/null 2>&1

"$FFMPEG" -y -f lavfi -i "sine=frequency=660:duration=10" \
  -f lavfi -i "sine=frequency=330:duration=10" \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=first" \
  -ar 44100 -ac 1 -c:a pcm_s16le "$D/other.wav" >/dev/null 2>&1

ls -la "$D"/*.wav
