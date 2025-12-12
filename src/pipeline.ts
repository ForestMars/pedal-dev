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

if (!existsSync(PROMPT_DIR)) mkdirSync(PROMPT_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const json = JSON.parse(readFileSync(FIX_FILE, "utf-8"));

// Build an array of pipeline stages
const pipeline: { promptPath: string; file: string; logPath: string }[] = [];

for (const [fi, fix] of json.fixes.entries()) {
  for (const [ci, fc] of fix.fileChanges.entries()) {
    const promptPath = join(PROMPT_DIR, `fix-${fi}-${ci}.txt`);
    const logPath = join(LOG_DIR, `fix-${fi}-${ci}.log`);
    const file = join(ROOT_DIR, fc.path);

    pipeline.push({ promptPath, file, logPath });

    // Emit prompt file
    const content = `Error group: ${fix.errorCode}
Group description: ${fix.description}

Target file: ${fc.path}
Lines involved: ${JSON.stringify(fc.lines)}

Instruction:
${fc.instruction}

Make the smallest correct change. Respond only with a unified diff.
`;
    writeFileSync(promptPath, content);
    console.log(`Prepared ${promptPath}`);
  }
}

// Run the pipeline sequentially
async function runPipeline() {
  for (const stage of pipeline) {
    console.log(`Running Aider for ${stage.file}...`);
    try {
      const result = await $`aider --no-git --message-file ${stage.promptPath} ${stage.file}`.text();
      writeFileSync(stage.logPath, result);
      console.log(`Finished. Log at ${stage.logPath}`);
    } catch (e) {
      console.error(`Error running Aider for ${stage.file}:`, e);
    }
  }
}

if (process.argv[2] === "run") {
  runPipeline().then(() => console.log("Pipeline complete."));
} else {
  console.log("Prompts emitted. Run `bun ./src/scripts/fixit/fixit.ts run` to execute the pipeline.");
}

