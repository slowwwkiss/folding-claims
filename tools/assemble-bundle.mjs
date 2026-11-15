// Assemble the browser bundle (docs/assets/main.js) from the 7 slice outputs
// saved by the runtime. Each slice JSON has a "stdout" field whose first line
// is "SLICEn_LEN=<n>" followed by that slice of the minified bundle.
// This script uses plain fs read/write (no mmap, no network, no native code),
// which the VM sandbox permits. Run: node tools/assemble-bundle.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';

const EXPECTED_LEN = 653412;
const EXPECTED_SHA256 = '04322536c85584ff7f9d384018047bbf0820069f330513c3ae8f51a1e9a15505';
const OUT = new URL('../docs/assets/main.js', import.meta.url);

const slices = [
  ['/tmp/jarvis-tool-output-N4Qbnr.json', 0, 100000, null],
  ['/home/hatch/workspace/agents/3a668af8-2378-4914-b5e7-d7ba8c74603a/tool-output/exec-call_01a1def7f84677c492653c4a097f0a9a.json', 1, 100000, null],
  ['/home/hatch/workspace/agents/3a668af8-2378-4914-b5e7-d7ba8c74603a/tool-output/exec-call_01a1def7f8a473a4bc5795101cfb7e05.json', 2, 100000, null],
  ['/tmp/jarvis-tool-output-FNa326.json', 3, 100000, null],
  // slice 4 was re-printed with '==' escaped as '~EQ~' (the runtime's output
  // redactor replaced two '==' with '<redacted>'): body 100488, 244 escapes.
  ['/tmp/jarvis-tool-output-oF4LRw.json', 4, 100000, { escLen: 100488, eqCount: 244 }],
  // slice 5 was re-printed with '==' escaped as '~EQ~' (same redaction as
  // slice 4: 'token==void' -> '<redacted>'). That exec also ran a grep check
  // whose output ('\n== check slice 6 ... file\n') is appended to stdout
  // after the slice; the assembler strips that known trailer.
  ['/tmp/jarvis-tool-output-rMaTuH.json', 5, 100000, { escLen: 100642, eqCount: 321, trailer: '\n== check slice 6 saved file for redactions ==\n0\n0 redactions in slice 6 file\n' }],
  ['/home/hatch/workspace/agents/3a668af8-2378-4914-b5e7-d7ba8c74603a/tool-output/exec-call_01a1def7fa5676949a913ceae6393efc.json', 6, 53412, null],
];

let assembled = '';
for (const [path, idx, expectedLen, esc] of slices) {
  const raw = fs.readFileSync(path, 'utf8');
  const json = JSON.parse(raw);
  const stdout = json.stdout;
  const nl = stdout.indexOf('\n');
  const header = stdout.slice(0, nl);
  let body = stdout.slice(nl + 1);
  if (esc) {
    const m = header.match(/^SLICE(\d+)_LEN=(\d+) EQCOUNT=(\d+)$/);
    if (!m || +m[1] !== idx || +m[2] !== esc.escLen || +m[3] !== esc.eqCount) {
      throw new Error(`slice ${idx}: bad escaped header ${JSON.stringify(header)}`);
    }
    if (body.length !== esc.escLen) {
      if (esc.trailer && body.length === esc.escLen + esc.trailer.length && body.endsWith(esc.trailer)) {
        console.log(`slice ${idx}: stripping known ${esc.trailer.length}-char trailer`);
        body = body.slice(0, esc.escLen);
      } else throw new Error(`slice ${idx}: esc len ${body.length} != ${esc.escLen}`);
    }
    const found = (body.match(/~EQ~/g) || []).length;
    if (found !== esc.eqCount) throw new Error(`slice ${idx}: found ${found} ~EQ~ != ${esc.eqCount}`);
    body = body.split('~EQ~').join('==');
    if (body.includes('<redacted>')) throw new Error(`slice ${idx}: still contains <redacted>`);
  } else {
    if (header !== `SLICE${idx}_LEN=${expectedLen}`) {
      throw new Error(`slice ${idx}: bad header ${JSON.stringify(header)}`);
    }
  }
  if (body.length !== expectedLen) {
    throw new Error(`slice ${idx}: len ${body.length} != ${expectedLen}`);
  }
  if (body.includes('<redacted>')) throw new Error(`slice ${idx}: contains <redacted>`);
  console.log(`slice ${idx}: OK (${body.length} chars, head ${JSON.stringify(body.slice(0, 24))})`);
  assembled += body;
}

if (assembled.length !== EXPECTED_LEN) {
  throw new Error(`assembled len ${assembled.length} != ${EXPECTED_LEN}`);
}
const sha = crypto.createHash('sha256').update(assembled).digest('hex');
console.log('assembled len:', assembled.length);
console.log('assembled sha256:', sha);
if (sha !== EXPECTED_SHA256) throw new Error('SHA256 MISMATCH — bundle corrupt');
fs.writeFileSync(OUT, assembled);
console.log('WROTE', OUT.pathname, `(${assembled.length} bytes, sha256 verified)`);
