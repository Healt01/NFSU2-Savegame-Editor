// NFSU2 save editor — supports the PC save format and the Xbox format
// (Xbox port running on Switch, and original Xbox saves from xemu).
//
// Original editor: hackch / NFSU2-Savegame-Editor, MIT License.
// Copyright (c) 2025 Christopher Hack (original editor). Modifications copyright (c)
// 2026 Healt. Fork: https://github.com/Healt01/NFSU2-Savegame-Editor
// This file is distributed under the MIT License; keep this notice with any copy.
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

// The 68 bytes at slot + 0x94 are one flag per upgrade part (0 = not installed,
// 1 = installed), and the game recomputes the car's performance from the
// installed parts. The result is kept as 10 float32 at slot + 0x40 (indices
// 1..10, index 0 is unused garbage). Captured in game by buying every part the
// game allows on a stock slot: 40 flags set and the values at 3.00.
const PERF_VALUES_OFF_IN_SLOT = 0x40;
const PERF_VALUE_COUNT = 10;   // indices 1..10, index 0 left alone
const PERF_VALUE_MAX = 3.0;
const PERF_TEMPLATE = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0,
    0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0,
    1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, 1];

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

// The key is not in the game binary and not raw in eeprom.bin: xemu derives it
// from the EEPROM at boot, so each install (and each real console) uses its own.
// Extract it from the machine that wrote the save: `python3 tools/xbox_key.py
// --save <save-file>` finds it in a RAM dump and verifies it. The Switch port is
// the exception: its kernel stubs the EEPROM key to zero, so its saves are signed
// with an all-zero key, which is what "Fill port key" writes.
const KNOWN_PORT_KEY = '00000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Interface language (English / Brazilian Portuguese). Persisted in
// localStorage, defaults to the browser language. Nothing here touches the
// bytes: the signing code and the field offsets are language independent.
// ---------------------------------------------------------------------------
const LANG_STORAGE = "nfsu2ui.lang";

