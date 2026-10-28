# NFSU2-Savegame-Editor

[![open the editor](https://img.shields.io/badge/open%20the%20editor-online-brightgreen)](https://healt01.github.io/NFSU2-Savegame-Editor/)
![runs 100% offline](https://img.shields.io/badge/runs-100%25%20offline-blue)
![PC · Xbox · Switch port](https://img.shields.io/badge/PC%20%C2%B7%20Xbox%20%C2%B7%20Switch%20port-informational)
[![license: MIT](https://img.shields.io/github/license/Healt01/NFSU2-Savegame-Editor?label=license)](LICENSE)
[![AI-assisted, tested in game](https://img.shields.io/badge/AI--assisted-tested%20in%20game-yellow)](#how-this-work-was-made)

**English** · [Português (Brasil)](README.pt-BR.md)

Savegame editor for **Need for Speed: Underground 2** on PC, original Xbox (xemu)
and the Switch port [`nfsu2-sw`](https://github.com/antoxa2584x/nfsu2-sw). Runs
entirely in the browser: the file is parsed and rebuilt in your machine, nothing is
uploaded.

Original editor by [hackch](https://github.com/hackch/NFSU2-Savegame-Editor) (MIT).
This fork adds the Xbox signature, so edited saves are accepted by the game, and the
car performance fields.

## Use it

Open [`index.html`](index.html) in a browser (GitHub Pages runs it on the branch
`main`), pick the save file, edit, **Apply**, download. There is a language switch at
the top of the page, **English / Português (Brasil)**, remembered in your browser.

The editor also tells you which Xbox it is looking at. It verifies the signature
against the Switch port's all-zero key: when the three HMAC fields match, that key is
applied by itself and the key field is hidden — a port save needs no key from you. When
they do not match, the save was signed with a key of its own (xemu or a console) and the
page asks for that key.

Nothing is written to disk when you load a file. The page keeps the original bytes in
memory, and **Download Backup (.bak)** writes them, with the name `<yourfile>.bak`, into
your browser's downloads folder.

The page loads its script with a version tag (`?v=...`), so an update of the editor
reaches you without you clearing the browser cache. The Pages server caches each file for
10 minutes; after an update, a normal reload is enough.

| Field | PC | Xbox / Switch port |
|-------|----|--------------------|
| Money | signed `int32` at `0xA16A` | signed `int32` at `0xA19A` |
| Profile name | 16 bytes at `0xD225` | 8 bytes at `0xD219`, uppercase, 7 characters |
| Car slots | array at `0x5AEC`, 5 slots of `0x7F2` | array at `0x5B1C`, same size |

Limits the game enforces: money must stay in `1..2147483647` (above that it becomes
negative) and Xbox profile names have at most 7 uppercase characters. `2147483647` is
shown correctly and goes negative after a race, because the winnings are added to the
same `int32`.

The save has 5 garage slots — 5 cars, `0x7F2` bytes each — and the game unlocks them
as you progress: you cannot buy a slot, and you cannot sell or delete a car in game.
The editor edits the 5 slots that exist, it cannot add one.

## Xbox saves are signed

The game refuses a save whose signature does not match, so an edited save needs to be
re-signed. The signature is three HMAC-SHA1 fields, and the editor recomputes them
when you apply changes, in the order the game uses:

| Field | Covers |
|-------|--------|
| `blob` @ `0x10` | the two size fields at `0x4C..0x54` |
| `sigA` @ `0x24` | the payload, `0x54` to end of file |
| `sigB` @ `0x38` | `0x00..0x38`, which includes `blob` and `sigA` |

`sigB` covers the other two, so it is computed last.

**Key.** The key is not in the game binary and not raw in `eeprom.bin`: xemu derives
it from the EEPROM at boot, so every install and every console uses its own, and
there is nothing universal to publish. Get yours with `tools/xbox_key.py`, which
finds it in a guest-RAM dump and verifies it against a save, and paste it in the key
field of the editor. The Switch port is the exception: its kernel stubs the EEPROM
key to zero (`xboxrecomp/src/kernel/kernel_xbox.c`), so its saves are signed with an
all-zero key, which the **Port key (zeros)** button writes for you. The editor applies
that key by itself when the loaded save verifies with it, and then hides the key field.

## Car performance

Each car slot holds 68 "part installed" flags at `slot + 0x94` and 10 performance
values as `float32` at `slot + 0x40` (indices 1..10, `3.00` is max, index 0 is not a
value). The game computes the values from the installed parts, so writing them
without the flags does nothing.

**Max out** writes the pattern a maxed car has in game: 40 flags in fixed positions,
shared across cars, plus `3.00` in the values. **Nill out** clears both. Verified in
game on the Switch port: a slot written with this pattern shows the same garage bars
as a car maxed by buying every part.

Details, offsets, the port's SD card layout and the in-game tests are in
[`FORMAT.md`](FORMAT.md).

## Tools

| Tool | What it does |
|------|--------------|
| `tools/xbox_sign.py` | Sign or verify an Xbox save offline (`sign` / `verify`). |
| `tools/xbox_key.py` | Find the 16-byte key in a RAM/core dump and verify it against a save. |
| `tools/hdd_save.py` | List, extract or replace a save in an xemu qcow2 image, a raw image, or a loose save file. |
| `tools/xemu_money.py` | Find and patch the cash value in a running xemu's guest RAM. |
| `tools/perf_diff.py` | Diff the car slots of two saves: the flags and the other slot bytes that changed. |
| `tools/perf_probe.sh` | Snapshot a save slot from the mounted card into `snapshots/snapN` and diff it against `snapN-1`. |
| `tools/browser_capture.py` | Serve the editor page and save a browser POST, to compare the bytes the editor produces with the Python tools. |

## In game

| Platform | Result |
|----------|--------|
| PC | Edited saves load, because PC saves carry no signature. **Not re-tested in this fork's work** — that row is the project's earlier record, kept for completeness. |
| xemu | Unsigned edited save → `Unable to load`; re-signed → loads, new cash shown. |
| Switch port | Unsigned → `Unable to load`; re-signed with the all-zero key → loads. Money `100000` and `2147483647` shown correctly; maxed pattern gives a maxed car. |

**Scope of these tests.** The Switch port results come from a modded Switch running the
port — real console hardware, with the card written through Hekate's USB Mass Storage.
The xemu results come from the emulator. Nothing was run on an original Xbox console, and
the PC row is the project's earlier record, not a test of this fork.

On the Switch port, saves are plain folders
`switch/nfsu2x/game/UDATA/<titleid>/<prefix+slot>/<name>` next to `saveimage.xbx`
and `SaveMeta.xbx`, so an edited, re-signed save is copied with ordinary file tools.
Keep the two `.xbx` files together with the save.

## How this work was made

The code and documentation in this fork were drafted with local AI models
(llama.cpp, on my machine, no cloud service, nothing uploaded), and verified by me in
game, on my own hardware: my xemu install, my modded Switch, my saves. The reverse
engineering decisions are mine, and the signing key of a console is deliberately not
published.

What is claimed here is backed by a test, not by a model: the signature scheme was
reproduced byte-for-byte against saves written by the game, the maxed car pattern came
from a slot the game itself produced, and the editor's browser output was compared
byte-for-byte with the Python tools (`sha1
9bb79a96c3ccd249bf897dda271cbb8892a28c1b`), which was then loaded in game on the
Switch port. The results, the offsets and the in-game tables are in
[`FORMAT.md`](FORMAT.md).

Anything not tested is marked as not tested. Not affiliated with Electronic Arts or
Criterion; this is for personal modding of your own saves.

## License

MIT, see [`LICENSE`](LICENSE). Copyright of the original editor: Christopher Hack.
