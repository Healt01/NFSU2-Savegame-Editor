# NFSU2 save format — PC vs Xbox (Switch port / original Xbox)

Everything below was derived by reverse-engineering real saves (6 PC, 5 Switch
Xbox-port, 4 xemu) plus a fifth game-written xemu save captured from RAM. The
editor reads and writes both formats; nothing on this page is a guess unless it
is marked **unverified**.

## File layout

Both formats are one flat binary file with a header, then a payload. There is no
encryption. PC saves are not verified by the game; Xbox saves carry three
HMAC-SHA1 fields (60 bytes) that the game checks at load (see
*Verification on Xbox*).

```
offset  field                       PC          Xbox (port / xemu)
0x00    magic                       "20CM"      "20CM"
0x04    u32  total file size        54966       53868
0x08    u32  version                8           8
0x0C    u32  payload size           54930       53784
0x10    signature blob              12 bytes    20 bytes (HMAC)
0x24    signature A                 —           20 bytes (HMAC)
0x38    signature B                 —           20 bytes (HMAC)
0x4C    u32  constant 269 (0x10D)    0x1C        0x4C
0x50    u32  payload size (repeat)   0x20        0x50
0x24/0x54  payload starts
```

So `header = total size - payload size` = **36 (PC)** or **84 (Xbox)**. That is the
detection rule used by the editor: magic + version 8 + `size - payload == 36/84`.

The header fields:

- **PC**: 12-byte blob, 4 constant bytes `bb c0 87 f2` + 8 per-save random bytes.
  PC saves are not verified, so the blob has no known function.
- **Xbox**: three 20-byte HMAC-SHA1 digests (blob, signature A, signature B). They
  are not random and not a key: see *Verification on Xbox* below.

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
PC). `2147483647` is read and shown as such on the Switch port as well (in-game
test, 2026-10-25). The editor rejects values outside 1..2147483647.

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

68 bytes at `slot base + 0x94`, one byte per upgrade part, `0` = not installed,
`1` = installed. "Nill out" writes 0, "Max out" writes 1.

Verified on real saves (17 slots from PC, xemu and Switch-port saves): a
game-written maxed car has ~40 flags set, not 68, and flags 34 and 35 are never
set. Parts in the same slot are exclusive (e.g. *Performance Exhaust* and *Cat
Back Exhaust System* cannot both be installed), so filling all 68 flags is **not
a state the game produces**.

In-game on the Switch port (2026-10-25), a maxed-out block is accepted: the save
loads, the garage shows every part as *Installed*, and conflicting parts are
shown installed together, which the upgrade menu refuses to produce legitimately.
Race behaviour with a maxed-out block is **not tested**. The garage bars
(Acceleration / Top Speed / Handling) and Visual Rating come from other slot
fields, not from these flags.

The exclusive groups cannot be derived from the samples available: a
"never co-occurs" clustering over 17 slots produced one component of 54 flags.
Decoding needs the game's part table, or saves with single-part changes made in
the upgrade menu.

## Checksums

No checksum field exists: no stored u32 in any sample equals `sum32`, `crc32`,
`adler32`, `xor32`, `sumu16` or `sumu32` of the payload/prefix/suffix. The PC
format has no verification at all, which is why PC edits load fine. The Xbox
format instead carries three HMAC-SHA1 digests in the header.

## Verification on Xbox: HMAC-SHA1 (verified)

The Xbox builds (Switch port and xemu) verify the save when loading it. The 60
bytes at `0x10..0x4C` are three **HMAC-SHA1** digests made with a 16-byte key
`K` that belongs to the profile (console or emulator), not to the save:

| File offset | Field | Formula (HMAC-SHA1, 20 bytes) |
|-------------|-------|-------------------------------|
| `0x10` | blob | `HMAC(K, file[0x4C..0x54])` — the 8 bytes `269, 53784` |
| `0x24` | sigA | `HMAC(K, file[0x54..EOF])` — the whole payload |
| `0x38` | sigB | `HMAC(K, file[0x00..0x38])` — header up to sigA |

The game writes them in that order: `blob` and `sigA` first, `sigB` last (it
covers the other two). Verified on five saves written by the game itself
(`XEMU`, `XEMU2` twice, money `1000000`, money `2147483647`): recomputing the
three fields with the key below reproduces each file **byte for byte**, and
changing one payload byte invalidates `sigA`/`sigB` until they are recomputed.
The editor re-signs in exactly this order; its "Xbox Signature" pill shows
`valid ✓`, `modified — will re-sign`, `re-signed (unverified key)`, `key
mismatch` or `no key`.

