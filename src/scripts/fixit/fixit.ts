#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { $ } from "bun";

// Paths
const ROOT_DIR = new URL("../../../", import.meta.url).pathname;
const FIX_FILE = join(ROOT_DIR, "ts-fixes.json");
const WORK_DIR = join(ROOT_DIR, ".fixit");
const PROMPT_DIR = join(WORK_DIR, "prompts");
const LOG_DIR = join(WORK_DIR, "logs");

// Create directories
if (!existsSync(PROMPT_DIR)) mkdirSync(PROMPT_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// Read JSON
const json = JSON.parse(readFileSync(FIX_FILE, "utf-8"));

// Default mode: emit
const MODE = process.argv[2] ?? "emit";

let total = 0;

for (const [fi, fix] of json.fixes.entries()) {
  const errorCode = fix.errorCode;
  const description = fix.description;
  for (const [ci, fc] of fix.fileChanges.entries()) {
    total++;
    const file = fc.path;
    const instruction = fc.instruction;
    const lines = fc.lines;

    const promptPath = join(PROMPT_DIR, `fix-${fi}-${ci}.txt`);
    const logPath = join(LOG_DIR, `fix-${fi}-${ci}.log`);

    const promptContent = `Error group: ${errorCode}
Group description: ${description}

Target file: ${file}
Lines involved: ${JSON.stringify(lines)}

Instruction:
${instruction}

Make the smallest correct change. Respond only with a unified diff.
`;

    writeFileSync(promptPath, promptContent);
    console.log(`Prepared ${promptPath}`);

    if (MODE === "run") {
      console.log(`Running aider for fix ${fi}.${ci}...`);
      try {
        // Using Bun’s $ for shell execution
        $`aider --no-git --message-file ${promptPath} ${join(ROOT_DIR, file)}`.run();
        console.log(`Finished. Log at ${logPath}`);
      } catch (e) {
        console.error(`Error running Aider for fix ${fi}.${ci}:`, e);
      }
    }
  }
}

console.log(`Prepared ${total} prompt files in ${PROMPT_DIR}`);
if (MODE === "run") console.log(`Executed ${total} Aider runs.`);
