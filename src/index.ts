// src/index.ts
import { Probot } from "probot";
import { LLMProvider, OllamaProvider, OpenAIProvider, AnthropicProvider } from "./providers";
import { ReviewEngine } from "./review-engine";

export default (app: Probot) => {
  const llmProvider = getLLMProvider();
  const reviewEngine = new ReviewEngine(llmProvider);

  console.log("🤖 PR Review Agent initialized");
  console.log(`📡 LLM Provider: ${process.env.LLM_PROVIDER || 'ollama'}`);

  // Listen for PR events
  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    const pr = context.payload.pull_request;
    const repo = context.payload.repository;

    console.log("\n========================================");
    console.log(`📝 PR Event: ${context.payload.action}`);
    console.log(`Repository: ${repo.owner.login}/${repo.name}`);
    console.log(`PR #${pr.number}: ${pr.title}`);
    console.log(`Author: ${pr.user.login}`);
    console.log("========================================\n");

    try {
      await reviewEngine.reviewPR(context, pr, repo);
    } catch (error: any) {
      console.error("❌ Error reviewing PR:", error);
      
      // Post error comment
      await context.octokit.issues.createComment({
        owner: repo.owner.login,
        repo: repo.name,
        issue_number: pr.number,
        body: `🤖 **AI Code Review Error**\n\n⚠️ Failed to review PR: ${error.message}\n\nPlease check the logs.`
      });
    }
  });

  // Health check endpoint
  app.on("ping", async (context) => {
    console.log("🏓 Ping received");
  });
};

function getLLMProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER || 'ollama';
  
  switch (provider) {
    case 'ollama':
      return new OllamaProvider(
        process.env.OLLAMA_HOST || 'http://localhost:11434',
        process.env.OLLAMA_MODEL || 'codellama'
      );
    case 'openai':
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required');
      return new OpenAIProvider(
        process.env.OPENAI_API_KEY,
        process.env.OPENAI_MODEL || 'gpt-4'
      );
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required');
      return new AnthropicProvider(
        process.env.ANTHROPIC_API_KEY,
        process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'
      );
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}