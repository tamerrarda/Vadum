import base45 from 'base45'; import QRCode from 'qrcode';
const cases = [
  ['STATIC_INTENT  (type 2, printed)',            68],
  ['INTENT         (type 1, nonce path)',         76],
  ['INTENT         (type 1, fresh path)',        108],
  ['AUTH           (type 3, fresh)',              99],
  ['AUTH           (type 3, nonce, dynamic)',    132],
  ['AUTH           (type 3, nonce, static+amt)', 140],
  ['NONCE_RETURN   (type 4, recovery)',           36],
];
console.log('payload'.padEnd(44),'raw   base45      EC-M          EC-Q');
console.log('-'.repeat(96));
for (const [l,n] of cases) {
  const enc = base45.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(n))));
  const m = QRCode.create(enc,{errorCorrectionLevel:'M'}), q = QRCode.create(enc,{errorCorrectionLevel:'Q'});
  console.log(`${l.padEnd(44)}${String(n).padStart(4)}B ${String(enc.length).padStart(5)}ch   v${String(m.version).padStart(2)} ${String(m.modules.size).padStart(3)}px   v${String(q.version).padStart(2)} ${String(q.modules.size).padStart(3)}px`);
}
