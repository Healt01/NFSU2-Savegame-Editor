#!/usr/bin/env python3
"""Find, extract or replace NFSU2 saves inside a disk image.

The usual way to move saves in and out of xemu is the dashboard's FTP server,
but that only runs while the dashboard is up. This tool works offline, directly
on the image, and is what was used to prove in game that the editor's re-signed
saves are accepted (see FORMAT.md). Two image kinds are supported:

- a qcow2 image (xemu's `xbox_hdd.qcow2`), where a guest offset is remapped to
  the file's clusters,
- a raw image, mapped 1:1 — for example the Switch port's FATX partition image
  (`sdmc:/switch/nfsu2x/save/Partition0.img`, `E:\\` in `kernel_path.c`).

`replace` only overwrites the clusters a save already occupies, so the FATX
directory entry, file name and cluster chain stay untouched. The new file must
therefore have the same byte length as the old one (NFSU2 saves always do:
53868 bytes on Xbox, 54966 on PC).

Stop xemu/the port before using this (the image must not be open), and keep a
copy of the image the first time.

Examples:
    hdd_save.py list ~/Xbox/hdd/xbox_hdd.qcow2
    hdd_save.py dump ~/Xbox/hdd/xbox_hdd.qcow2 XEMU.bin --offset 0xac043000
    hdd_save.py replace ~/Xbox/hdd/xbox_hdd.qcow2 edited.bin --offset 0xac043000 --yes
    hdd_save.py list ~/sd/switch/nfsu2x/save/Partition0.img --key 00000000000000000000000000000000
"""

import argparse
import hashlib
import hmac
import os
import struct
import sys

MAGIC = b"20CM"
XBOX_HEADER = 84
PC_HEADER = 36
GUEST_RAM_KEY = None  # per-profile; pass --key to verify signatures

BLOB_OFF, SIGA_OFF, SIGB_OFF, SIZES_OFF, PAYLOAD_OFF = 0x10, 0x24, 0x38, 0x4C, 0x54


