import readline from 'node:readline';

/**
 * One line reader per input stream. Separate readline interfaces would each
 * swallow whatever stdin had buffered, so a piped `key\ns\n` would lose the
 * confirmation.
 */
const readers = new WeakMap();

function readerFor(input) {
  let reader = readers.get(input);
  if (reader) return reader;
  reader = { queue: [], waiters: [], closed: false, rl: null };
  reader.rl = readline.createInterface({ input, terminal: false });
  reader.rl.on('line', (line) => {
    const waiter = reader.waiters.shift();
    if (waiter) waiter(line);
    else reader.queue.push(line);
  });
  reader.rl.on('close', () => {
    reader.closed = true;
    for (const waiter of reader.waiters.splice(0)) waiter(null);
  });
  readers.set(input, reader);
  return reader;
}

/** Reads one line; null once the input is exhausted. */
export async function readLine(question, { input = process.stdin, output = process.stderr } = {}) {
  output.write(question);
  const reader = readerFor(input);
  let line;
  if (reader.queue.length > 0) line = reader.queue.shift();
  else if (reader.closed) line = null;
  else line = await new Promise((resolve) => reader.waiters.push(resolve));
  // A terminal echoes the Enter key; piped input does not.
  if (!input.isTTY) output.write('\n');
  return line;
}

/** Releases stdin so the process can exit once no more answers are needed. */
export function closePrompts(input = process.stdin) {
  const reader = readers.get(input);
  if (!reader) return;
  reader.rl.close();
  readers.delete(input);
}

/** Reads a line without echoing it, so a pasted API key never shows on screen. */
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return readLine(question, { input, output });

  return new Promise((resolve) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const finish = (result) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      resolve(result);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\u0003') return finish(null); // Ctrl-C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

/** Yes/no in Spanish: `s` or `si` accept; anything else declines. */
export async function confirm(question, opts) {
  const answer = await readLine(`${question} [s/N] `, opts);
  const normalized = (answer ?? '').trim().toLowerCase();
  return normalized === 's' || normalized === 'si' || normalized === 'sí';
}
