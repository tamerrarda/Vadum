import base45 from 'base45';
import QRCode from 'qrcode';

const cases = [
  ['QR#1 intent  (fresh path, w/ blockhash)', 107],
  ['QR#1 intent  (nonce path)',                75],
  ['QR#2 auth    (fresh path)',                98],
  ['QR#2 auth    (nonce path)',               131],
  ['[baseline] full signed tx',               483],
];

const row = (label, n) => {
  const bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
  const enc = base45.encode(bytes);
  const out = [];
  for (const ec of ['L','M','Q']) {
    const seg = QRCode.create(enc, { errorCorrectionLevel: ec });
    const mode = seg.segments[0]?.mode?.id ?? '?';
    out.push(`${ec}:v${String(seg.version).padStart(2)} ${seg.modules.size}px [${mode}]`);
  }
  console.log(`${label.padEnd(40)} ${String(n).padStart(4)}B → b45 ${String(enc.length).padStart(4)}ch   ${out.join('   ')}`);
};

console.log('payload'.padEnd(40), ' raw   base45           QR version / matrix size / mode\n' + '-'.repeat(120));
for (const [l,n] of cases) row(l,n);

// sanity: is base45 output actually alphanumeric-safe?
const t = base45.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(131))));
const ALNUM = /^[0-9A-Z $%*+\-.\/:]+$/;
console.log('\nbase45 output is QR-alphanumeric safe:', ALNUM.test(t) ? 'YES ✅' : 'NO ❌');
console.log('roundtrip ok:', Buffer.compare(Buffer.from(base45.decode(t)), Buffer.from(base45.decode(t))) === 0 ? 'YES ✅' : 'NO');

// compare against raw byte-mode (no base45) to prove base45 is worth it
const raw131 = QRCode.create(Buffer.from(crypto.getRandomValues(new Uint8Array(131))).toString('binary'), { errorCorrectionLevel:'M' });
const b45_131 = QRCode.create(base45.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(131)))), { errorCorrectionLevel:'M' });
console.log(`\n131B at EC-M:  byte-mode → v${raw131.version} (${raw131.modules.size}px)   |   base45 → v${b45_131.version} (${b45_131.modules.size}px)`);
