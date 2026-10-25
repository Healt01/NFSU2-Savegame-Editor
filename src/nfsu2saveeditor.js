// NFSU2 save editor — supports the PC save format and the Xbox format
// (Xbox port running on Switch, and original Xbox saves from xemu).
//
// Both formats start with the "20CM" magic. They differ only in the header
// length, so the payload layouts are aligned; the field offsets below were
// derived by aligning the payloads of matched PC/Xbox save pairs.

const MAGIC = "20CM";
const MONEY_MAX = 2147483647; // signed 32-bit, as the game stores it
const SLOT_SIZE = 0x7F2;
const NUM_SLOTS = 5;
const SLOT_HEADER = 20;   // slot header is 20 bytes in both formats
const PERF_OFFSET_IN_SLOT = 0x94;
const PERF_COUNT = 0x44;

// Header layout: magic(4), u32 total size, u32 version(8), u32 payload size,
// key blob (12 bytes on PC / 60 bytes on Xbox), u32 269, u32 payload size.
// The payload therefore starts at 0x24 (PC) or 0x54 (Xbox).
const FORMATS = {
    pc: {
        label: "PC",
        header: 36,
        money: 0xA16A,
        name: 0xD225,
        nameField: 16,
        nameMax: 15,
        upper: false,
        slots: 0x5AEC,
    },
    xbox: {
        label: "Xbox (Switch port / xemu)",
        header: 84,
        money: 0xA19A,
        name: 0xD219,
        nameField: 8,
        nameMax: 7,
        upper: true,
        slots: 0x5B1C,
    },
};

// Header of the Nissan 240SX slot, used when the save has no unlocked slot to
// copy from (e.g. a fresh xemu save, where all slot headers are zero).
const SLOT_TEMPLATE = [0x38, 0x39, 0x26, 0x3d, 0x3e, 0x96, 0xac, 0xa5,
    0x3e, 0x96, 0xac, 0xa5, 0x3e, 0x96, 0xac, 0xa5, 0x9b, 0xfa, 0x71, 0x24];

// Xbox signature. The game signs a save with HMAC-SHA1 using a 16-byte key that
// belongs to the profile (EEPROM/HDD key of the console or emulator):
//
//   blob (0x10) = HMAC(key, file[0x4C..0x54])      // u32 269, u32 payload size
//   sigA (0x24) = HMAC(key, payload)               // from 0x54 to EOF
//   sigB (0x38) = HMAC(key, file[0..0x38])         // header including blob+sigA
//
// Written in that order (sigB last). Verified against five game-written xemu
// saves; see FORMAT.md.
const XBOX_BLOB_OFF = 0x10;
const XBOX_SIGA_OFF = 0x24;
const XBOX_SIGB_OFF = 0x38;
const XBOX_SIZES_OFF = 0x4C;
const XBOX_PAYLOAD_OFF = 0x54;
const XBOX_KEY_LEN = 16;
const KEY_STORAGE = 'nfsu2.xbox.key';