const STR = {
    en: {
        title: "NFS Underground 2 – Save Editor (100% client-side)",
        sub: "Open a save file, tweak name, money and car performance, then download the modified file. No uploads; everything stays in your browser. The format (PC or Xbox port / xemu) is detected from the header, and for an Xbox save the editor also checks the signature against the Switch port's all-zero key.",
        fileLabel: "Save file",
        backupLabel: "Keep the original in memory (enables Download Backup .bak)",
        backupHint: "Nothing is written to disk on load. The .bak file only appears when you click Download Backup, and it lands in your browser's downloads folder.",
        sumName: "Profile Name", sumMoney: "Money", sumSlots: "Car Slots Used",
        sumHeader: "Header Check", sumFormat: "Detected Format", sumSource: "Source",
        sumSig: "Xbox Signature",
        nameLabel: "New Profile Name (leave empty = no change)",
        nameHintPc: "PC saves: up to 15 characters.",
        nameHintXbox: "Xbox saves: up to 7 characters, uppercase.",
        moneyLabel: "New Money (-1 = no change)",
        xboxNote: "Xbox saves are signed with HMAC-SHA1 (an authentication code) that belongs to the profile — the console or the emulator — and not to the save itself. Paste that key below and the editor re-signs the file after every edit; without the key the old signature is kept and the game will most likely show \u201cUnable to load SAVE\u201d. The key is not stored in the save: for xemu it can be extracted from the emulator's RAM, see tools/xbox_key.py in the repository. On the Switch port the key is 16 zero bytes, because the port zeroes its EEPROM key; the editor applies that key by itself when the file's signature matches it.",
        keyLabel: "Xbox signing key (32 hex characters = 16 bytes)",
        keyPh: "32 hex characters, from your own console",
        keyFillPort: "Port key (zeros)", keyClear: "Clear",
        keyFillPortTitle: "Switch port key — all-zero, because the port's EEPROM key is stubbed to zero (verified on 5 port saves and in game on a Switch)",
        keyHint: "Kept only in this browser (localStorage). A wrong key re-signs the save with the wrong key, so check the \u201cXbox Signature\u201d indicator before downloading. If this save is from the port and the signature does not match (for example a save that was already edited without re-signing), use \u201cPort key (zeros)\u201d.",
        keyShow: "Show the key field",
        keyAutoNote: "The Switch port key (16 zero bytes) was applied by itself: this file's signature matches it. Use the button above if you want to enter a different key.",
        btnApply: "Apply Changes", btnDownload: "Download Modified Save",
        btnBak: "Download Backup (.bak)", btnReset: "Reset (re-read file)",
        pillOk: "OK", pillInvalid: "Invalid",
        fmtPc: "PC", fmtXbox: "Xbox (Switch port / xemu)",
        srcPc: "PC — no signature",
        srcPort: "Switch port — signature matches the all-zero key",
        srcXemu: "Signed with its own key (xemu / console) — enter that key",
        sigNoKey: "no key", sigValid: "valid ✓",
        sigResignUnverified: "re-signed (key unverified)",
        sigWillResign: "modified — will re-sign", sigMismatch: "key mismatch",
        fileNoFile: "No file selected.",
        carLabel: "Car {n}", carInUse: "IN USE", carLocked: "locked/empty", carEmpty: "empty",
        perfLabel: "Change performance", optNone: "No effect",
        optNill: "Nill out (no parts, values cleared)",
        optMax: "Max out (the game's maxed pattern: 40 parts, values 3.0)",
        btnUnlock: "Unlock Slot",
        stUnlocked: "Car slot {n} unlocked. Click \u201cApply Changes\u201d to write it to the file.",
        stApplied: "Changes applied. The modified file ({name}) was downloaded.",
        stNoKey: " No signing key: the signature is stale and the game will most likely refuse this save.",
        stKeyOk: " Signature recalculated with your key.",
        stKeyMismatch: " Signature recalculated, but the key did not match the loaded save — double-check it before using the file.",
        stMoney: "Money must be 1..{max} (the game stores a signed 32-bit value, larger values become negative). Nothing was downloaded.",
        stBakDone: "Backup ({name}.bak) downloaded to your browser's downloads folder.",
        stReset: "To reset, select the file again.",
        appliedBtn: "Applied ✓",
        footOriginal: "<strong>Original editor:</strong> <a href=\"https://github.com/hackch/NFSU2-Savegame-Editor\">hackch / NFSU2-Savegame-Editor</a>, MIT License. This page is a <strong>fork</strong> by <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor\">Healt01</a>, which adds the Xbox save signature (three HMAC-SHA1 fields) so the game accepts edited saves, and the car performance fields.",
        footCopyright: "Copyright (c) 2025 Christopher Hack (original editor). Modifications copyright (c) 2026 Healt. This copy of the software is provided under the <a href=\"LICENSE\">MIT License</a> — keep this notice with any copy you make, offline included.",
        footScope: "Tested in game on a modded Switch running the port (real console hardware) and in xemu (emulator). <strong>Not tested on an original Xbox console.</strong>",
        footMade: "How this work was made: code and documentation drafted with local AI models (llama.cpp), verified in game on the author's own hardware, console signing keys not published — <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor#how-this-work-was-made\">disclosure</a>. Docs: <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor/blob/main/README.md\">README (English)</a> · <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor/blob/main/README.pt-BR.md\">Português (Brasil)</a> · <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor/blob/main/FORMAT.md\">FORMAT.md (format, offsets, tests)</a>."
    },
    pt: {
        title: "NFS Underground 2 – Editor de Save (100% no cliente)",
        sub: "Abra um arquivo de save, ajuste nome, dinheiro e desempenho dos carros, e baixe o arquivo modificado. Nada é enviado; tudo fica no seu navegador. O formato (PC ou Xbox: port / xemu) é detectado pelo cabeçalho, e num save do Xbox o editor também compara a assinatura com a chave toda zero do port do Switch.",
        fileLabel: "Arquivo de save",
        backupLabel: "Manter o original em memória (libera o botão Baixar backup .bak)",
        backupHint: "Nada é gravado no disco ao carregar. O arquivo .bak só aparece quando você clica em Baixar backup, e vai para a pasta de downloads do navegador.",
        sumName: "Nome do perfil", sumMoney: "Dinheiro", sumSlots: "Vagas de carro usadas",
        sumHeader: "Checagem do cabeçalho", sumFormat: "Formato detectado", sumSource: "Origem",
        sumSig: "Assinatura do Xbox",
        nameLabel: "Novo nome do perfil (vazio = não muda)",
        nameHintPc: "Save PC: até 15 caracteres.",
        nameHintXbox: "Save Xbox: até 7 caracteres, maiúsculas.",
        moneyLabel: "Novo dinheiro (-1 = não muda)",
        xboxNote: "Os saves do Xbox são assinados com HMAC-SHA1 (código de autenticação) que pertence ao perfil — console ou emulador — e não ao save em si. Cole essa chave abaixo e o editor re-assina o arquivo após cada edição; sem a chave, a assinatura antiga é mantida e o jogo provavelmente exibirá \u201cUnable to load SAVE\u201d. A chave não é armazenada no save: para o xemu ela pode ser extraída da RAM do emulador, veja em tools/xbox_key.py no repositório. No port do Switch a chave é 16 bytes zero, porque o port zera a chave do EEPROM; o editor aplica essa chave sozinho quando a assinatura do arquivo bate com ela.",
        keyLabel: "Chave de assinatura do Xbox (32 caracteres hex = 16 bytes)",
        keyPh: "32 caracteres hex, da sua chave",
        keyFillPort: "Chave do port (zeros)", keyClear: "Limpar",
        keyFillPortTitle: "Chave do port do Switch — toda zero, porque o port zera a chave do EEPROM (verificada em 5 saves do port e no jogo em um Switch)",
        keyHint: "Guardada só neste navegador (localStorage). Uma chave errada re-assina o save com a chave errada, então confira o indicador \u201cAssinatura do Xbox\u201d antes de baixar. Se este save é do port e a assinatura não bate (por exemplo um save já editado sem re-assinar), use \u201cChave do port (zeros)\u201d.",
        keyShow: "Mostrar o campo de chave",
        keyAutoNote: "A chave do port do Switch (16 bytes zero) foi aplicada sozinha: a assinatura deste arquivo bate com ela. Use o botão acima se você quiser informar outra chave.",
        btnApply: "Aplicar mudanças", btnDownload: "Baixar save modificado",
        btnBak: "Baixar backup (.bak)", btnReset: "Recomeçar (relê o arquivo)",
        pillOk: "OK", pillInvalid: "Inválido",
        fmtPc: "PC", fmtXbox: "Xbox (port do Switch / xemu)",
        srcPc: "PC — sem assinatura",
        srcPort: "Port do Switch — assinatura bate com a chave zero",
        srcXemu: "Assinado com chave própria (xemu / console) — informe essa chave",
        sigNoKey: "sem chave", sigValid: "válida ✓",
        sigResignUnverified: "re-assinado (chave não conferida)",
        sigWillResign: "modificado — vai re-assinar", sigMismatch: "chave não confere",
        fileNoFile: "Nenhum arquivo selecionado.",
        carLabel: "Carro {n}", carInUse: "EM USO", carLocked: "trancada/vazia", carEmpty: "vazia",
        perfLabel: "Mudar desempenho", optNone: "Sem efeito",
        optNill: "Zerar (sem peças, valores limpos)",
        optMax: "Max (padrão do jogo no máximo: 40 peças, valores 3.0)",
        btnUnlock: "Destravar vaga",
        stUnlocked: "Vaga de carro {n} destravada. Clique em \u201cAplicar mudanças\u201d para escrever no arquivo.",
        stApplied: "Mudanças aplicadas. O arquivo modificado ({name}) foi baixado.",
        stNoKey: " Sem chave de assinatura: a assinatura fica vencida e o jogo provavelmente recusa este save.",
        stKeyOk: " Assinatura recalculada com a sua chave.",
        stKeyMismatch: " Assinatura recalculada, mas a chave não confere com o save carregado — confira antes de usar o arquivo.",
        stMoney: "O dinheiro precisa ficar entre 1 e {max} (o jogo guarda um inteiro de 32 bits com sinal; valores maiores viram negativos). Nada foi baixado.",
        stBakDone: "Backup ({name}.bak) baixado na pasta de downloads do seu navegador.",
        stReset: "Para recomeçar, selecione o arquivo de novo.",
        appliedBtn: "Aplicado ✓",
        footOriginal: "<strong>Editor original:</strong> <a href=\"https://github.com/hackch/NFSU2-Savegame-Editor\">hackch / NFSU2-Savegame-Editor</a>, licença MIT. Esta página é um <strong>fork</strong> de <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor\">Healt01</a>, que acrescenta a assinatura do save do Xbox (três campos HMAC-SHA1) para o jogo aceitar o save editado, e os campos de desempenho de carro.",
        footCopyright: "Copyright (c) 2025 Christopher Hack (editor original). Modificações copyright (c) 2026 Healt. Esta cópia do software é fornecida sob a <a href=\"LICENSE\">licença MIT</a> — mantenha este aviso em qualquer cópia que você fizer, offline incluída.",
        footScope: "Testado no jogo em um Switch modificado rodando o port (hardware real de console) e no xemu (emulador). <strong>Não testei em console Xbox original.</strong>",
        footMade: "Como este trabalho foi feito: código e documentação rascunhados com modelos de IA locais (llama.cpp), verificados no jogo no hardware do autor, chaves de assinatura de console não publicadas — <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor#how-this-work-was-made\">aviso</a>. Docs: <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor/blob/main/README.md\">README (inglês)</a> · <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor/blob/main/README.pt-BR.md\">Português (Brasil)</a> · <a href=\"https://github.com/Healt01/NFSU2-Savegame-Editor/blob/main/FORMAT.md\">FORMAT.md (formato, offsets, testes)</a>."
    }
};

