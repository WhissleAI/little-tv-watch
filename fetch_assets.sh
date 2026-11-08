#!/bin/sh
# Downloads the models and runtime files the app needs into app/public/.
# Accept the licence once at https://huggingface.co/WhissleAI/tv-watch-assets, then run `hf auth login`.
# Non-commercial use only: see the LICENSE file in that repository.
set -e
cd "$(dirname "$0")"
hf download WhissleAI/tv-watch-assets \
  --include "director/*" --include "arctag/*" --include "arcwasm/*" \
  --include "glyphs/*" --include "ort/*" --include "tess/*" \
  --local-dir app/public
rm -rf app/public/.cache
echo "Assets are in app/public/."