class DiskImage:
    """Read/cluster-map a disk image: qcow2, or a raw image mapped 1:1.

    A raw image (for example the Switch port's `Partition0.img`, a FATX
    partition) is treated as a flat file: guest offset == file offset.
    """

    def __init__(self, path):
        self.path = path
        self.f = open(path, "rb")
        hdr = self.f.read(0x80)
        self.cluster_size = 65536
        self.raw = not (len(hdr) >= 0x80 and struct.unpack(">I", hdr[:4])[0] == 0x514649FB)
        if self.raw:
            self.vsize = os.path.getsize(path)
            # Include the partial tail cluster, so a file smaller than one
            # cluster is still scanned.
            self.map = {i: i * self.cluster_size
                        for i in range((self.vsize + self.cluster_size - 1) // self.cluster_size)}
            return
        self.version = struct.unpack(">I", hdr[4:8])[0]
        self.cluster_bits = struct.unpack(">I", hdr[0x14:0x18])[0]
        self.cluster_size = 1 << self.cluster_bits
        self.vsize = struct.unpack(">Q", hdr[0x18:0x20])[0]
        self.crypt = struct.unpack(">I", hdr[0x20:0x24])[0]
        if self.crypt:
            raise SystemExit("error: encrypted qcow2 images are not supported")
        l1_size = struct.unpack(">I", hdr[0x24:0x28])[0]
        l1_off = struct.unpack(">Q", hdr[0x28:0x30])[0]
        self.f.seek(l1_off)
        l1 = struct.unpack(">%dQ" % l1_size, self.f.read(8 * l1_size))
        self.map = {}
        for i, entry in enumerate(l1):
            off = entry & 0x00FFFFFFFFFFFE00
            if not off:
                continue
            self.f.seek(off)
            table = struct.unpack(">%dQ" % (self.cluster_size // 8),
                                  self.f.read(self.cluster_size))
            for j, le in enumerate(table):
                if le & 0x4000000000000000:
                    raise SystemExit(
                        "error: compressed qcow2 clusters are not supported"
                    )
                lo = le & 0x00FFFFFFFFFFFE00
                if lo:
                    self.map[(i << (self.cluster_bits - 3)) + j] = lo

    def read(self, guest_off, n):
        out = bytearray()
        pos, end = guest_off, guest_off + n
        while pos < end:
            ci = pos // self.cluster_size
            within = pos % self.cluster_size
            take = min(self.cluster_size - within, end - pos)
            host = self.map.get(ci)
            if host is None:
                out += b"\x00" * take
            else:
                self.f.seek(host + within)
                out += self.f.read(take)
            pos += take
        return bytes(out)

    def write(self, guest_off, data):
        touched = 0
        with open(self.path, "r+b") as f:
            pos, end = guest_off, guest_off + len(data)
            src = memoryview(data)
            while pos < end:
                ci = pos // self.cluster_size
                within = pos % self.cluster_size
                take = min(self.cluster_size - within, end - pos)
                host = self.map.get(ci)
                if host is None:
                    raise SystemExit(
                        f"error: guest cluster {ci:#x} is not allocated; refusing to write"
                    )
                if host + within + take > self.vsize:
                    raise SystemExit(
                        f"error: writing past the end of the image "
                        f"({host + within + take:#x} > {self.vsize:#x})"
                    )
                f.seek(host + within)
                f.write(src[pos - guest_off:pos - guest_off + take])
                touched += 1
                pos += take
            f.flush()
            os.fsync(f.fileno())
        return touched


def parse_header(data):
    if len(data) < PAYLOAD_OFF or data[:4] != MAGIC:
        return None
    total, version, payload = struct.unpack_from("<III", data, 4)
    if version != 8 or total != len(data):
        return None
    header = total - payload
    if header not in (PC_HEADER, XBOX_HEADER):
        return None
    return header


def verify_xbox(data, key):
    if key is None or len(data) < PAYLOAD_OFF:
        return None
    blob = hmac.new(key, data[SIZES_OFF:PAYLOAD_OFF], hashlib.sha1).digest()
    siga = hmac.new(key, data[PAYLOAD_OFF:], hashlib.sha1).digest()
    sigb = hmac.new(key, data[:SIGB_OFF], hashlib.sha1).digest()
    return (blob == data[BLOB_OFF:BLOB_OFF + 20],
            siga == data[SIGA_OFF:SIGA_OFF + 20],
            sigb == data[SIGB_OFF:SIGB_OFF + 20])


def scan(image, key):
    q = DiskImage(image)
    saves = []
    for ci in sorted(q.map):
        guest = ci * q.cluster_size
        data = q.read(guest, q.cluster_size)
        start = 0
        while True:
            j = data.find(MAGIC, start)
            if j < 0:
                break
            off = guest + j
            head = q.read(off, PAYLOAD_OFF)
            if len(head) == PAYLOAD_OFF:
                total, version, payload = struct.unpack_from("<III", head, 4)
                hdr = total - payload
                if version == 8 and hdr in (PC_HEADER, XBOX_HEADER) and 40000 <= total <= 60000:
                    blob = q.read(off, total)
                    if parse_header(blob):
                        saves.append((off, blob, hdr))
            start = j + 1
    return q, saves


def describe(off, blob, hdr, key):
    name = blob[0xD219:0xD219 + 16].split(b"\0")[0].decode("latin-1", "replace")
    money = struct.unpack_from("<i", blob, 0xA19A if hdr == XBOX_HEADER else 0xA16A)[0]
    sig = verify_xbox(blob, key) if hdr == XBOX_HEADER else None
    sigtxt = "" if sig is None else " sig=" + ("OK" if all(sig) else "MISMATCH")
    return (f"offset={off:#x} size={len(blob)} format={'xbox' if hdr == XBOX_HEADER else 'pc'} "
            f"name={name!r} money={money}{sigtxt} sha1={hashlib.sha1(blob).hexdigest()[:16]}")


def pick(saves, args):
    if args.offset is not None:
        for off, blob, hdr in saves:
            if off == args.offset:
                return off, blob, hdr
        raise SystemExit(f"error: no save starts at {args.offset:#x}")
    if args.index is None:
        raise SystemExit("error: pass --offset 0x... (see `list`) or --index N")
    if not 0 <= args.index < len(saves):
        raise SystemExit(f"error: index out of range (found {len(saves)} saves)")
    return saves[args.index]


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Find/extract/replace NFSU2 saves inside an xemu qcow2 HDD image."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_key(p):
        p.add_argument("--key", help="32 hex chars to verify Xbox signatures")

    p_list = sub.add_parser("list", help="list the saves in the image")
    p_list.add_argument("image")
    add_key(p_list)

    p_dump = sub.add_parser("dump", help="extract one save")
    p_dump.add_argument("image")
    p_dump.add_argument("output")
    p_dump.add_argument("--offset", type=lambda s: int(s, 0))
    p_dump.add_argument("--index", type=int)
    add_key(p_dump)

    p_rep = sub.add_parser("replace", help="overwrite one save in place (same length)")
    p_rep.add_argument("image")
    p_rep.add_argument("file")
    p_rep.add_argument("--offset", type=lambda s: int(s, 0))
    p_rep.add_argument("--index", type=int)
    p_rep.add_argument("--yes", action="store_true", help="confirm the write")
    add_key(p_rep)

    args = parser.parse_args(argv)
    key = None
    if args.key:
        clean = "".join(c for c in args.key if c in "0123456789abcdefABCDEF")
        if len(clean) != 32:
            raise SystemExit("error: the key must be 32 hex characters")
        key = bytes.fromhex(clean)

    q, saves = scan(args.image, key)

    if args.command == "list":
        print(f"{len(saves)} save(s) in {args.image}")
        for off, blob, hdr in saves:
            print("  " + describe(off, blob, hdr, key))
        return 0

    off, blob, hdr = pick(saves, args)

    if args.command == "dump":
        open(args.output, "wb").write(blob)
        print(f"wrote {args.output} ({len(blob)} bytes) from {off:#x}")
        return 0

    new = open(args.file, "rb").read()
    if not parse_header(new):
        raise SystemExit("error: the new file is not a valid NFSU2 save")
    if len(new) != len(blob):
        raise SystemExit(
            f"error: length differs (image has {len(blob)} bytes, file has {len(new)}); "
            "only in-place replacement is supported"
        )
    if not args.yes:
        raise SystemExit(
            "refusing to write without --yes. Stop xemu and back up the image first."
        )
    touched = q.write(off, new)
    back = DiskImage(args.image).read(off, len(new))
    if back != new:
        raise SystemExit("error: read-back differs; restore the image from your backup")
    sig = verify_xbox(back, key) if key and hdr == XBOX_HEADER else None
    sigtxt = "" if sig is None else " sig=" + ("OK" if all(sig) else "MISMATCH")
    print(f"replaced save at {off:#x} ({len(new)} bytes, {touched} clusters) "
          f"sha1={hashlib.sha1(back).hexdigest()}{sigtxt}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