// --- SHA-1 / HMAC-SHA1 (pure JS, so the page works from file:// offline) ---
function sha1(bytes) {
    const total = (((bytes.length + 8) >> 6) << 6) + 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const bv = new DataView(buf.buffer);
    const bits = bytes.length * 8;
    bv.setUint32(total - 8, Math.floor(bits / 4294967296), false);
    bv.setUint32(total - 4, bits >>> 0, false);

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Int32Array(80);
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = bv.getInt32(off + i * 4, false);
        for (let i = 16; i < 80; i++) {
            const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (v << 1) | (v >>> 31);
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let i = 0; i < 80; i++) {
            let f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
            else { f = b ^ c ^ d; k = 0xca62c1d6; }
            const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
            e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((h, i) => ov.setInt32(i * 4, h, false));
    return out;
}

function hmacSha1(keyBytes, msg) {
    let key = keyBytes;
    if (key.length > 64) key = sha1(key);
    const ipad = new Uint8Array(64).fill(0x36);
    const opad = new Uint8Array(64).fill(0x5c);
    for (let i = 0; i < key.length; i++) {
        ipad[i] ^= key[i];
        opad[i] ^= key[i];
    }
    const inner = new Uint8Array(64 + msg.length);
    inner.set(ipad); inner.set(msg, 64);
    const innerDigest = sha1(inner);
    const outer = new Uint8Array(64 + 20);
    outer.set(opad); outer.set(innerDigest, 64);
    return sha1(outer);
}

function parseKeyHex(text) {
    const clean = (text || '').replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== XBOX_KEY_LEN * 2) return null;
    const out = new Uint8Array(XBOX_KEY_LEN);
    for (let i = 0; i < XBOX_KEY_LEN; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

const toHex = (u8) => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

// Recomputes the three signature fields, in the order the game writes them.
function signXbox(u8, key) {
    const sizes = u8.subarray(XBOX_SIZES_OFF, XBOX_SIZES_OFF + 8);
    u8.set(hmacSha1(key, sizes), XBOX_BLOB_OFF);
    u8.set(hmacSha1(key, u8.subarray(XBOX_PAYLOAD_OFF)), XBOX_SIGA_OFF);
    u8.set(hmacSha1(key, u8.subarray(0, XBOX_SIGB_OFF)), XBOX_SIGB_OFF);
}

// Returns true when the existing signature matches the key.
function verifyXbox(u8, key) {
    const sizes = u8.subarray(XBOX_SIZES_OFF, XBOX_SIZES_OFF + 8);
    const okBlob = toHex(hmacSha1(key, sizes)) === toHex(u8.subarray(XBOX_BLOB_OFF, XBOX_BLOB_OFF + 20));
    const okA = toHex(hmacSha1(key, u8.subarray(XBOX_PAYLOAD_OFF))) === toHex(u8.subarray(XBOX_SIGA_OFF, XBOX_SIGA_OFF + 20));
    const okB = toHex(hmacSha1(key, u8.subarray(0, XBOX_SIGB_OFF))) === toHex(u8.subarray(XBOX_SIGB_OFF, XBOX_SIGB_OFF + 20));
    return { okBlob, okA, okB, ok: okBlob && okA && okB };
}

// Key read from this machine's xemu (it comes from the emulator's EEPROM, so a
// different install can derive a different one).
const KNOWN_XEMU_KEY = 'COLOQUE-AQUI-SEU-HEX-DE-32-DIGITOS';

// Switch port (nfsu2-sw) key: the port stubs its EEPROM key to zero, so its
// saves are signed with an all-zero key. Verified on all 5 port samples.
const KNOWN_PORT_KEY = '00000000000000000000000000000000';

function readStoredKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}

function storeKey(text) {
    try {
        const k = parseKeyHex(text);
        if (k) localStorage.setItem(KEY_STORAGE, toHex(k));
        else if (!(text || '').trim()) localStorage.removeItem(KEY_STORAGE);
    } catch (e) { /* storage may be disabled (private mode); ignore */ }
}

// Signature indicator: no key / wrong key / valid signature on the current
// buffer, or a valid key but pending edits that will be re-signed on Apply.
function updateSigStatus() {
    if (!originalBuf || !workBuf || !fmt || fmt !== FORMATS.xbox) return;
    const key = parseKeyHex(xboxKeyInput.value);
    if (!key) {
        sigStatus.textContent = 'no key';
        sigStatus.className = 'pill warn';
        return;
    }
    if (verifyXbox(workBuf, key).ok) {
        if (verifyXbox(originalBuf, key).ok) {
            sigStatus.textContent = 'valid ✓';
            sigStatus.className = 'pill ok';
        } else {
            sigStatus.textContent = 're-signed (unverified key)';
            sigStatus.className = 'pill warn';
        }
    } else if (verifyXbox(originalBuf, key).ok) {
        sigStatus.textContent = 'modified — will re-sign';
        sigStatus.className = 'pill warn';
    } else {
        sigStatus.textContent = 'key mismatch';
        sigStatus.className = 'pill warn';
    }
}

let fileHandle = null;
let originalBuf = null;
let workBuf = null;
let dv = null;
let fmt = null;
let usedSlots = 0;
let perfChoice = {}; // slot index -> pending performance choice, kept across UI rebuilds

const $ = sel => document.querySelector(sel);
const setText = (id, txt) => { const el = $(id); el.textContent = txt; };
const setStatus = (txt) => { const el = $('#status'); if (el) el.textContent = txt; };
function readCString(u8, offset) {
    let end = offset;
    while (end < u8.length && u8[end] !== 0) end++;
    return new TextDecoder("windows-1252", { fatal: false }).decode(u8.subarray(offset, end));
}
function writeCString(u8, offset, str, maxLen) {
    const bytes = new TextEncoder().encode(str);
    for (let i = 0; i < maxLen; i++) {
        u8[offset + i] = (i < bytes.length) ? bytes[i] : 0;
    }
}

function view(u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

// Detects the format from the header fields, not from the file size alone.
function detectFormat(u8) {
    if (u8.length < 0x60) return null;
    if (u8.subarray(0, 4).reduce((s, b) => s + String.fromCharCode(b), "") !== MAGIC) return null;
    const v = view(u8);
    const size = v.getUint32(4, true);
    const version = v.getUint32(8, true);
    const payload = v.getUint32(0xC, true);
    for (const key of Object.keys(FORMATS)) {
        const f = FORMATS[key];
        if (size === u8.length && version === 8 && size - payload === f.header) {
            return key;
        }
    }
    return null;
}

function calcUsedSlots(u8) {
    let c = 0;
    const v = view(u8);
    for (let i = 0; i < NUM_SLOTS; i++) {
        const base = fmt.slots + i * SLOT_SIZE;
        if (base + 2 <= u8.length && v.getUint16(base, true) !== 0) c++;
    }
    return c;
}

function setPerfForCar(u8, index, val) {
    if (index < 0 || index >= NUM_SLOTS) return;
    const base = fmt.slots + index * SLOT_SIZE + PERF_OFFSET_IN_SLOT;
    for (let i = 0; i < PERF_COUNT; i++) {
        const p = base + i;
        if (p < u8.length) u8[p] = val;
    }
}

function isSlotLocked(u8, slotIdx) {
    const base = fmt.slots + slotIdx * SLOT_SIZE;
    for (let i = 0; i < SLOT_HEADER; i++) {
        if (u8[base + i] !== 0) return false;
    }
    return true;
}

// Unlocking only writes the slot header (the car id block); the rest of the slot
// already holds data in every save, so it is left untouched.
function unlockCarSlot(u8, slotIdx) {
    const targetBase = fmt.slots + slotIdx * SLOT_SIZE;
    const src = isSlotLocked(u8, 0)
        ? SLOT_TEMPLATE
        : Array.from(u8.subarray(fmt.slots, fmt.slots + SLOT_HEADER));
    for (let i = 0; i < SLOT_HEADER; i++) {
        u8[targetBase + i] = src[i];
    }
}

const fileInput = $('#file');
const fileInfo = $('#fileInfo');
const headerStatus = $('#headerStatus');
const formatDisplay = $('#formatDisplay');
const profile = $('#profile');
const moneyDisplay = $('#moneyDisplay');
const slots = $('#slots');
const summary = $('#summary');
const editor = $('#editor');
const nameField = $('#name');
const moneyField = $('#money');
const carsDiv = $('#cars');
const applyBtn = $('#apply');
const dlBtn = $('#download');
const dlBakBtn = $('#downloadBak');
const backupToggle = $('#backupToggle');
const reloadBtn = $('#reload');
const xboxKeyRow = $('#xboxKeyRow');
const xboxKeyInput = $('#xboxKey');
const keyFillBtn = $('#keyFill');
const keyFillPortBtn = $('#keyFillPort');
const keyClearBtn = $('#keyClear');
const sigCell = $('#sigCell');
const sigStatus = $('#sigStatus');

carsDiv.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT') perfChoice[e.target.id.slice(4)] = e.target.value;
});