### End-to-end test in game (xemu)

The signature was also verified the hard way, by loading editor-signed saves in
NFSU2 running in xemu 0.8.137 (retail BIOS, USA XISO, 8 GiB qcow2 HDD). The
game's only save, profile `XEMU` (money 0), was patched inside the HDD image at
guest offset `0xac043000` with `tools/hdd_save.py`:

| Variant | Money | Signature | Result in game |
|---------|-------|-----------|----------------|
| A | 77777 | left untouched | **"Unable to load XEMU."** |
| B | 77777 | recomputed with the key | **"XEMU has been loaded successfully."** |

Variant B went on to the main menu with the profile and its car, and the game's
cash variable in guest RAM was `77777` (at guest offset `0x4b6364` of the 64 MB
RAM block; see the caveat about that address under *Money on original Xbox*
below). So the three HMAC fields are exactly what the game checks, and a
re-signed save is accepted with the edited payload.

### End-to-end test in game (Switch port)

Same pair of controls on real hardware, with the `nfsu2-sw` port on a modded
Switch (CNX). The card was exposed to Linux through Hekate's USB Mass Storage,
and the save `HEALT` in slot `004110E4103B` (money `36127`) was patched **in
place** — same byte length, only the fields that had to change, so the FAT
directory entry and cluster chain stay as the game left them:

| Variant | Money | Signature | Result in game |
|---------|-------|-----------|----------------|
| A | 100000 | left untouched (`sigA` fails) | **"Unable to load HEALT."** |
| B | 100000 | recomputed with the all-zero key | loads, garage shows **100,000** |

Variant A changes 4 bytes; variant B adds the `sigA` and `sigB` digests
(40 bytes total, `0x24..0x4B`). The `blob` field does not change in either
variant, because the two size fields are untouched. The port checks the same
three HMAC fields as xemu, and the all-zero key is accepted by the game.

Why this was missed at first: the 20 bytes at `0x10` look like a per-profile key
and are constant across saves of the same profile, but they are just
`HMAC(K, sizes)` — constant because the two size fields are constant. Using
that blob as the HMAC key cannot reproduce anything.

### The key

For the xemu profile used by the samples here:

```
K = COLOQUE-AQUI-SEU-HEX-DE-32-DIGITOS
```

It is **not** in `default.xbe` and **not** stored raw in `eeprom.bin`. xemu
builds a 17-entry table of 16-byte keys in guest RAM at physical address
`0x3b018` at boot; the default key is entry 16 (`0x3b118`). A different xemu
install (different `eeprom.bin`) can derive a different key, and a real console
uses its own EEPROM/HDD key, so extract the key from the machine that wrote the
save. `tools/xbox_key.py` finds and verifies it from a RAM dump.

The Switch port (`nfsu2-sw`, static recomp of the Xbox game) signs with an
**all-zero key**:

```
K = 00000000000000000000000000000000
```

That is why all 5 port samples share the blob `6d93ec71f2c9613981ea1a81ca06395105a06103`
and all three digests verify with the zero key. The port's kernel stubs
`xbox_EEPROMKey[16] = {0}` (`xboxrecomp/src/kernel/kernel_xbox.c`) and the DES
key-derivation calls are stubs, so the game ends up hashing with a zero key. An
HMAC key shorter than the 64-byte block is zero-padded, so any all-zero key of
length 0..64 gives the same digests — the 16-byte form is what `tools/xbox_sign.py`
and the editor's "Fill port key" button use.

