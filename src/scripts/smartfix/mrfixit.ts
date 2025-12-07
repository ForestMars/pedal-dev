#!/usr/bin/env bun
/**
 * @file mrfixit.ts
 * @description Smart TypeScript Error Fixer
 *              Rules-first, LLM fallback, streaming enabled for large models
 * @version 0.0.11
 * @author Your Team
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ErrorGroup, TSError, FixResult } from './types';
import { analyzeWithRules } from './engines/rules';
import { OllamaClient } from '@ollama/client';

interface Config {
  analyzer: 'rules' | 'llm' | 'hybrid';
  llmProvider?: 'ollama' | 'claude';
  model: string;
  ollamaHost: string;
  maxGroups: number;
  errorsPath: string;
  outputJsonPath: string;
  outputTxtPath: string;
  outputFormat: 'markdown' | 'json' | 'aider';
}

const DEFAULTS: Config = {
  analyzer: 'rules',
  llmProvider: 'ollama',
  model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:32b',
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  errorsPath: join(process.cwd(), 'build-errors.txt'),
  outputJsonPath: join(process.cwd(), 'ts-fixes.json'),
  outputTxtPath: join(process.cwd(), 'ts-fixes.txt'),
  maxGroups: Infinity,
  outputFormat: 'aider'
};

// ---- LLM CALL WITH STREAMING ----
async function callLLM(prompt: string, model: string): Promise<string> {
  const client = new OllamaClient({ apiHost: DEFAULTS.ollamaHost });

  let output = '';
  const response = await client.generate({
    model,
    prompt,
    maxTokens: 1500,
    temperature: 0,
    stream: true, // <-- ENABLE STREAMING
    stop: ["\n\n"]
  });

  // Streaming handler
  for await (const chunk of response.stream()) {
    if (chunk.type === 'output_text') {
      output += chunk.text;
    }
  }

  return output;
}

// ---- PARSE TS ERRORS ----
function parseTypeScriptErrors(output: string): TSError[] {
  const errors: TSError[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/);
    if (!match) continue;
    const [, file, lineNum, col, code, message] = match;

    let context = message;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const nextLine = lines[j].trim();
      if (nextLine && !nextLine.match(/^[a-zA-Z]/)) context += '\n' + nextLine;
      else break;
    }

    errors.push({
      file,
      line: parseInt(lineNum),
      column: parseInt(col),
      code,
      message,
      context: context.trim()
    });
  }
  return errors;
}

// ---- GROUP ERRORS ----
function groupErrors(errors: TSError[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const error of errors) {
    let pattern = error.message;
    switch (error.code) {
      case 'TS2835': case 'TS2834': pattern = 'Missing file extension in import'; break;
      case 'TS7006': pattern = 'Implicit any type'; break;
      case 'TS2307': pattern = 'Cannot find module'; break;
      case 'TS7016': pattern = 'Missing type declarations'; break;
      case 'TS2339': pattern = 'Property does not exist'; break;
      case 'TS2304': pattern = 'Cannot find name'; break;
    }

    const key = `${error.code}:${pattern}`;
    if (!groups.has(key)) {
      groups.set(key, { code: error.code, pattern, errors: [], count: 0 });
    }
    const group = groups.get(key)!;
    group.errors.push(error);
    group.count++;
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

// ---- OUTPUT FORMATTING ----
function generateAiderText(fixes: Array<{ group: ErrorGroup; fix: FixResult }>): string {
  let text = '';
  for (const { group, fix } of fixes) {
    text += `${group.code} ${group.pattern}\n`;
    text += `  - ${group.count} occurrence${group.count > 1 ? 's' : ''} across ${fix.fileChanges?.length || 0} file${(fix.fileChanges?.length || 0) > 1 ? 's' : ''}\n`;
    text += `  - ${fix.description}\n`;
    if (fix.fileChanges?.length) {
      text += `  - Files:\n`;
      for (const fc of fix.fileChanges) {
        const lineStr = fc.lines?.length === 1 ? `line ${fc.lines[0]}` : `lines ${fc.lines?.join(',')}`;
        text += `    ${fc.path} (${lineStr})\n`;
      }
    }
    text += '\n';
  }
  return text.trim();
}

function generateAiderOutput(fixes: Array<{ group: ErrorGroup; fix: FixResult }>): any {
  return {
    summary: `Fixed ${fixes.length} error groups`,
    fixes: fixes.map(({ group, fix }) => ({
      errorCode: group.code,
      pattern: group.pattern,
      count: group.count,
      confidence: fix.confidence,
      fixType: fix.fixType,
      description: fix.description,
      fileChanges: fix.fileChanges || [],
      commands: fix.commands || [],
      manualSteps: fix.manualSteps || []
    }))
  };
}

// ---- MAIN ----
async function main() {
  const config = DEFAULTS;

  console.log(`🔧 Smart TypeScript Error Fixer`);
  console.log(`⚙️  Analyzer: ${config.analyzer}`);
  console.log(`⚙️  LLM Model: ${config.model} (streaming enabled)\n`);

  let errorInput = '';
  if (!process.stdin.isTTY) {
    for await (const chunk of process.stdin) errorInput += chunk;
  } else if (existsSync(config.errorsPath)) {
    errorInput = readFileSync(config.errorsPath, 'utf8');
  } else {
    console.error('❌ No input provided!');
    process.exit(1);
  }

  if (!errorInput.trim()) {
    console.error('❌ No errors to analyze!');
    process.exit(1);
  }

  const errors = parseTypeScriptErrors(errorInput);
  if (!errors.length) {
    console.log('⚠️  No parseable TypeScript errors found');
    process.exit(1);
  }

  const groups = groupErrors(errors);
  const groupsToProcess = groups.slice(0, config.maxGroups);

  console.log(`Found ${errors.length} errors in ${groups.length} categories`);
  console.log(`Processing ${groupsToProcess.length} categories\n`);

  // ---- RUN RULES FIRST ----
  const result = analyzeWithRules(groupsToProcess);

  // ---- RUN LLM ON UNKNOWNS ----
  if (result.unknown.length > 0 && config.analyzer !== 'rules') {
    for (const unknownGroup of result.unknown) {
      const prompt = `Analyze this TypeScript error and suggest a fix:\n\n${JSON.stringify(unknownGroup.errors, null, 2)}`;
      try {
        const llmResponse = await callLLM(prompt, config.model);
        unknownGroup.fix = { description: llmResponse, confidence: 0.8 };
      } catch (err) {
        console.error('❌ LLM call failed:', err);
      }
    }
  }

  // ---- WRITE OUTPUT ----
  await Bun.write(config.outputJsonPath, JSON.stringify(generateAiderOutput(result.fixes), null, 2));
  const aiderText = generateAiderText(result.fixes);
  await Bun.write(config.outputTxtPath, aiderText);

  console.log(`💾 Fixes written to ${config.outputJsonPath} (JSON)`);
  console.log(`💾 Fixes written to ${config.outputTxtPath} (Aider-style text)`);
  console.log(`✨ Done!`);
}

main();
