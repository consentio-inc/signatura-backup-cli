#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`Se necesita Node.js 22.13 o superior (tiene ${process.versions.node}).\n`);
  process.exit(2);
}

// node:sqlite prints an ExperimentalWarning on load; it is noise for the
// operator. Installed before the dynamic import below so it covers that load.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0]?.type ?? warning?.name);
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  emitWarning.call(process, warning, ...rest);
};

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
