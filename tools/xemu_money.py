#!/usr/bin/env python3
"""Find and patch the NFSU2 cash value in xemu's emulated Xbox RAM.

The Xbox builds of NFSU2 verify the save payload when loading, so a byte edit of
the save file is rejected. Only the game writes the signature, so the way to get a
large cash value accepted is: patch cash in the running game's memory, then Save
in-game. The game signs the new payload itself.

Usage (run on the machine hosting xemu, while NFSU2 is running):

    python3 xemu_money.py find                  # locate xemu + the 64 MB RAM regions
    python3 xemu_money.py scan <cash as shown>  # all u32 == cash in guest RAM
    python3 xemu_money.py narrow <new cash>     # after buying a part / winning a race
    python3 xemu_money.py peek                  # show the value at each candidate
    python3 xemu_money.py set <new cash>        # patch (needs a single candidate)
    python3 xemu_money.py known <cash>          # recorded candidates that match cash

Candidates are stored as (region index, guest offset), so they survive xemu
restarts: only the host base address moves with ASLR. After patching, Save in
game, then fetch the save and check offset 0xA19A (money).
"""
import argparse
import json
import os
import struct

GUEST_RAM_SIZE = 0x4000000
MAX_CASH = 2147483647
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xemu_money_state.json")


def ram_regions(pid):
    out = []
    try:
        for line in open(f"/proc/{pid}/maps"):
            p = line.split()
            if p[1] != "rw-p":
                continue
            lo, hi = (int(x, 16) for x in p[0].split("-"))
            if hi - lo == GUEST_RAM_SIZE:
                out.append((lo, hi))
    except Exception:
        return []
    return out


def xemu_pids():
    out = []
    for pid in sorted(int(d) for d in os.listdir("/proc") if d.isdigit()):
        try:
            comm = open(f"/proc/{pid}/comm").read().strip()
        except Exception:
            continue
        if "xemu" not in comm.lower() and comm != "AppRun":
            continue
        regions = ram_regions(pid)
        if regions:
            out.append((pid, comm, regions))
    return out


def read(pid, addr, n):
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        f.seek(addr)
        try:
            return f.read(n)
        except OSError:
            return b""


def write(pid, addr, data):
    with open(f"/proc/{pid}/mem", "wb", 0) as f:
        f.seek(addr)
        f.write(data)


def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return {"guest": [], "pid": None}


def save_state(st):
    json.dump(st, open(STATE, "w"))


def addr(st, cand):
    regions = ram_regions(st["pid"])
    return regions[cand[0]][0] + cand[1]


def scan(pid, base, cash):
    pat = struct.pack("<I", cash & 0xFFFFFFFF)
    hits = []
    pos = base
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        while pos < base + GUEST_RAM_SIZE:
            n = min(4 << 20, base + GUEST_RAM_SIZE - pos)
            f.seek(pos)
            try:
                buf = f.read(n)
            except OSError:
                pos += n
                continue
            if not buf:
                pos += n
                continue
            i = 0
            while True:
                j = buf.find(pat, i)
                if j < 0:
                    break
                hits.append(pos + j - base)
                i = j + 1
            pos += max(len(buf) - 4, 1)
    return hits


def show(cands):
    return [f"r{r}+{hex(g)}" for r, g in cands]


def cmd_find():
    ps = xemu_pids()
    if not ps:
        print("no xemu process with a 64 MB RAM region")
        return
    for pid, comm, regions in ps:
        print(f"pid {pid} ({comm})")
        for i, (lo, hi) in enumerate(regions):
            print(f"  r{i} {hex(lo)}-{hex(hi)}")
    st = load_state()
    if st["guest"]:
        print("recorded candidates:", show(st["guest"]))


def cmd_scan(cash):
    ps = xemu_pids()
    if not ps:
        print("xemu not running")
        return
    pid, _, regions = ps[0]
    cands = []
    for idx, (lo, _) in enumerate(regions):
        for g in scan(pid, lo, cash):
            cands.append([idx, g])
    save_state({"guest": cands, "pid": pid})
    print(f"cash {cash}: {len(cands)} candidates")
    print(show(cands[:20]))


def cmd_narrow(cash):
    st = load_state()
    if not st["guest"]:
        print("no candidates, run scan first")
        return
    v = cash & 0xFFFFFFFF
    keep = [c for c in st["guest"]
           if len(read(st["pid"], addr(st, c), 4)) == 4
           and struct.unpack("<I", read(st["pid"], addr(st, c), 4))[0] == v]
    st["guest"] = keep
    save_state(st)
    print(f"narrow {cash}: {len(keep)} candidate(s)")
    print(show(keep))


def cmd_known(cash):
    st = load_state()
    if not st["guest"]:
        print("nothing recorded, run scan")
        return
    keep = [c for c in st["guest"]
           if len(read(st["pid"], addr(st, c), 4)) == 4
           and struct.unpack("<I", read(st["pid"], addr(st, c), 4))[0] == cash]
    print(f"recorded candidates matching cash {cash}: {len(keep)}", show(keep))


def cmd_peek():
    st = load_state()
    for c in st["guest"]:
        a = addr(st, c)
        d = read(st["pid"], a, 4)
        print(f"r{c[0]}+{hex(c[1])} host {hex(a)}",
              struct.unpack("<I", d)[0] if len(d) == 4 else "unreadable")


def cmd_set(value, force=False):
    st = load_state()
    if not st["guest"]:
        print("no candidates")
        return
    if value < 1 or value > MAX_CASH:
        print(f"value must be 1..{MAX_CASH}")
        return
    if len(st["guest"]) > 1 and not force:
        print(f"{len(st['guest'])} candidates, narrow to 1 first (or pass --force)")
        return
    for c in st["guest"]:
        write(st["pid"], addr(st, c), struct.pack("<I", value))
    ok = [c for c in st["guest"]
          if len(read(st["pid"], addr(st, c), 4)) == 4
          and struct.unpack("<I", read(st["pid"], addr(st, c), 4))[0] == value]
    print(f"set {value}: verified at {len(ok)}/{len(st['guest'])} candidates")
    print("now Save in-game so the game signs the payload, then check offset 0xA19A in the file")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["find", "scan", "narrow", "known", "peek", "set"])
    ap.add_argument("value", type=int, nargs="?")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    if a.cmd == "find":
        cmd_find()
    elif a.cmd in ("scan", "narrow", "known"):
        if a.value is None:
            print("need the cash value")
        elif a.cmd == "scan":
            cmd_scan(a.value)
        elif a.cmd == "narrow":
            cmd_narrow(a.value)
        else:
            cmd_known(a.value)
    elif a.cmd == "peek":
        cmd_peek()
    elif a.cmd == "set":
        if a.value is None:
            print("need the new cash value")
        else:
            cmd_set(a.value, a.force)


main()
