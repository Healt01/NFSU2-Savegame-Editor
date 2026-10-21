# NFSU2 save format — PC vs Xbox (Switch port / original Xbox)

Everything below was derived by reverse-engineering 11 real saves (5 PC, 5 Switch
Xbox-port, 1 xemu) and is verified against them. The editor reads and writes both
formats; nothing on this page is a guess unless it is marked **unverified**.

## File layout

Both formats are one flat binary file with a header, then a payload. There is no
encryption and no checksum that the game validates (see *Checksums* below).

```
offset  field                       PC          Xbox (port / xemu)
0x00    magic                       "20CM"      "20CM"
0x04    u32  total file size        54966       53868
0x08    u32  version                8           8
0x0C    u32  payload size           54930       53784
0x10    key blob                    12 bytes    60 bytes
...     u32  constant 269 (0x10D)   0x1C        0x4C
...     u32  payload size (repeat)  0x20        0x50
0x24/0x54  payload starts
```

So `header = total size - payload size` = **36 (PC)** or **84 (Xbox)**. That is the
detection rule used by the editor: magic + version 8 + `size - payload == 36/84`.

The key blob:

- PC: 4 constant bytes `bb c0 87 f2` + 8 per-save random bytes.
- Xbox port: 20 constant bytes
  `6d 93 ec 71 f2 c9 61 39 81 ea 1a 81 ca 06 39 51 05 a0 61 03`
  + 40 per-save random bytes.
- Original Xbox (xemu): the whole blob is per-save random (no constant prefix).

The editor never touches the header.

## Field offsets

Offsets are **file offsets** (header included). Payload offsets = file offset −
header size.

| Field                | PC file   | Xbox file  | Payload offset |
|----------------------|-----------|------------|----------------|
| Money (u32 LE)       | `0xA16A`  | `0xA19A`   | `0xA146`       |
| Profile name         | `0xD225`  | `0xD219`   | `0xD201` / `0xD1C5` |
| Name field size      | 16 bytes  | 8 bytes    |                |
| Name max length      | 15 chars  | 7 chars    |                |
| Car slot array       | `0x5AEC`  | `0x5B1C`   | `0x5A88` / `0x5AC8` |
| Slot size            | `0x7F2`   | `0x7F2`    |                |
| Slot count           | 5         | 5          |                |
| Performance block    | slot + `0x94` | slot + `0x94` | 68 bytes  |

Name rules (verified in-game values): PC names keep their case, max 15 chars,
zero-padded to 16 bytes. Xbox names are uppercase, max 7 chars, zero-padded to 8
bytes. The editor uppercases + truncates Xbox names before writing.

## Slot array

5 slots of 2034 bytes each, at `slots + i * 0x7F2`.

A slot header is 20 bytes, same layout in both formats:

```
0..7   per-car id bytes (8 bytes, obfuscated — not the numeric car id)
8..19  3e 96 ac a5  3e 96 ac a5  3e 96 ac a5  9b fa 71 24   (constant tail)
```

A **locked** slot has all 20 header bytes zero. The rest of the slot body is *not*
zero in real saves (a locked slot in a fresh save has ~200-500 non-zero bytes), so
the editor writes only the 20-byte header when unlocking and never clears the body.

Unlocking copies the header of slot 0 (the car in slot 0, usually the Nissan 240SX,
`38 39 26 3d 3e 96 ac a5 …`). If slot 0 is also locked — the xemu case, where every
slot header is zero — the editor uses the built-in template header above.

`Car Slots Used` = number of slots with a non-zero header.

## Performance block

68 bytes at `slot base + 0x94`, one byte per stat, `0` = empty, `1` = filled.
"Nill out" writes 0, "Max out" writes 1. Real maxed blocks are not 68 ones (real
saves mix 0/1 per bar); "Max out" fills every bar.

## Checksums

No checksum was found. Sums, CRC32 and the header key blob do not correlate with the
payload, and xemu writes zeros in regions that are non-zero in the PC template. The
game does not appear to verify the payload, which is why the PC tool works.

## PC → Xbox conversion (unverified, not implemented)

Payload sizes differ by 1146 bytes:
`1146 = 60 + 1086` (a 60-byte PC-only block, plus a ~1086-byte PC tail).
Aligned regions: the first 32 payload bytes are identical; the payloads are ~93.5%
identical byte-by-byte; a PC block at payload `0xc4fc..0xc536` (a list-count byte at
`0xc4fb` = `0xcb` on PC vs `1` on Xbox) has no Xbox counterpart, and the PC tail
after payload 53844 (contains ASCII `DEST`) has no Xbox counterpart. The region
between them is per-save random, so a full mapping needs more matched pairs — the
conversion is left out on purpose.
