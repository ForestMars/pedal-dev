// src/review-engine.ts
import { Context } from "probot";
import { LLMProvider } from "./providers";

interface PRFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  category: string;
  filename: string;
  line?: number;
  message: string;
  suggestion: string;
}

export class ReviewEngine {
  constructor(private llm: LLMProvider) {}

  async reviewPR(context: Context<"pull_request.opened"> | Context<"pull_request.synchronize">, pr: any, repo: any): Promise<void> {
    const owner = repo.owner.login;
    const repoName = repo.name;
    const prNumber = pr.number;

    try {
      // Get PR files using Probot's context
      console.log('📂 Fetching changed files...');
      const { data: files } = await context.octokit.pulls.listFiles({
        owner,
        repo: repoName,
        pull_number: prNumber,
        per_page: 100
      });
      console.log(`✓ Found ${files.length} changed file(s)`);

      // Filter relevant files
      const relevantFiles = this.filterFiles(files);
      console.log(`✓ Filtered to ${relevantFiles.length} relevant file(s)`);
      
      if (relevantFiles.length === 0) {
        console.log('⚠️  No files to review');
        await context.octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: prNumber,
          body: '🤖 **AI Code Review**\n\nNo files to review (only config/lock files changed)'
        });
        return;
      }

      console.log('\nFiles to review:');
      relevantFiles.forEach(f => {
        console.log(`  - ${f.filename} (${f.status}, ${f.changes} changes)`);
      });

      // Generate review
      console.log('\n🧠 Sending to LLM for review...');
      const review = await this.generateReview(pr, relevantFiles);
      
      if (review.length === 0) {
        console.log('✓ No issues found');
        await context.octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: prNumber,
          body: `## 🤖 AI Code Review (${this.llm.getModelName()})\n\n✅ No significant issues found. Code looks good!`
        });
      } else {
        console.log(`✓ Found ${review.length} issue(s)`);
        review.forEach((f, i) => {
          console.log(`  ${i+1}. [${f.severity}] ${f.filename}: ${f.message.substring(0, 60)}...`);
        });
        
        await this.postReview(context, owner, repoName, prNumber, pr.head.sha, review);
      }
      
      console.log('✅ Review complete!\n');
      
    } catch (error) {
      console.error('\n❌ Error during review:', error);
      throw error;
    }
  }

  private filterFiles(files: any[]): PRFile[] {
    const ignorePatterns = [
      /\.lock$/,
      /package-lock\.json$/,
      /yarn\.lock$/,
      /bun\.lockb$/,
      /\.min\.(js|css)$/,
      /\.map$/,
      /dist\//,
      /build\//,
      /node_modules\//
    ];

    return files
      .filter(f => !ignorePatterns.some(pattern => pattern.test(f.filename)))
      .filter(f => f.changes < 500)
      .slice(0, 10);
  }

  private async generateReview(pr: any, files: PRFile[]): Promise<ReviewFinding[]> {
    const prompt = this.buildReviewPrompt(pr, files);
    
    try {
      const response = await this.llm.generateReview(prompt);
      console.log(`✓ Got response from LLM (${response.length} chars)`);
      
      const findings = this.parseReviewResponse(response);
      console.log(`✓ Parsed ${findings.length} finding(s)`);
      
      return findings;
    } catch (error) {
      console.error('Error generating review:', error);
      throw error;
    }
  }

  private buildReviewPrompt(pr: any, files: PRFile[]): string {
    const fileContext = files.map(f => `
### File: ${f.filename} (${f.status})
**Changes**: +${f.additions}/-${f.deletions} lines

\`\`\`diff
${f.patch || 'No diff available'}
\`\`\`
`).join('\n---\n');

    return `You are an expert code reviewer analyzing a pull request. Identify bugs, security vulnerabilities, performance issues, and best practice violations.

# Pull Request
**Title**: ${pr.title}
**Description**: ${pr.body || 'No description'}
**Author**: ${pr.user?.login}

# Files Changed (${files.length})
${fileContext}

# Instructions
Focus on:
1. **Bugs**: Logic errors, null references, off-by-one, race conditions
2. **Security**: SQL injection, XSS, secrets in code, insecure auth
3. **Performance**: Inefficient algorithms, memory leaks, unnecessary loops
4. **Best Practices**: Error handling, naming, code duplication

Return ONLY a JSON array (no markdown, no explanation):
[
  {
    "severity": "high",
    "category": "security",
    "filename": "src/auth.ts",
    "line": 42,
    "message": "Clear issue description",
    "suggestion": "Specific fix"
  }
]

Only include "high" or "medium" severity. If no issues: []`;
  }

  private parseReviewResponse(response: string): ReviewFinding[] {
    try {
      let cleaned = response.trim();
      cleaned = cleaned.replace(/```json\n?/g, '');
      cleaned = cleaned.replace(/```\n?/g, '');
      cleaned = cleaned.trim();
      
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('No JSON array in response');
        return [];
      }
      
      const findings = JSON.parse(jsonMatch[0]);
      
      if (!Array.isArray(findings)) {
        return [];
      }
      
      const validFindings = findings.filter(f => {
        if (!f.severity || !f.category || !f.filename || !f.message || !f.suggestion) {
          return false;
        }
        return ['high', 'medium'].includes(f.severity);
      });
      
      return validFindings;
      
    } catch (error) {
      console.error('Failed to parse response:', error);
      return [];
    }
  }

  private async postReview(
    context: Context,
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
    findings: ReviewFinding[]
  ): Promise<void> {
    const severityEmoji: Record<string, string> = {
      high: '🔴',
      medium: '🟡',
      low: '🔵'
    };

    const categoryEmoji: Record<string, string> = {
      bug: '🐛',
      security: '🔒',
      performance: '⚡',
      style: '🎨',
      'best-practice': '✨'
    };

    let body = `## 🤖 AI Code Review (${this.llm.getModelName()})\n\n`;
    body += `Found ${findings.length} issue${findings.length > 1 ? 's' : ''}:\n\n`;

    const comments: any[] = [];

    for (const finding of findings) {
      const emoji = `${severityEmoji[finding.severity]} ${categoryEmoji[finding.category] || '📌'}`;
      
      if (finding.line) {
        comments.push({
          path: finding.filename,
          line: finding.line,
          body: `${emoji} **${finding.severity.toUpperCase()}** - ${finding.category}\n\n${finding.message}\n\n💡 **Suggestion:** ${finding.suggestion}`
        });
      }
      
      body += `### ${emoji} ${finding.filename}`;
      if (finding.line) body += ` (line ${finding.line})`;
      body += `\n**Issue:** ${finding.message}\n**Fix:** ${finding.suggestion}\n\n`;
    }

    try {
      await context.octokit.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        body,
        event: 'COMMENT',
        comments: comments.slice(0, 30)
      });
      
      console.log(`✅ Posted review with ${findings.length} findings`);
    } catch (error) {
      console.error('Error posting review:', error);
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body
      });
    }
  }
}