function resetUI() {
    summary.hidden = true; editor.hidden = true; applyBtn.disabled = true; dlBtn.disabled = true; dlBakBtn.disabled = true;
    carsDiv.innerHTML = ''; setText('#fileInfo', 'No file selected.');
    setText('#formatDisplay', '—');
    fmt = null;
    nameField.value = '';
    nameField.maxLength = 32;
    nameField.style.textTransform = 'none';
    setStatus('');
    perfChoice = {};
    const xboxNote = document.getElementById('xboxNote');
    if (xboxNote) { xboxNote.hidden = true; }
    if (xboxKeyRow) { xboxKeyRow.hidden = true; }
    if (sigCell) { sigCell.hidden = true; }
    if (sigStatus) { sigStatus.textContent = '—'; sigStatus.className = 'pill'; }
}

resetUI();

xboxKeyInput.value = readStoredKey();
xboxKeyInput.addEventListener('input', () => {
    storeKey(xboxKeyInput.value);
    updateSigStatus();
});
keyFillBtn.addEventListener('click', () => {
    xboxKeyInput.value = KNOWN_XEMU_KEY;
    storeKey(KNOWN_XEMU_KEY);
    updateSigStatus();
});
keyFillPortBtn.addEventListener('click', () => {
    xboxKeyInput.value = KNOWN_PORT_KEY;
    storeKey(KNOWN_PORT_KEY);
    updateSigStatus();
});
keyClearBtn.addEventListener('click', () => {
    xboxKeyInput.value = '';
    storeKey('');
    updateSigStatus();
});

