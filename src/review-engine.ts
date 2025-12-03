// src/review-engine.ts

import { Context } from 'probot';
import { LLMProvider } from './providers';
import { ConfigLoader } from './config-loader';
import * as path from 'path';

const MAX_FILE_SIZE_KB = 512;
const MAX_CHANGES_PER_FILE = 500;
const MAX_FILES_TO_REVIEW = 10;

interface PRFile {
  sha: string;
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  patch: string;
}

interface ReviewFinding {
  severity: 'high' | 'medium';
  category: 'security' | 'bug' | 'performance';
  filename: string;
  message: string;
  suggestion: string;
  line?: number;
}

export class ReviewEngine {
  private configLoader: ConfigLoader;

  constructor(private llm: LLMProvider) {
    this.configLoader = new ConfigLoader();
  }

  /**
   * Main function to review a Pull Request.
   */
  async reviewPR(context: Context, pr: any, repo: any): Promise<void> {
    const owner = repo.owner.login;
    const repoName = repo.name;
    const prNumber = pr.number;

    try {
      const { data: files } = await context.octokit.pulls.listFiles({
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100
      });

      const filesToReview = this.filterFiles(files as PRFile[]);
      
      if (filesToReview.length === 0) {
        console.log('✓ No reviewable files found.');
        return;
      }
      
      // --- CRITICAL DEBUGGING TRACE 1 ---
      console.log(`[DEBUG_TRACE] 1. Initial LLM model: ${this.llm.getModelName()}`);
      // ----------------------------------

      const findings = await this.generateReview(pr, filesToReview);
      
      // --- CRITICAL DEBUGGING TRACE 2 ---
      console.log(`[DEBUG_TRACE] 2. LLM model after generation: ${this.llm.getModelName()}`);
      // ----------------------------------

      console.log(`✓ Parsed ${findings.length} finding(s)`);

      if (findings.length > 0) {
        await this.postReview(context, owner, repoName, prNumber, pr.head.sha, findings);
      } else {
        console.log('✓ No issues found');
        
        // --- FIXED COMMENT FORMATTING FOR NO ISSUES ---
        const modelName = this.llm.getModelName();
        await context.octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: prNumber,
          body: `## 🤖 AI Code Review (${this.llm.name} (${modelName}))\n\n✅ No significant issues found. Code looks good!`
        });
        // ---------------------------------------------
      }
      
