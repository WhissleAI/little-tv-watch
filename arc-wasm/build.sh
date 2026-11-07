#!/bin/sh
# libarc + arc_wasm.c -> WebAssembly, for Arc running inside the TV app (a Web Worker).
#   LIBARC_DIR=/path/to/libarc ./build.sh st   # single thread
#   LIBARC_DIR=/path/to/libarc ./build.sh mt   # pthreads; the page must be cross-origin isolated
# libarc (Arc's C runtime) is not part of this repository: contact WhissleAI for access. Build its sources with
# its NEON paths on: Emscripten maps the NEON intrinsics to WebAssembly SIMD (-mfpu=neon), which is about 5x faster
# than libarc's generic C kernels in the browser.
set -e
: "${LIBARC_DIR:?set LIBARC_DIR to a libarc checkout (with include/ and src/)}"
mode=${1:-st}
FLAGS="-O3 -msimd128 -mfpu=neon -D__ARM_NEON=1 -std=c11 -I$LIBARC_DIR/include -I$LIBARC_DIR/src -Wno-unused-function -DNDEBUG"
EX="-sEXPORTED_FUNCTIONS=_arcw_open,_arcw_push,_arcw_take,_arcw_context,_arcw_finish,_arcw_close,_malloc,_free -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString,HEAPU8,HEAP16"
LINK="-sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=ArcModule -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=2147483648 -sSTACK_SIZE=4194304"
if [ "$mode" = mt ]; then FLAGS="$FLAGS -pthread"; LINK="$LINK -pthread -sPTHREAD_POOL_SIZE=4"; fi
emcc $FLAGS "$LIBARC_DIR"/src/*.c arc_wasm.c -o "arc_$mode.mjs" $LINK $EX
echo "built arc_$mode.mjs + arc_$mode.wasm; copy them to app/public/arcwasm/"
