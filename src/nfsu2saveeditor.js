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
}

resetUI();

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
    const xboxNote = document.getElementById('xboxNote');
    if (xboxNote) { xboxNote.hidden = (key !== 'xbox'); }
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
            <option value="1">Max out</option>
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

applyBtn.addEventListener('click', () => {
    if (!workBuf || !fmt) return;
    const rawName = nameField.value.trim();
    if (rawName.length > 0) {
        const newName = (fmt.upper ? rawName.toUpperCase() : rawName).slice(0, fmt.nameMax);
        writeCString(workBuf, fmt.name, newName, fmt.nameField);
        setText('#profile', newName);
    }
    const val = parseInt(moneyField.value.trim(), 10);
    if (!Number.isNaN(val) && val !== -1) {
        if (val > MONEY_MAX) {
            setStatus(`Money must be 1..${MONEY_MAX} (the game stores a signed 32-bit value, larger values become negative).`);
        } else {
            dv.setInt32(fmt.money, val, true);
            setText('#moneyDisplay', String(val));
        }
    }
    for (let i = 0; i < NUM_SLOTS; i++) {
        const sel = document.getElementById(`car_${i}`);
        if (!sel || sel.disabled) continue;
        const v = parseInt(sel.value, 10);
        if (v === 0 || v === 1) { setPerfForCar(workBuf, i, v); }
    }

    const blob = new Blob([workBuf], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileHandle.name;
    a.click();
    URL.revokeObjectURL(url);

    setStatus(`Changes applied. The modified file (${fileHandle.name}) was downloaded.`);
    applyBtn.textContent = 'Applied ✓';
    setTimeout(() => applyBtn.textContent = 'Apply Changes', 1000);
});

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
