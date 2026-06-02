#!/usr/bin/env bash
# Composite the REAL (scannable) QR codes and the Fineguide logo onto the
# generated slides. Run AFTER generate-slides-gemini.mjs.
# The image model leaves space on slides 01 and 09; we overlay the assets here
# with ImageMagick so QR codes actually scan and the logo is pixel-accurate.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$DIR/images/generated"
ASSETS="$DIR/assets"

# Pick the ImageMagick entrypoint (v7 `magick`, fallback v6 `convert`).
MAGICK="$(command -v magick || command -v convert)"

# --- Slide 01: Fineguide logo (top-right) + QR to fineguide.ai (bottom-right) ---
"$MAGICK" "$GEN/slide-01-intro.png" \
  \( "$ASSETS/fineguide-logo.png" -resize 420x \) -gravity NorthEast -geometry +90+90 -composite \
  \( "$ASSETS/qr-fineguide.png" -resize 300x300 -bordercolor white -border 18 \) -gravity SouthEast -geometry +110+110 -composite \
  "$GEN/slide-01-intro.png"
echo "✓ slide-01-intro.png  (+ Fineguide logo + QR → fineguide.ai)"

# --- Slide 09: QR to the Chrome Web Store listing (bottom-right) ---
"$MAGICK" "$GEN/slide-09-end.png" \
  \( "$ASSETS/qr-store.png" -resize 320x320 -bordercolor white -border 18 \) -gravity SouthEast -geometry +120+120 -composite \
  "$GEN/slide-09-end.png"
echo "✓ slide-09-end.png    (+ QR → Chrome Web Store)"

echo "Done. QR targets:  fineguide.ai  ·  chromewebstore.../mnibceaaapcppokpnnljohdlmojjgbkf"
