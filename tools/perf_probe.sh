#!/usr/bin/env bash
# Snapshot the Switch port save slot and diff it against the previous snapshot.
#
#   perf_probe.sh <slot-dir> <n>
#
# <slot-dir> is the mounted slot folder (e.g.
#   /run/media/Healt/SWITCH\ SD/switch/nfsu2x/game/UDATA/4541005a/004110E4103B)
# <n> is the snapshot number. Copies the save into snapshots/snap<N> and diffs it
# against snapshots/snap<N-1> with tools/perf_diff.py.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPS="$HERE/../snapshots"
SLOT_DIR="$1"
N="$2"

mkdir -p "$SNAPS"
SAVE="$(find "$SLOT_DIR" -maxdepth 1 -type f -size +50000c | head -1)"
[ -n "$SAVE" ] || { echo "no save file in $SLOT_DIR"; exit 1; }

cp -a "$SAVE" "$SNAPS/snap$N"
echo "snap$N: $(md5sum "$SNAPS/snap$N" | cut -d' ' -f1)  $SAVE"

if [ -f "$SNAPS/snap$((N - 1))" ]; then
    python3 "$HERE/tools/perf_diff.py" "$SNAPS/snap$((N - 1))" "$SNAPS/snap$N"
else
    echo "no previous snapshot (snap$((N - 1))) to diff against"
fi
