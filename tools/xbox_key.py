#!/usr/bin/env python3
"""Find the NFSU2 Xbox signing key in a RAM dump (raw dump or ELF core).

The save header identifies its own key:

    HMAC-SHA1(key, save[0x4C:0x54]) == save[0x10:0x24]

so a 16-byte key can be recognised without knowing anything else. The xemu
kernel key table starts at guest physical 0x3b018, so its entries are 8-byte
aligned (not 16) — hence the default scan step of 8. `--step 1` is exhaustive
and 8x slower.

Examples:
    # verify a key against a save
    xbox_key.py --save XEMU2 --key COLOQUE-AQUI-SEU-HEX-DE-32-DIGITOS

    # scan a raw 64 MB guest-RAM dump
    xbox_key.py --save XEMU2 --ram ram.bin --offset 0x3b000 --length 0x200

    # list the segments of an ELF core, then scan it
    xbox_key.py --save XEMU2 --elf core.123 --list
    xbox_key.py --save XEMU2 --elf core.123
    xbox_key.py --save XEMU2 --elf core.123 --segment 596
    xbox_key.py --save XEMU2 --elf core.123 --all-segments

By default an ELF core only has its 64 MB guest-RAM segment(s) scanned, which
is where xemu keeps the key table. Use --all-segments or --segment to widen it.
An exhaustive scan (`--step 1`, any byte alignment) is 8x slower.
"""

import argparse
import hashlib
import hmac
import multiprocessing as mp
import os
import struct
import sys
import time

MAGIC = b"20CM"
BLOB_OFF = 0x10
SIZES_OFF = 0x4C
PAYLOAD_OFF = 0x54
HEADER_SIZE = PAYLOAD_OFF
DIGEST_LEN = 20
KEY_LEN = 16


def load_save(path):
    data = open(path, "rb").read()
    if data[:4] != MAGIC:
        raise SystemExit("error: missing '20CM' magic")
    payload = int.from_bytes(data[0x0C:0x10], "little")
    if int.from_bytes(data[4:8], "little") != len(data) or len(data) - payload != HEADER_SIZE:
        raise SystemExit("error: not the Xbox layout (header must be 84 bytes)")
    return data[SIZES_OFF:PAYLOAD_OFF], data[BLOB_OFF:BLOB_OFF + DIGEST_LEN]


def key_matches(key, message, target):
    return hmac.new(key, message, hashlib.sha1).digest() == target


# Globals inherited by forked workers (Linux); avoids pickling the RAM dump.
_DATA = b""
_MESSAGE = b""
_TARGET = b""
_STEP = 8


def _scan_range(bounds):
    start, end = bounds
    found = []
    data, message, target, step = _DATA, _MESSAGE, _TARGET, _STEP
    for off in range(start, end, step):
        if hmac.new(data[off:off + KEY_LEN], message, hashlib.sha1).digest() == target:
            found.append(off)
    return found


def scan_buffer(data, message, target, step, jobs, label, base=0):
    """Return a list of (offset, key) pairs found in `data`."""
    global _DATA, _MESSAGE, _TARGET, _STEP
    if len(data) < KEY_LEN:
        return []
    jobs = max(1, jobs)
    chunk_candidates = 32768
    step = max(1, step)
    ranges = []
    start = 0
    span = chunk_candidates * step
    while start < len(data):
        ranges.append((start, min(start + span, len(data))))
        start += span

    t0 = time.time()
    results = []
    ctx = mp.get_context("fork") if "fork" in mp.get_all_start_methods() else mp.get_context()
    if ctx.get_start_method() == "fork":
        _DATA, _MESSAGE, _TARGET, _STEP = data, message, target, step
        with ctx.Pool(jobs) as pool:
            for found in pool.imap_unordered(_scan_range, ranges, chunksize=1):
                results.extend(found)
    else:  # pragma: no cover - non-fork platforms: sequential fallback
        _DATA, _MESSAGE, _TARGET, _STEP = data, message, target, step
        for rng in ranges:
            results.extend(_scan_range(rng))

    elapsed = time.time() - t0
    print(
        f"scanned {label}: {len(data):,} bytes in {elapsed:.1f}s "
        f"({jobs} job(s), step {step})",
        file=sys.stderr,
    )
    keys = []
    for off in results:
        keys.append((base + off, data[off:off + KEY_LEN]))
    return keys


def elf_segments(path):
    """Return PT_LOAD segments as dicts with file offsets and sizes."""
    with open(path, "rb") as f:
        header = f.read(64)
        if header[:4] != b"\x7fELF":
            raise SystemExit("error: not an ELF file")
        if header[4] != 2:
            raise SystemExit("error: only 64-bit ELF cores are supported")
        phoff = struct.unpack_from("<Q", header, 0x20)[0]
        phentsize, phnum = struct.unpack_from("<HH", header, 0x36)
        if phentsize < 56:
            raise SystemExit("error: unexpected ELF program-header size")
        segments = []
        for i in range(phnum):
            f.seek(phoff + i * phentsize)
            ph = f.read(phentsize)
            if len(ph) < 56:
                break
            p_type = struct.unpack_from("<I", ph, 0)[0]
            if p_type != 1:  # PT_LOAD
                continue
            p_offset, p_vaddr, p_paddr, p_filesz, p_memsz = struct.unpack_from(
                "<QQQQQ", ph, 8
            )
            if p_filesz == 0:
                continue
            segments.append(
                {
                    "index": i,
                    "offset": p_offset,
                    "vaddr": p_vaddr,
                    "filesz": p_filesz,
                    "memsz": p_memsz,
                }
            )
    return segments