      console.log('✅ Review complete!');

    } catch (error: any) {
      console.error(`🔴 Fatal error during review for PR #${prNumber}: ${error.message}`);
      
      // --- ERROR COMMENT FORMATTING ---
      const modelName = this.llm.getModelName();
      await context.octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: prNumber,
        body: `## 🤖 AI Code Review (${this.llm.name} (${modelName}))\n\n❌ Review failed due to internal error: \n\`\`\`\n${error.message}\n\`\`\``
      });
      // --------------------------------
    }
  }

  /**
   * Filters and limits the files to be reviewed.
   */
  private filterFiles(files: PRFile[]): PRFile[] {
    const ignorePatterns = [
      /\.lock$/,
      /package-lock\.json$/,
      /yarn\.lock$/,
      /bun\.lockb$/,
      /\.min\.(js|css)$/,
      /\.map$/,
      /dist\//,
      /build\//,
      /node_modules\//,
      
      // Agent Config/Documentation Ignores
      /README\.(rst|md)$/, 
      /\.md$/, 
      /\.yml$/, 
      /prompts\//, 
      /\.txt$/, 
    ];

    return files
      .filter(f => !ignorePatterns.some(pattern => pattern.test(f.filename)))
      .filter(f => f.changes < MAX_CHANGES_PER_FILE)
      .slice(0, MAX_FILES_TO_REVIEW);
  }

  /**
   * Generates the review by calling the LLM.
   */
  private async generateReview(pr: any, files: PRFile[]): Promise<ReviewFinding[]> {
    const prompt = this.buildReviewPrompt(pr, files);

    // This is the point of execution where the Ollama API is called.
    // If the model name is wrong, the API call fails, and an error handler *outside* this function
    // (but likely inside the main Probot framework loop) is probably creating a NEW provider instance
    // with the hardcoded "codellama" string.
    const response = await this.llm.generateReview(prompt);
    
    console.log(`\t✓ Got response from LLM (${response.length} chars)`);
    return this.parseReviewResponse(response);
  }

  /**
   * Constructs the full prompt for the LLM.
   */
  private buildReviewPrompt(pr: any, files: PRFile[]): string {
    const promptTemplate = this.loadPromptTemplate();

    // Context for the review
    let fileContext = '';
    files.forEach(file => {
      fileContext += `\n\n--- [FILE_START: ${file.filename} (Status: ${file.status})] ---\n`;
      fileContext += file.patch || 'No code changes provided.';
      fileContext += `\n--- [FILE_END: ${file.filename}] ---\n`;
    });

    const prompt = promptTemplate
      .replace('[PR_TITLE]', pr.title)
      .replace('[PR_BODY]', pr.body || 'No description provided.')
      .replace('[FILE_CONTEXT]', fileContext);

    return prompt;
  }

  /**
   * Loads the review prompt template from a file.
   */
  private loadPromptTemplate(): string {
    // Assuming the prompt file is relative to the project root
    const promptPath = path.resolve(process.cwd(), 'src/prompts/review-prompt.txt');
    try {
      // NOTE: Using synchronous read for startup process simplicity
      return this.configLoader.getAgent('pr-review')?.context || 
             require('fs').readFileSync(promptPath, 'utf8');
    } catch (e) {
      console.warn(`Could not load prompt template from ${promptPath}. Using default context.`);
      // Fallback context to prevent crash
      return `# PR Review Instructions\nFocus on the following areas:\n1. Security\n2. Bugs\n3. Performance\n\nReturn ONLY a JSON array.\n[FILE_CONTEXT]`;
    }
  }

  /**
   * Parses the JSON response from the LLM.
   */
  private parseReviewResponse(response: string): ReviewFinding[] {
    // 1. Aggressively clean up non-JSON boilerplate (Fix for 'Unexpected token F')
    let cleanResponse = response.trim();
    
    // Remove markdown code fences (e.g., ```json or ```)
    cleanResponse = cleanResponse.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '');
    
    // Remove any trailing or leading quotes/placeholders the LLM might hallucinate
    cleanResponse = cleanResponse.replace(/^"|"$|^\[FILE_CONTEXT\]\s*/g, '');
    
    // Fallback check: If the LLM returned nothing or garbage, treat it as an empty array
    if (!cleanResponse.trim().startsWith('[')) {
      console.warn(`LLM response did not start with '[' after cleanup. Raw response start: "${response.substring(0, 50)}"`);
      cleanResponse = '[]';
    }

    try {
      return JSON.parse(cleanResponse);
    } catch (error) {
      console.error(`Failed to parse clean response: "${cleanResponse.substring(0, 100)}"`);
      throw error;
    }
  }

  /**
   * Posts the final review summary and line comments.
   */
  private async postReview(
    context: Context,
    owner: string,
    repoName: string,
    prNumber: number,
    sha: string,
    findings: ReviewFinding[]
  ): Promise<void> {
    
    // --- FIXED COMMENT FORMATTING ---
    const modelName = this.llm.getModelName();
    let body = `## 🤖 AI Code Review (${this.llm.name} (${modelName}))\n\n`;
    // --------------------------------

    body += `Found ${findings.length} issue${findings.length > 1 ? 's' : ''}. Severity breakdown:\n\n`;

    // Group findings by severity and category for the summary
    const highFindings = findings.filter(f => f.severity === 'high');
    const mediumFindings = findings.filter(f => f.severity === 'medium');

    if (highFindings.length > 0) {
      body += `### 🔴 High Priority (${highFindings.length})\n`;
      highFindings.forEach((f, i) => {
        body += `* [${f.category.toUpperCase()}] **${f.filename}${f.line ? `:${f.line}` : ''}**: ${f.message}\n`;
      });
      body += '\n';
    }

    if (mediumFindings.length > 0) {
      body += `### 🟡 Medium Priority (${mediumFindings.length})\n`;
      mediumFindings.forEach((f, i) => {
        body += `* [${f.category.toUpperCase()}] **${f.filename}${f.line ? `:${f.line}` : ''}**: ${f.message}\n`;
      });
      body += '\n';
    }

    // Prepare comments for line-by-line review
    const comments = findings.map(f => ({
      path: f.filename,
      position: f.line || 1, // Default to line 1 if line number is missing
      body: `**[${f.severity.toUpperCase()} ${f.category.toUpperCase()}]** ${f.message}\n\n*Suggestion*: ${f.suggestion}`
    }));
    
    // Post the detailed review
    await context.octokit.pulls.createReview({
      owner,
      repo: repoName,
      pull_number: prNumber,
      commit_id: sha,
      body: body,
      event: highFindings.length > 0 ? 'REQUEST_CHANGES' : 'COMMENT',
      comments: comments
    });
  }
}