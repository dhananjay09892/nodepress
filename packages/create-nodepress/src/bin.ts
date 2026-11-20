#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runInstaller, type CliIo } from './cli.js';

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
const io: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  cwd: process.cwd(),
  env: process.env,
  ...(rl ? { ask: (question: string) => rl.question(question) } : {}),
};

try {
  process.exitCode = await runInstaller(process.argv.slice(2), io);
} finally {
  rl?.close();
}
