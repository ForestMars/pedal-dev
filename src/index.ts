// src/index.ts
import { Probot } from "probot";
import { ConfigLoader } from "./config-loader.js";
import { ReviewEngine } from "./review-engine.js";

export default (app: Probot) => {
  const configLoader = new ConfigLoader();
  
  try {
    configLoader.load();
  } catch (error: any) {
    console.error("🔴 Fatal error loading config:", error.message);
    process.exit(1);
  }

  console.log("🤖 PR Review Agent initialized");
  

  app.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async (context) => {
    const pr = context.payload.pull_request;
    const repo = context.payload.repository;

    console.log("\n========================================");
    console.log(`📝 PR Event: ${context.payload.action}`);
    console.log(`Repository: ${repo.owner.login}/${repo.name}`);
    console.log(`PR #${pr.number}: ${pr.title}`);
    console.log(`Author: ${pr.user.login}`);
    console.log("========================================\n");

    try {
      const llmProvider = configLoader.createProvider('pr-review');
      const reviewEngine = new ReviewEngine(llmProvider);
      
      await reviewEngine.reviewPR(context, pr, repo);
    } catch (error: any) {
      console.error("❌ Error reviewing PR:", error);
      
      await context.octokit.issues.createComment({
        owner: repo.owner.login,
        repo: repo.name,
        issue_number: pr.number,
        body: `🤖 **AI Code Review Error**\n\n⚠️ Failed to review PR: ${error.message}\n\nPlease check the logs.`
      });
    }
  });

  app.on("ping", async (context) => {
    console.log("🏓 Ping received");
  });
};