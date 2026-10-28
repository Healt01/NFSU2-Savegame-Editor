#!/usr/bin/env python3
"""Sign or verify an NFSU2 Xbox save (Switch port / original Xbox / xemu).

The Xbox header carries three HMAC-SHA1 digests (see FORMAT.md):

    blob @0x10 = HMAC-SHA1(key, file[0x4C:0x54])   # u32 269, u32 payload size
    sigA @0x24 = HMAC-SHA1(key, file[0x54:])       # payload
    sigB @0x38 = HMAC-SHA1(key, file[0x00:0x38])   # magic .. sigA

The game writes them in that order; sigB covers the other two, so it must be
computed last.

Examples:
    xbox_sign.py verify XEMU2 -k <your-32-hex-key>
    xbox_sign.py sign   XEMU2 -k <your-32-hex-key> -o XEMU2.signed
    xbox_sign.py sign   XEMU2 -k @key.txt -o XEMU2.signed

The Switch port signs with an all-zero key: `-k 00000000000000000000000000000000`.
For xemu the key is per-install; `tools/xbox_key.py` extracts it from a RAM dump.
"""

import argparse
import hashlib
import hmac
import pathlib
import sys

MAGIC = b"20CM"
BLOB_OFF = 0x10
SIGA_OFF = 0x24
SIGB_OFF = 0x38
SIZES_OFF = 0x4C
PAYLOAD_OFF = 0x54
HEADER_SIZE = PAYLOAD_OFF  # 84
DIGEST_LEN = 20


def parse_key(text):
    raw = text.strip()
    if raw.startswith("@"):
        raw = pathlib.Path(raw[1:]).read_text(encoding="ascii")
    clean = "".join(c for c in raw if c in "0123456789abcdefABCDEF")
    if len(clean) != 32:
        raise SystemExit("error: the key must be 32 hex characters (16 bytes)")
    return bytes.fromhex(clean)


def check_save(data):
    if len(data) < PAYLOAD_OFF:
        raise SystemExit("error: file is too small to be an NFSU2 Xbox save")
    if data[:4] != MAGIC:
        raise SystemExit("error: missing '20CM' magic")
    total = int.from_bytes(data[4:8], "little")
    payload = int.from_bytes(data[0x0C:0x10], "little")
    if total != len(data) or len(data) - payload != HEADER_SIZE:
        raise SystemExit(
            "error: not the Xbox layout "
            f"(size={len(data)}, header={len(data) - payload}, expected 84)"
        )


def digest_fields(data, key):
    return {
        "blob": hmac.new(key, data[SIZES_OFF:PAYLOAD_OFF], hashlib.sha1).digest(),
        "sigA": hmac.new(key, data[PAYLOAD_OFF:], hashlib.sha1).digest(),
        "sigB": hmac.new(key, data[:SIGB_OFF], hashlib.sha1).digest(),
    }


def verify_fields(data, key):
    want = digest_fields(data, key)
    got = {
        "blob": data[BLOB_OFF:BLOB_OFF + DIGEST_LEN],
        "sigA": data[SIGA_OFF:SIGA_OFF + DIGEST_LEN],
        "sigB": data[SIGB_OFF:SIGB_OFF + DIGEST_LEN],
    }
    return {name: want[name] == got[name] for name in want}


def sign_bytes(data, key):
    out = bytearray(data)
    fields = digest_fields(out, key)
    out[BLOB_OFF:BLOB_OFF + DIGEST_LEN] = fields["blob"]
    out[SIGA_OFF:SIGA_OFF + DIGEST_LEN] = fields["sigA"]
    # sigB must be computed from the final header, after blob and sigA.
    out[SIGB_OFF:SIGB_OFF + DIGEST_LEN] = hmac.new(
        key, out[:SIGB_OFF], hashlib.sha1
    ).digest()
    return bytes(out)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Sign or verify an NFSU2 Xbox save (HMAC-SHA1 header)."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_verify = sub.add_parser("verify", help="check the three header digests")
    p_verify.add_argument("save", help="save file to read")
    p_verify.add_argument("-k", "--key", required=True, help="32 hex chars or @file")

    p_sign = sub.add_parser("sign", help="recompute the three header digests")
    p_sign.add_argument("save", help="save file to read")
    p_sign.add_argument("-k", "--key", required=True, help="32 hex chars or @file")
    p_sign.add_argument("-o", "--output", help="write here (default: in place)")

    args = parser.parse_args(argv)
    key = parse_key(args.key)
    data = pathlib.Path(args.save).read_bytes()
    check_save(data)

    if args.command == "verify":
        result = verify_fields(data, key)
        for name, value in result.items():
            print(f"{name}: {'OK' if value else 'MISMATCH'}")
        return 0 if all(result.values()) else 1

    if not all(verify_fields(data, key).values()):
        print(
            "warning: the key does not match the existing signature "
            "(wrong key, or the save was already edited); signing anyway",
            file=sys.stderr,
        )

    signed = sign_bytes(data, key)
    if args.output:
        pathlib.Path(args.output).write_bytes(signed)
        target = args.output
    else:
        pathlib.Path(args.save).write_bytes(signed)
        target = args.save
    changed = sum(1 for a, b in zip(data, signed) if a != b)
    result = verify_fields(signed, key)
    print(f"signed {target} ({changed} bytes changed); verify: "
          + ", ".join(f"{k}={'OK' if v else 'BAD'}" for k, v in result.items()))
    return 0 if all(result.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
