#!/bin/sh
# Renders the Chrome Web Store images from screenshots.html with headless Chrome.
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
page="file://$PWD/screenshots.html"
for n in 1 2 3; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1280,800 --screenshot="$PWD/screenshot-$n.png" "$page#$n" >/dev/null 2>&1
done
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=440,280 --screenshot="$PWD/promo-tile.png" "$page#tile" >/dev/null 2>&1
ls -1 *.png
