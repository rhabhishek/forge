// Forge interactive prompts — dependency-free. Arrow-key select + confirm with
// a typed-input fallback when stdin isn't a TTY (CI, piped input). Raw mode is
// used only for the duration of a prompt; we always restore it.

import readline from 'node:readline/promises';

const ESC = '\u001b';
export const isTTY = () => process.stdin.isTTY && process.stdout.isTTY;

function render(label, items, idx) {
  const lines = [`${label}`];
  items.forEach((it, i) => {
    const sel = i === idx;
    lines.push(`${sel ? '\u001b[36m❯ ' : '  '}${it.title}\u001b[0m`);
  });
  process.stdout.write(lines.join('\n') + '\n');
}

// Move cursor up n lines and clear to end of screen (to redraw the menu in place).
function clearLines(n) {
  process.stdout.write(`${ESC}[${n}A${ESC}[0J`);
}

// select(label, items, { defaultIndex }) -> resolves the chosen item's `id`.
// items: [{ id, title }]. Non-TTY: prints the list and reads a typed number/id.
export async function select(label, items, { defaultIndex = 0 } = {}) {
  if (!items.length) return undefined;
  if (!isTTY()) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(label);
    items.forEach((it, i) => console.log(`  ${i + 1}. ${it.title}  (${it.id})`));
    const a = (await rl.question(`Choose 1-${items.length} or id [${defaultIndex + 1}]: `)).trim();
    rl.close();
    if (!a) return items[defaultIndex].id;
    if (/^\d+$/.test(a) && +a >= 1 && +a <= items.length) return items[+a - 1].id;
    const byId = items.find((it) => it.id === a);
    return byId ? byId.id : items[defaultIndex].id;
  }

  return new Promise((resolve) => {
    let idx = Math.max(0, Math.min(defaultIndex, items.length - 1));
    const { stdin, stdout } = process;
    stdout.write(`${ESC}[?25l`); // hide cursor
    render(label, items, idx);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');

    const redraw = () => { clearLines(items.length + 1); render(label, items, idx); };
    const cleanup = () => {
      stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
      stdout.write(`${ESC}[?25h`); // show cursor
    };
    const onData = (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (ch === '\u0003') { cleanup(); stdout.write('\n'); process.exit(130); }     // Ctrl-C
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(items[idx].id); return; }
        if (ch === ESC && chunk[i + 1] === '[') {                                       // arrow keys
          const k = chunk[i + 2];
          if (k === 'A') { idx = (idx - 1 + items.length) % items.length; redraw(); }
          if (k === 'B') { idx = (idx + 1) % items.length; redraw(); }
          i += 2; continue;
        }
        if (ch === 'k') { idx = (idx - 1 + items.length) % items.length; redraw(); }
        if (ch === 'j') { idx = (idx + 1) % items.length; redraw(); }
        const n = Number(ch);
        if (Number.isInteger(n) && n >= 1 && n <= items.length) { idx = n - 1; redraw(); }
      }
    };
    stdin.on('data', onData);
  });
}

// confirm(label, def) -> boolean, via the same arrow-key picker (Yes/No).
export async function confirm(label, def = true) {
  const id = await select(label, [{ id: 'y', title: 'Yes' }, { id: 'n', title: 'No' }], { defaultIndex: def ? 0 : 1 });
  return id === 'y';
}

// text(label, def, { hidden }) -> string. Masks input when hidden (tokens).
export function text(label, def = '', { hidden = false } = {}) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    const q = def ? `${label} [${def}]: ` : `${label}: `;
    if (!isTTY()) { stdout.write(q + '\n'); resolve(def); return; }
    stdout.write(q);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let val = '';
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { cleanup(); stdout.write('\n'); resolve(val.trim() || def); return; }
        if (ch === '\u0003') { cleanup(); stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (val.length) { val = val.slice(0, -1); stdout.write('\b \b'); } continue; }
        if (ch < ' ') continue;
        val += ch; stdout.write(hidden ? '*' : ch);
      }
    };
    stdin.on('data', onData);
  });
}