def read_segment(path, segment, limit):
    size = segment["filesz"]
    if limit:
        size = min(size, limit)
    with open(path, "rb") as f:
        f.seek(segment["offset"])
        return f.read(size)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Find or verify the 16-byte key that signs NFSU2 Xbox saves."
    )
    parser.add_argument("--save", required=True, help="Xbox save used as the fingerprint")
    parser.add_argument("--key", help="verify this 32-hex key instead of scanning")
    parser.add_argument("--ram", help="raw RAM dump to scan")
    parser.add_argument("--elf", help="ELF core dump to scan")
    parser.add_argument("--offset", type=lambda s: int(s, 0), default=0,
                        help="start offset inside --ram (default 0)")
    parser.add_argument("--length", type=lambda s: int(s, 0),
                        help="bytes to scan from --offset (default: to EOF)")
    parser.add_argument("--step", type=int, default=8,
                        help="byte stride; 8 covers the kernel key table, 1 is exhaustive")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    parser.add_argument("--segment", type=int, action="append",
                        help="scan only this ELF segment index (repeatable)")
    parser.add_argument("--list", action="store_true", help="list ELF segments and exit")
    parser.add_argument("--all-segments", action="store_true",
                        help="scan every ELF segment (default: the 64 MB guest-RAM ones)")
    parser.add_argument("--max-segment-mb", type=int, default=128,
                        help="skip ELF segments larger than this (0 = no limit)")
    parser.add_argument("--min-segment-mb", type=int, default=16,
                        help="skip ELF segments smaller than this (0 = no limit)")
    args = parser.parse_args(argv)

    message, target = load_save(args.save)

    if args.key:
        clean = "".join(c for c in args.key if c in "0123456789abcdefABCDEF")
        if len(clean) != 32:
            raise SystemExit("error: the key must be 32 hex characters")
        key = bytes.fromhex(clean)
        print(f"key: {key.hex()}")
        print(f"blob match: {key_matches(key, message, target)}")
        data = open(args.save, "rb").read()
        siga = hmac.new(key, data[PAYLOAD_OFF:], hashlib.sha1).digest()
        sigb = hmac.new(key, data[:0x38], hashlib.sha1).digest()
        print(f"sigA match: {siga == data[0x24:0x38]}")
        print(f"sigB match: {sigb == data[0x38:0x4C]}")
        return 0 if key_matches(key, message, target) else 1

    if not args.ram and not args.elf:
        raise SystemExit("error: pass --ram, --elf or --key")

    hits = []

    if args.ram:
        with open(args.ram, "rb") as f:
            if args.offset:
                f.seek(args.offset)
            data = f.read(args.length) if args.length else f.read()
        hits += scan_buffer(
            data, message, target, args.step, args.jobs,
            f"{args.ram}[{args.offset:#x}]", base=args.offset,
        )

    if args.elf:
        segments = elf_segments(args.elf)
        if args.list:
            for seg in segments:
                print(
                    f"segment {seg['index']:3d}: offset={seg['offset']:#x} "
                    f"vaddr={seg['vaddr']:#x} filesz={seg['filesz']:#x} "
                    f"memsz={seg['memsz']:#x}"
                )
            if not hits:
                return 0
        limit = args.max_segment_mb * 1024 * 1024 if args.max_segment_mb else 0
        min_size = args.min_segment_mb * 1024 * 1024 if args.min_segment_mb else 0
        if args.segment:
            selected = [seg for seg in segments if seg["index"] in args.segment]
        else:
            selected = [
                seg for seg in segments
                if seg["filesz"] >= min_size and (not limit or seg["filesz"] <= limit)
            ]
            guest_ram = [seg for seg in selected if seg["filesz"] == 0x4000000]
            if guest_ram and not args.all_segments:
                selected = guest_ram
                print(
                    "using the 64 MB guest-RAM segment(s); "
                    "pass --all-segments to scan everything",
                    file=sys.stderr,
                )
        if not selected and not args.list:
            raise SystemExit(
                "error: no segment selected (use --list, --segment, "
                "--min-segment-mb or --max-segment-mb)"
            )
        if selected and not args.list:
            print(
                f"scanning {len(selected)} segment(s) "
                f"({sum(s['filesz'] for s in selected):,} bytes)",
                file=sys.stderr,
            )
        for seg in selected:
            data = read_segment(args.elf, seg, limit)
            label = (
                f"{args.elf} segment {seg['index']} "
                f"(file {seg['offset']:#x}, vaddr {seg['vaddr']:#x})"
            )
            hits += scan_buffer(
                data, message, target, args.step, args.jobs, label,
                base=seg["offset"],
            )

    if not hits:
        print("no key found", file=sys.stderr)
        return 1

    seen = set()
    save = open(args.save, "rb").read()
    for offset, key in hits:
        if key in seen:
            continue
        seen.add(key)
        blob_ok = key_matches(key, message, target)
        siga_ok = hmac.new(key, save[PAYLOAD_OFF:], hashlib.sha1).digest() == save[0x24:0x38]
        sigb_ok = hmac.new(key, save[:0x38], hashlib.sha1).digest() == save[0x38:0x4C]
        print(
            f"key {key.hex()} at dump offset {offset:#x} "
            f"(blob={blob_ok} sigA={siga_ok} sigB={sigb_ok})"
        )
    print("use it with: tools/xbox_sign.py sign <save> -k <key>", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
