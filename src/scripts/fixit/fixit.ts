#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { spawn } from "bun";

// ---- Paths ----
const ROOT_DIR = new URL("../../../", import.meta.url).pathname;
const FIX_FILE = join(ROOT_DIR, "ts-fixes.json");
const WORK_DIR = join(ROOT_DIR, ".fixit");
const PROMPT_DIR = join(WORK_DIR, "prompts");
const LOG_DIR = join(WORK_DIR, "logs");

if (!existsSync(PROMPT_DIR)) mkdirSync(PROMPT_DIR, { recursive: true });
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

// ---- Load JSON ----
console.log(`Loading fixes from ${FIX_FILE}`);
const json = JSON.parse(readFileSync(FIX_FILE, "utf-8"));

// ---- Build pipeline stages ----
type Stage = { promptPath: string; file: string; logPath: string; prompt: string };
const pipeline: Stage[] = [];

for (const [fi, fix] of json.fixes.entries()) {
  for (const [ci, fc] of fix.fileChanges.entries()) {
    const promptPath = join(PROMPT_DIR, `fix-${fi}-${ci}.txt`);
    const logPath = join(LOG_DIR, `fix-${fi}-${ci}.log`);
    const file = join(ROOT_DIR, fc.path);

    const prompt = `Error group: ${fix.errorCode}
Group description: ${fix.description}

Target file: ${fc.path}
Lines involved: ${JSON.stringify(fc.lines)}

Instruction:
${fc.instruction}

Make only the minimal changes needed to fix this error. Do not modify anything else.`;

    pipeline.push({ promptPath, file, logPath, prompt });

    writeFileSync(promptPath, prompt);
    console.log(`Prepared prompt: ${promptPath}`);
  }
}

// ---- Run pipeline ----
async function runPipeline() {
  console.log(`Running pipeline with ${pipeline.length} stages`);
  const TIMEOUT_MS = 300000; // 2 minutes timeout per stage

  for (const [index, stage] of pipeline.entries()) {
    console.log(`\n=== Stage ${index + 1}/${pipeline.length} ===`);
    console.log(`Target file: ${stage.file}`);
    console.log(`Prompt file: ${stage.promptPath}`);
    console.log(`Log file: ${stage.logPath}`);

    try {
      const process = spawn({
        cmd: [
          "aider",
          stage.file,
          "--model", "qwen2.5-coder:1.5b",
          "--edit-format", "udiff",
          "--yes",
          "--message", stage.prompt
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      // Race between process completion and timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS)
      );

      const processPromise = (async () => {
        const stdout = await process.stdout.text();
        const stderr = await process.stderr.text();
        const exit = await process.exited;
        return { stdout, stderr, exitCode: exit.exitCode };
      })();

      const result = await Promise.race([processPromise, timeoutPromise]) as {
        stdout: string;
        stderr: string;
        exitCode: number;
      };

      console.log(`Aider exit code: ${result.exitCode}`);
      if (result.stderr.trim().length > 0) console.log(`Aider stderr: ${result.stderr}`);

      writeFileSync(stage.logPath, `STDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`);
      console.log(`Aider output saved to: ${stage.logPath}`);

      if (result.exitCode === 0) {
        console.log(`✓ File updated successfully`);
      } else {
        console.error(`✗ Aider failed with exit code ${result.exitCode}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "Timeout") {
        console.error(`✗ Aider timed out after ${TIMEOUT_MS / 1000}s for ${stage.file}`);
        writeFileSync(stage.logPath, `ERROR: Timeout after ${TIMEOUT_MS / 1000}s`);
      } else {
        console.error(`Error running Aider for ${stage.file}:`, err);
      }
    }
  }

  console.log("\nPipeline complete.");
}

// ---- Entry point ----
if (process.argv[2] === "run") {
  runPipeline();
} else {
  console.log(
    "Prompts emitted. Run `bun ./src/scripts/fixit/fixit.ts run` to execute the Ollama pipeline."
  );
}