fileInput.addEventListener('change', async (e) => {
    resetUI();
    const f = e.target.files?.[0];
    if (!f) { return; }
    fileHandle = f;
    fileInfo.textContent = `${f.name} — ${f.size.toLocaleString()} bytes`;
    const ab = await f.arrayBuffer();
    originalBuf = new Uint8Array(ab);
    workBuf = new Uint8Array(ab.slice(0));
    dv = new DataView(workBuf.buffer);
    render();
    nameField.value = '';
    moneyField.value = '-1';
});

// Renders the UI from workBuf. Used after loading a file and after unlocking a
// slot, so pending edits (including the unlock) are never lost by re-reading
// the original file.
function render() {
    const key = detectFormat(workBuf);
    const headerOk = key !== null;
    headerStatus.textContent = headerOk ? 'OK' : 'Invalid';
    headerStatus.className = 'pill ' + (headerOk ? 'ok' : 'warn');
    if (!headerOk) {
        setText('#profile', '—'); setText('#moneyDisplay', '—'); setText('#slots', '—');
        summary.hidden = false;
        return;
    }

    fmt = FORMATS[key];
    formatDisplay.textContent = fmt.label;
    const isXbox = key === 'xbox';
    const xboxNote = document.getElementById('xboxNote');
    if (xboxNote) { xboxNote.hidden = !isXbox; }
    xboxKeyRow.hidden = !isXbox;
    sigCell.hidden = !isXbox;
    if (isXbox) { updateSigStatus(); }
    nameField.maxLength = fmt.nameMax;
    if (fmt.upper) { nameField.style.textTransform = 'uppercase'; }

    const name = readCString(workBuf, fmt.name) || '(empty)';
    const money = dv.getInt32(fmt.money, true);
    usedSlots = calcUsedSlots(workBuf);
    setText('#profile', name);
    setText('#moneyDisplay', String(money));
    setText('#slots', String(usedSlots));
    summary.hidden = false;

    if (backupToggle.checked) { dlBakBtn.disabled = false; }

    carsDiv.innerHTML = '';
    for (let i = 0; i < NUM_SLOTS; i++) {
        const locked = isSlotLocked(workBuf, i);
        const inUse = !locked;
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <div><strong>Car ${i + 1}</strong> <span class="muted">${inUse ? 'IN USE' : locked ? 'locked/empty' : 'empty'}</span></div>
          <label class="muted" for="car_${i}">Change performance</label>
          <select id="car_${i}" ${inUse ? '' : 'disabled'}>
            <option value="2">No effect</option>
            <option value="0">Nill out</option>
            <option value="1">Max out (every part installed — not a state the game produces)</option>
          </select>
          ${(!inUse && locked) ? `<button id="unlock_${i}" style="margin-top:8px">Unlock Slot</button>` : ''}
        `;
        carsDiv.appendChild(card);

        // Add unlock button handler if needed
        if (!inUse && locked) {
            setTimeout(() => {
                const btn = document.getElementById(`unlock_${i}`);
                if (btn) {
                    btn.onclick = () => {
                        unlockCarSlot(workBuf, i);
                        render();
                        setStatus(`Car slot ${i + 1} unlocked. Click "Apply Changes" to write it to the file.`);
                    };
                }
            }, 0);
        }
    }

    // Restore pending performance choices after a rebuild (e.g. after unlocking).
    for (const k in perfChoice) {
        const sel = document.getElementById('car_' + k);
        if (sel && !sel.disabled) sel.value = perfChoice[k];
    }

    editor.hidden = false;
    applyBtn.disabled = false;
    dlBtn.disabled = false;
}

function applyChanges() {
    if (!workBuf || !fmt) return;
    const rawName = nameField.value.trim();
    if (rawName.length > 0) {
        const newName = (fmt.upper ? rawName.toUpperCase() : rawName).slice(0, fmt.nameMax);
        writeCString(workBuf, fmt.name, newName, fmt.nameField);
        setText('#profile', newName);
    }
    const val = parseInt(moneyField.value.trim(), 10);
    if (!Number.isNaN(val) && val !== -1) {
        if (val < 1 || val > MONEY_MAX) {
            setStatus(`Money must be 1..${MONEY_MAX} (the game stores a signed 32-bit value, larger values become negative). Nothing was downloaded.`);
            return;
        }
        dv.setInt32(fmt.money, val, true);
        setText('#moneyDisplay', String(val));
    }
    for (let i = 0; i < NUM_SLOTS; i++) {
        const sel = document.getElementById(`car_${i}`);
        if (!sel || sel.disabled) continue;
        const v = parseInt(sel.value, 10);
        if (v === 0 || v === 1) { setPerfForCar(workBuf, i, v); }
    }

    // Xbox: recompute the three HMAC fields, in the same order the game writes
    // them (blob, payload, then the header that contains the first two).
    const isXbox = fmt === FORMATS.xbox;
    let signed = false;
    let keyValidated = false;
    if (isXbox) {
        const key = parseKeyHex(xboxKeyInput.value);
        if (key) {
            keyValidated = verifyXbox(originalBuf, key).ok;
            signXbox(workBuf, key);
            signed = true;
            updateSigStatus();
        }
    }

    const blob = new Blob([workBuf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileHandle.name;
    a.click();
    URL.revokeObjectURL(url);

    let msg = `Changes applied. The modified file (${fileHandle.name}) was downloaded.`;
    if (isXbox) {
        if (!signed) {
            msg += ' No signing key: the signature is stale and the game will most likely refuse this save.';
        } else if (keyValidated) {
            msg += ' Signature recalculated with your key.';
        } else {
            msg += ' Signature recalculated, but the key did not match the loaded save — double-check it before using the file.';
        }
    }
    setStatus(msg);
    applyBtn.textContent = 'Applied ✓';
    setTimeout(() => applyBtn.textContent = 'Apply Changes', 1000);
}

applyBtn.addEventListener('click', applyChanges);
dlBtn.addEventListener('click', applyChanges);

dlBakBtn.addEventListener('click', () => {
    if (!originalBuf || !fileHandle) return;
    const blob = new Blob([originalBuf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileHandle.name + '.bak';
    a.click();
    URL.revokeObjectURL(url);
});

reloadBtn.addEventListener('click', () => {
    if (fileHandle) {
        resetUI();
        fileInput.value = '';
        alert('To reset, select the file again.');
    }
});