The port keeps its saves as **plain folders**, not inside a partition image:
`\Device\Harddisk0\Partition1\` (`E:\`, where `UDATA` lives) is mapped to the
**game** directory (`xboxrecomp/src/kernel/kernel_path.c`), so a save slot is
`sdmc:/switch/nfsu2x/game/UDATA/<titleid>/<prefix+slot>/<profile name>`, next to
`saveimage.xbx` and `SaveMeta.xbx`. On this card, verified:
`switch/nfsu2x/game/UDATA/4541005a/004110E4103B/HEALT`. `sdmc:/switch/nfsu2x/save/`
holds `TitleData/`, `UserData/`, `Cache/` and the (tiny, empty) `Partition*.img`
files — the game does not read saves from them. An edited + re-signed save can
therefore be copied onto the SD card with ordinary file tools, no FTP, no image.
Access the card from Linux with Hekate's USB Mass Storage (the card shows up as a
block device; mount it read-only first, and unmount before rebooting the Switch).

### How the key is found

For each 16-byte candidate `c` in a RAM dump, check
`HMAC-SHA1(c, save[0x4C..0x54]) == save[0x10..0x24]`. The blob therefore
identifies the key/profile. `tools/xbox_key.py` scans a dump this way; for the
samples here the match was the kernel default key at physical `0x3b118`.

### Slot folders the game accepts

The game stores each slot in `E:\UDATA\<title id>\<prefix + slot id>`: the first
slot was `004D149D1019`, the next `004D149D101A` (prefix `004D149D`, slot ids
`1019..101D`). A folder the game created loads a **byte-identical** copy of its
own save (verified by md5 after upload). Max 5 slots. `SaveMeta.xbx` is only
UTF-16 text `Name=<name>` + CRLF and `saveimage.xbx` is a 4096-byte `XPR0`
thumbnail; neither contains a checksum. A save folder from another profile shows
up in the list but fails to load until it is re-signed with the target profile's
key.

### Money on original Xbox (xemu): two routes

**With the key, the editor is enough** — verified in game: open the save, set
money, Apply (the editor re-signs), then put the file back into its slot folder
(`E:\UDATA\004D149D\…`) with xemu off. The dashboard's FTP server only runs
while the dashboard is up, and this setup boots the game (with no disc the BIOS
stops at "Please insert an Xbox disc...", not the dashboard), so
`tools/hdd_save.py` does it offline instead, directly on the qcow2 image:
`list` shows the saves and their guest offset, `replace` overwrites one in place
(same byte length, so the FATX entry and cluster chain are untouched):

```
python3 tools/hdd_save.py list ~/Xbox/hdd/xbox_hdd.qcow2 --key <key>
python3 tools/hdd_save.py replace ~/Xbox/hdd/xbox_hdd.qcow2 edited.bin \
        --offset 0xac043000 --yes
```

Stop xemu first and keep a copy of the image. On this HDD the only save is at
guest offset `0xac043000`; that offset is specific to an image, so always use
`list`.

If the key is unknown, make the game write the value:

1. Run NFSU2 in xemu and load the save.
2. Find the cash variable in xemu's guest RAM: the 64 MB RAM block is a `rw-p`
   mapping of exactly `0x4000000` bytes in the xemu process, and the cash is a
   plain `u32` in it. Scan for the cash value shown in game, buy a part (or
   collect an SMS reward) to change it, filter by the new value — one address
   remains. The address can move between sessions/saves (it was guest
   `0x4b5364` in one run and `0x4b6364` in another), so find it by scanning
   rather than hardcoding it; only the host base moves with ASLR.
3. Write the new cash (1..2147483647) to that address, confirm the game shows
   it, then **Save Game** in-game. The game writes the payload with the new
   money and a valid signature.
4. Read the save back (dashboard FTP, or `tools/hdd_save.py dump`).

Verified results: game-written saves with money `1000000` and `2147483647`
(both shown in game as such, both load normally). `tools/xemu_money.py`
automates steps 2-3 (`find` / `scan` / `narrow` / `set`).

## Tools

| Tool | Purpose |
|------|---------|
| `tools/xbox_key.py` | Find the 16-byte key in a RAM/core dump and verify it against a save; `--key` verifies a known key. |
| `tools/xbox_sign.py` | Sign or verify an Xbox save offline (`sign` / `verify`). |
| `tools/xemu_money.py` | Find and patch the cash value in a running xemu's guest RAM. |
| `tools/hdd_save.py` | List, extract or replace a save inside an xemu qcow2 HDD image, without booting the dashboard. |

## PC → Xbox conversion (unverified, not implemented)

Payload sizes differ by 1146 bytes:
`1146 = 60 + 1086` (a 60-byte PC-only block, plus a ~1086-byte PC tail).
Aligned regions: the first 32 payload bytes are identical; the payloads are ~93.5%
identical byte-by-byte; a PC block at payload `0xc4fc..0xc536` (a list-count byte at
`0xc4fb` = `0xcb` on PC vs `1` on Xbox) has no Xbox counterpart, and the PC tail
after payload 53844 (contains ASCII `DEST`) has no Xbox counterpart. The region
between them is per-save random, so a full mapping needs more matched pairs — the
conversion is left out on purpose.
