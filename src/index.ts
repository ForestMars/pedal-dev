// src/index.ts

import { Probot } from 'probot';
import { ConfigLoader } from './config/config-loader.js';
import { ReviewEngine } from './agents/review-engine.js';

// Global Startup Logic (Executes Once)
const CONFIG_PATH = process.env.CONFIG_PATH;

if (!CONFIG_PATH) {
    console.error("🔴 Fatal Error: CONFIG_PATH environment variable is not set. Cannot start.");
    process.exit(1); 
}

let configLoader: ConfigLoader;

try {
  console.log(`📂 Loading config from: ${CONFIG_PATH}`);
  configLoader = new ConfigLoader(CONFIG_PATH);
  
  const config = configLoader.config;
  
  const logProvider = config.llm.default_provider;
  const logModel = config.llm.default_model;
  
  console.log(`🤖 PR Review Agent initialized. Configured Model: **${logProvider} (${logModel})**`);
  console.log(`✅ ConfigLoader successfully initialized`);
  
} catch (e: any) {
  console.error(`🔴 Fatal Error: Could not load configuration: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}

// Deduplication
const processingPRs = new Set<string>();

// Probot Application Handler (Executes on Events
export default (app: Probot) => {
    console.log(`🎯 Probot app handler registered`);
    console.log(`🔔 Listening for: pull_request.opened, pull_request.reopened, pull_request.synchronize`);
    
    app.on(["pull_request.opened", "pull_request.reopened", "pull_request.synchronize"], async (context) => {
        console.log(`\n🚨 WEBHOOK RECEIVED - Event handler triggered!`);
        
        const pr = context.payload.pull_request;
        const repo = context.payload.repository;
        const prKey = `${repo.full_name}#${pr.number}`;

        console.log("\n========================================");
        console.log(`📝 PR Event: ${context.payload.action}`);
        console.log(`Repository: ${repo.owner.login}/${repo.name}`);
        console.log(`PR #${pr.number}: ${pr.title}`);
        console.log("========================================\n");

        // Check if already processing this PR
        if (processingPRs.has(prKey)) {
            console.log(`⏭️  Already processing ${prKey}, ignoring duplicate webhook (GitHub retry)`);
            return; // Respond immediately with 200 OK
        }

        // Mark as processing
        processingPRs.add(prKey);
        console.log(`✓ Webhook acknowledged for ${prKey}, starting background processing...`);

        // Process asynchronously - this allows the webhook handler to return immediately
        setImmediate(async () => {
            try {
                console.log(`\n⚙️ [ASYNC] Starting review for ${prKey}...`);
                console.log(`🔧 Getting LLM provider...`);
                const llmProvider = configLoader.getLLMProvider(); 
                console.log(`✅ LLM provider created: ${llmProvider.constructor.name}`);
                
                llmProvider.maxOutputTokens = 9999;
                
                console.log(`🔧 Creating ReviewEngine...`);
                const reviewEngine = new ReviewEngine(llmProvider, configLoader); 
                console.log(`✅ ReviewEngine created`);
                
                console.log(`🚀 Starting PR review...`);
                await reviewEngine.reviewPR(context, pr, repo);
                console.log(`✅ [ASYNC] PR review completed for ${prKey}`);
                
            } catch (error: any) {
                console.error(`❌ [ASYNC] Error reviewing ${prKey}:`, error.message);
                console.error(error.stack); 

                try {
                    await context.octokit.issues.createComment({
                        owner: repo.owner.login,
                        repo: repo.name,
                        issue_number: pr.number,
                        body: `🤖 **AI Code Review Error**\n\n⚠️ Failed to review PR: **${error.message.substring(0, 500)}**\n\nI encountered an internal error. Please check the application logs for details.`
                    });
                } catch (commentError: any) {
                    console.error(`❌ Failed to post error comment:`, commentError.message);
                }
            } finally {
                // Remove from processing set
                processingPRs.delete(prKey);
                console.log(`🧹 Cleaned up processing lock for ${prKey}`);
            }
        });

        // Handler returns immediately here - GitHub gets 200 OK within milliseconds
    });
    
    // Add a catch-all to see if webhook is even reaching the app
    app.onAny(async (context) => {
        console.log(`📨 Received webhook: ${context.name}.${context.payload.action || 'no-action'}`);
    });
};
