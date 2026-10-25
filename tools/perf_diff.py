"""Diff the car slots of two NFSU2 saves, to decode the performance block.

The 68 bytes at `slot base + 0x94` are per-part "installed" flags, so decoding
the exclusive groups means reading what the game writes when one part is bought
in the upgrade menu. This tool compares two saves slot by slot and reports the
flag positions and the other bytes that changed.

Both files must be saves of the same format (PC or Xbox) and the same length.
Offsets are printed as file offsets, and flag positions are 1-based within the
68-byte block.

Examples:
    perf_diff.py before.bin after.bin
    perf_diff.py /tmp/snap1/HEALT /tmp/snap2/HEALT --slot 3
"""

import struct
import sys

SLOT_SIZE = 0x7F2
NUM_SLOTS = 5
PERF_OFF = 0x94
PERF_LEN = 68


def slots_base(data):
    """Slot array offset, derived from the header (not searched in the payload).

    The header size is `total - payload size`: 84 for Xbox, 36 for PC. The slot
    array sits at `header + 0x5AC8` in both formats.
    """
    if data[:4] != b"20CM":
        raise SystemExit("error: not an NFSU2 save (no 20CM magic)")
    total = struct.unpack_from("<I", data, 4)[0]
    payload = struct.unpack_from("<I", data, 0xC)[0]
    head = total - payload
    if head not in (84, 36):
        raise SystemExit(f"error: header size {head} is neither 84 (Xbox) nor 36 (PC)")
    return head + 0x5AC8


def report(a, b, base, only_slot=None):
    changed = 0
    for i in range(NUM_SLOTS):
        if only_slot is not None and i + 1 != only_slot:
            continue
        sa = base + i * SLOT_SIZE
        sb = base + i * SLOT_SIZE
        pa = a[sa + PERF_OFF:sa + PERF_OFF + PERF_LEN]
        pb = b[sb + PERF_OFF:sb + PERF_OFF + PERF_LEN]
        flags = [k + 1 for k in range(PERF_LEN) if pa[k] != pb[k]]
        others = [(sa + k, a[sa + k], b[sb + k]) for k in range(SLOT_SIZE)
                  if not (PERF_OFF <= k < PERF_OFF + PERF_LEN) and a[sa + k] != b[sb + k]]
        if not flags and not others:
            continue
        changed += 1
        print(f"slot {i + 1}  (base {sa:#x})")
        if flags:
            for k in flags:
                print(f"  flag {k}: {pa[k - 1]} -> {pb[k - 1]}   (offset {sa + PERF_OFF + k - 1:#x})")
        for off, va, vb in others:
            print(f"  byte {off:#x}: {va} -> {vb}")
    if changed == 0:
        print("no slot differences")


def main():
    args = [x for x in sys.argv[1:] if not x.startswith("--")]
    only = None
    for x in sys.argv[1:]:
        if x.startswith("--slot"):
            only = int(x.split("=", 1)[1]) if "=" in x else None
    if len(args) < 2:
        raise SystemExit(__doc__)
    a = open(args[0], "rb").read()
    b = open(args[1], "rb").read()
    if len(a) != len(b):
        raise SystemExit(f"error: sizes differ ({len(a)} vs {len(b)}); "
                         "compare saves of the same format")
    base = slots_base(a)
    print(f"slot array at {base:#x}, {len(a)} bytes")
    report(a, b, base, only)


if __name__ == "__main__":
    main()