let lang = (() => {
    try { const s = localStorage.getItem(LANG_STORAGE); if (s === "en" || s === "pt") return s; } catch (e) { }
    return (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt" : "en";
})();

function t(key, vars) {
    let s = (STR[lang] && STR[lang][key]) || STR.en[key] || key;
    if (vars) { for (const k in vars) s = s.split("{" + k + "}").join(vars[k]); }
    return s;
}

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
        sigStatus.textContent = t('sigNoKey');
        sigStatus.className = 'pill warn';
        return;
    }
    if (verifyXbox(workBuf, key).ok) {
        if (verifyXbox(originalBuf, key).ok) {
            sigStatus.textContent = t('sigValid');
            sigStatus.className = 'pill ok';
        } else {
            sigStatus.textContent = t('sigResignUnverified');
            sigStatus.className = 'pill warn';
        }
    } else if (verifyXbox(originalBuf, key).ok) {
        sigStatus.textContent = t('sigWillResign');
        sigStatus.className = 'pill warn';
    } else {
        sigStatus.textContent = t('sigMismatch');
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
    const slotBase = fmt.slots + index * SLOT_SIZE;
    const perfBase = slotBase + PERF_OFFSET_IN_SLOT;
    for (let i = 0; i < PERF_COUNT; i++) {
        const p = perfBase + i;
        if (p < u8.length) u8[p] = val === 1 ? PERF_TEMPLATE[i] : 0;
    }
    // The performance values are what the game computes from the installed
    // parts, so writing them has to follow the flags: 3.0 with the maxed
    // pattern, 0 with the cleared one. Index 0 is not a value, leave it.
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const v = val === 1 ? PERF_VALUE_MAX : 0;
    for (let k = 1; k <= PERF_VALUE_COUNT; k++) {
        const p = slotBase + PERF_VALUES_OFF_IN_SLOT + k * 4;
        if (p + 4 <= u8.length) dv.setFloat32(p, v, true);
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
const keyFillPortBtn = $('#keyFillPort');
const keyClearBtn = $('#keyClear');
const sigCell = $('#sigCell');
const sigStatus = $('#sigStatus');
const sourceCell = $('#sourceCell');
const sourceStatus = $('#sourceStatus');
const keyHiddenRow = $('#keyHiddenRow');
const keyShowBtn = $('#keyShow');
const nameHint = $('#nameHint');
const backupHint = $('#backupHint');
const keyHint = $('#keyHint');
const keyAutoNote = $('#keyAutoNote');
const keyFillPortLabelBtn = $('#keyFillPort');
const keyClearLabelBtn = $('#keyClear');
const langEnBtn = $('#langEn');
const langPtBtn = $('#langPt');

carsDiv.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT') perfChoice[e.target.id.slice(4)] = e.target.value;
});

