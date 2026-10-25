# NFSU2 save format — PC vs Xbox (Switch port / original Xbox)

Everything below was derived by reverse-engineering 11 real saves (5 PC, 5 Switch
Xbox-port, 1 xemu) and is verified against them. The editor reads and writes both
formats; nothing on this page is a guess unless it is marked **unverified**.

## File layout

Both formats are one flat binary file with a header, then a payload. There is no
encryption. PC saves are not verified by the game; Xbox saves carry a per-save
40-byte signature that the game checks at load (see *Verification on Xbox*).

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
- Original Xbox (xemu): the first 20 bytes are **constant per profile**
  (`b6 a4 6e 67 60 c9 bb 3c 89 ff 28 9e 81 52 56 3b bf b3 72 4b` for the xemu
  profile — identical in XEMU2 and XEMU3, two saves the game wrote), and the
  remaining 40 bytes are the per-save signature.

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

Money is a **signed 32-bit** value: 2147483647 is the largest amount the game
shows, and anything above it appears as a negative number in game (confirmed on
PC). The editor rejects values outside 1..2147483647.

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

No payload checksum was found in any sample: scanning every byte position of the
payload and header for a stored u32 equal to `sum32`, `crc32`, `adler32`,
`xor32`, `sumu16` or `sumu32` of the payload/prefix/suffix produced no match on
the 7 Xbox saves, and the byte/xor deltas between the two xemu saves do not
appear anywhere in the payload. The PC format has no verification at all, which
is why the PC editor's edits load fine.

## Verification on Xbox (the important limitation)

The Xbox builds (Switch port and xemu) **verify the save when loading it**.
Editing money in a port save (500 / 10000 / 2147483647) makes the game refuse
it with "Unable to load SAVE". PC saves accept the same edits.

The header carries the pieces of that verification:

- 20 bytes that are **constant per profile**: all 5 Switch-port saves share
  `6d 93 ec 71 f2 c9 61 39 81 ea 1a 81 ca 06 39 51 05 a0 61 03`, and the two
  xemu saves share `b6 a4 6e 67 60 c9 bb 3c 89 ff 28 9e 81 52 56 3b bf b3 72 4b`.
  The values differ between the two profiles.
- 40 bytes that change **per save** (the signature).
- Copying a working port save folder into xemu makes it show up in the game's
  list (the name comes from `SaveMeta.xbx`) but loading returns
  "Unable to load SAVE" — consistent with a save bound to the profile that
  created it.

No standard checksum or hash (sum32, crc32, adler, xor, MD5, SHA-1/224/256/384/512,
SHA3, blake2b/s, plain or keyed, HMAC, over the payload, the header, with the
20-byte key as salt, self-referential zeroed variants, chunked/lane sums)
reproduces the 40 bytes from the payload, so the signature is game-specific and
cannot be recomputed from the Xbox samples available. `SaveMeta.xbx` is only
UTF-16 text `Name=<name>` + CRLF, and `saveimage.xbx` is a 4096-byte `XPR0`
thumbnail; neither contains a checksum, so the check is inside the game.

Signature shape (from the pair XEMU2 / XEMU3, same profile, both written by the
game): **all 40 signature bytes change** when the payload changes (28-byte
payload change with money 50 → 0 produced 149 changed payload bytes and a full
avalanche in the signature). That is hash-like behaviour, not sums/CRC, and the
key used is the 20-byte per-profile blob, so forging the signature needs the
algorithm, not just more samples.

Consequence: byte-level edits of an Xbox save are produced correctly by the
editor (verified on the bytes), but the game rejects them at load. The editor
shows a warning for Xbox saves.

### Slot folders the game accepts

The game stores each slot in `E:\UDATA\<title id>\<prefix + slot id>`: the first
slot was `004D149D1019`, the next `004D149D101A` (prefix `004D149D`, slot ids
`1019..101D`), and a folder the game created loads a **byte-identical** copy of
its own save (verified by md5 after upload). Folders with invented names show up
in the game's list (the name comes from `SaveMeta.xbx`, name ≤ 7 chars) but
loading them fails, and deleting them from in-game fails too. Max 5 slots.

### Money on original Xbox (xemu): the procedure that works

Because only the game writes the signature, the accepted way to change money is
to make the game save the value:

1. Run NFSU2 in xemu and load the save.
2. Find the cash variable in xemu's guest RAM: the 64 MB RAM block is a `rw-p`
   mapping of exactly `0x4000000` bytes in the xemu process, and the cash is a
   plain `u32` in it. Scan for the cash value shown in game, buy a part (or
   collect an SMS reward) to change it, filter by the new value — one address
   remains. Verified example: cash 50 → 75 narrowed 1028 candidates to 1, at
   guest offset `0x4b5364` of the RAM block (stable across restarts, only the
   host base moves).
3. Write the new cash (1..2147483647) to that address, confirm the game shows
   it, then **Save Game** in-game. The game writes the payload with the new
   money and a valid signature.
4. Boot the xemu dashboard (FTP server, one connection at a time, active mode)
   and read the save back.

Verified results: game-written saves with money `1000000` and `2147483647`
(both shown in game as such, both load normally). `tools/xemu_money.py`
automates steps 2-3 (`find` / `scan` / `narrow` / `set`); the xemu FTP client
used for step 4 is the active-mode client described in `tools/`.

## PC → Xbox conversion (unverified, not implemented)

Payload sizes differ by 1146 bytes:
`1146 = 60 + 1086` (a 60-byte PC-only block, plus a ~1086-byte PC tail).
Aligned regions: the first 32 payload bytes are identical; the payloads are ~93.5%
identical byte-by-byte; a PC block at payload `0xc4fc..0xc536` (a list-count byte at
`0xc4fb` = `0xcb` on PC vs `1` on Xbox) has no Xbox counterpart, and the PC tail
after payload 53844 (contains ASCII `DEST`) has no Xbox counterpart. The region
between them is per-save random, so a full mapping needs more matched pairs — the
conversion is left out on purpose.