function resetUI() {
    summary.hidden = true; editor.hidden = true; applyBtn.disabled = true; dlBtn.disabled = true; dlBakBtn.disabled = true;
    carsDiv.innerHTML = ''; setText('#fileInfo', t('fileNoFile'));
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
    if (keyHiddenRow) { keyHiddenRow.hidden = true; }
    if (sourceCell) { sourceCell.hidden = true; }
    if (sigCell) { sigCell.hidden = true; }
    if (sigStatus) { sigStatus.textContent = '—'; sigStatus.className = 'pill'; }
}

resetUI();

xboxKeyInput.value = readStoredKey();
xboxKeyInput.addEventListener('input', () => {
    storeKey(xboxKeyInput.value);
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
    headerStatus.textContent = headerOk ? t('pillOk') : t('pillInvalid');
    headerStatus.className = 'pill ' + (headerOk ? 'ok' : 'warn');
    if (!headerOk) {
        setText('#profile', '—'); setText('#moneyDisplay', '—'); setText('#slots', '—');
        summary.hidden = false;
        return;
    }

    fmt = FORMATS[key];
    formatDisplay.textContent = fmt === FORMATS.pc ? t('fmtPc') : t('fmtXbox');
    const isXbox = key === 'xbox';
    const xboxNote = document.getElementById('xboxNote');
    if (xboxNote) { xboxNote.hidden = !isXbox; xboxNote.textContent = isXbox ? t('xboxNote') : ''; }
    nameHint.textContent = fmt === FORMATS.pc ? t('nameHintPc') : t('nameHintXbox');

    // Xbox saves of the Switch port are signed with the all-zero key, so that
    // signature can be recognised from the bytes alone: if the three HMAC fields
    // verify with the zero key, the save came from the port. Saves written by
    // xemu or a console use their own key and verify with the zero key never.
    sourceCell.hidden = !isXbox;
    keyHiddenRow.hidden = true;
    if (isXbox) {
        const zeroKey = parseKeyHex(KNOWN_PORT_KEY);
        if (verifyXbox(originalBuf, zeroKey).ok) {
            sourceStatus.textContent = t('srcPort');
            sourceStatus.className = 'pill ok';
            const current = parseKeyHex(xboxKeyInput.value);
            if (!current || !verifyXbox(originalBuf, current).ok) {
                xboxKeyInput.value = KNOWN_PORT_KEY;
                storeKey(KNOWN_PORT_KEY);
            }
            xboxKeyRow.hidden = true;
            keyHiddenRow.hidden = false;
        } else {
            sourceStatus.textContent = t('srcXemu');
            sourceStatus.className = 'pill warn';
            xboxKeyRow.hidden = false;
        }
        updateSigStatus();
    }
    sigCell.hidden = !isXbox;
    nameField.maxLength = fmt.nameMax;
    if (fmt.upper) { nameField.style.textTransform = 'uppercase'; }

    const name = readCString(workBuf, fmt.name) || '(empty)';
    const money = dv.getInt32(fmt.money, true);
    usedSlots = calcUsedSlots(workBuf);
    setText('#profile', name);
    setText('#moneyDisplay', String(money));
    setText('#slots', String(usedSlots));
    summary.hidden = false;

    dlBakBtn.disabled = !(backupToggle.checked && originalBuf);

    carsDiv.innerHTML = '';
    for (let i = 0; i < NUM_SLOTS; i++) {
        const locked = isSlotLocked(workBuf, i);
        const inUse = !locked;
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
          <div><strong>${esc(t('carLabel', { n: i + 1 }))}</strong> <span class="muted">${esc(inUse ? t('carInUse') : locked ? t('carLocked') : t('carEmpty'))}</span></div>
          <label class="muted" for="car_${i}">${esc(t('perfLabel'))}</label>
          <select id="car_${i}" ${inUse ? '' : 'disabled'}>
            <option value="2">${esc(t('optNone'))}</option>
            <option value="0">${esc(t('optNill'))}</option>
            <option value="1">${esc(t('optMax'))}</option>
          </select>
          ${(!inUse && locked) ? `<button id="unlock_${i}" style="margin-top:8px">${esc(t('btnUnlock'))}</button>` : ''}
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
                        setStatus(t('stUnlocked', { n: i + 1 }));
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
            setStatus(t('stMoney', { max: MONEY_MAX }));
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

    let msg = t('stApplied', { name: fileHandle.name });
    if (isXbox) {
        if (!signed) {
            msg += t('stNoKey');
        } else if (keyValidated) {
            msg += t('stKeyOk');
        } else {
            msg += t('stKeyMismatch');
        }
    }
    setStatus(msg);
    applyBtn.textContent = t('appliedBtn');
    setTimeout(() => applyBtn.textContent = t('btnApply'), 1000);
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
    setStatus(t('stBakDone', { name: fileHandle.name }));
});

backupToggle.addEventListener('change', () => {
    dlBakBtn.disabled = !(backupToggle.checked && originalBuf);
});

keyShowBtn.addEventListener('click', () => {
    keyHiddenRow.hidden = true;
    xboxKeyRow.hidden = false;
    xboxKeyInput.focus();
});

// The .bak is not a file created on load: it is the original bytes kept in
// memory, offered as a download. Say where it lands, in the status line.
function applyLanguage() {
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    xboxKeyInput.placeholder = t('keyPh');
    keyFillPortLabelBtn.textContent = t('keyFillPort');
    keyFillPortLabelBtn.title = t('keyFillPortTitle');
    keyClearLabelBtn.textContent = t('keyClear');
    keyHint.textContent = t('keyHint');
    keyAutoNote.textContent = t('keyAutoNote');
    keyShowBtn.textContent = t('keyShow');
    backupHint.textContent = t('backupHint');
    fileInfo.textContent = fileHandle ? `${fileHandle.name} — ${fileHandle.size.toLocaleString()} bytes` : t('fileNoFile');
    langEnBtn.setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
    langPtBtn.setAttribute('aria-pressed', lang === 'pt' ? 'true' : 'false');
    try { localStorage.setItem(LANG_STORAGE, lang); } catch (e) { /* storage disabled */ }
    if (workBuf && fmt) { render(); }
}

langEnBtn.addEventListener('click', () => { lang = 'en'; applyLanguage(); });
langPtBtn.addEventListener('click', () => { lang = 'pt'; applyLanguage(); });
applyLanguage();

reloadBtn.addEventListener('click', () => {
    if (fileHandle) {
        resetUI();
        fileInput.value = '';
        alert(t('stReset'));
    }
});
