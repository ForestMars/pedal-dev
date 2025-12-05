// src/config-loader.ts
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import * as yaml from 'yaml';
import { LLMProvider, OllamaProvider, AnthropicProvider, OpenAIProvider, OpenRouterProvider, GeminiProvider } from './providers';

export interface AgentConfig {
  version: string;
  llm: LLMConfig;
  agents: Record<string, Agent>;
  validation_rules?: Record<string, any>;
  labels?: Record<string, string[]>;
  settings?: Record<string, any>;
}

export interface LLMConfig {
  default_provider: string;
  default_model: string;
  providers: Record<string, ProviderConfig>;
}

export interface ProviderConfig {
  host?: string;
  api_key_env?: string;
  base_url?: string;
  models: string[];
}

export interface Agent {
  model: string;
  context?: string;
  triggers: Trigger[];
  actions: (string | Record<string, string>)[];
}

export interface Trigger {
  event: string;
  conditions?: Record<string, any>;
}

export class ConfigLoader {
  private config: AgentConfig | null = null;
  private configDirRoot: string;
  private configPath: string; 
  private configFile: string = 'agent-workflow.yml';
  
  constructor(private baseDir: string = 'config') {
    this.configDirRoot = path.resolve(process.cwd(), baseDir);
    this.configPath = path.join(this.configDirRoot, this.configFile);
    this.loadEnvironmentVariables();
    this.verifyPromptFiles();
  }

  /**
   * @param agentName The name of the agent.
   * @returns The full file system path to the prompt file.
   */
  private calculatePromptPath(agentName: string): string {
    return path.join(this.configDirRoot, 'prompts', `${agentName}.md`);
  }

  /**
   * @param agentName The name of the agent (e.g., 'pr-review').
   * @returns The full file system path to the expected prompt file.
   */
  public getPromptFilePath(agentName: string): string {
    return this.calculatePromptPath(agentName);
  }
  // ---------------------------------------------

  private verifyPromptFiles(): void {
    const config = this.load();
    const missingPrompts: string[] = [];
    
    for (const [agentName, agent] of Object.entries(config.agents)) {
      if (agent.context) {
        console.log(`⚠️ Agent '${agentName}' using inline context from config`);
        continue;
      }

      console.log('👋👋👋 dir root is', this.configDirRoot );
      // REFACTORED: Use the new private method
      const promptPath = this.calculatePromptPath(agentName);
      console.log('👋👋👋 Prompt Path is', promptPath );
      if (fs.existsSync(promptPath)) {
        console.log(`✅ Agent '${agentName}' prompt file found: ${promptPath}`);
      } else {
        console.warn(`⚠️  Agent '${agentName}' prompt file missing: ${promptPath}`);
        missingPrompts.push(agentName);
      }
    }
    if (missingPrompts.length > 0) {
      console.warn(`⚠️  ${missingPrompts.length} agent(s) missing prompt files. Will use fallback prompts.`);
    }
  }

  private loadEnvironmentVariables(): void {
    const envAgentPath = path.join(this.configDirRoot, '.env.agent'); 
    try {
        dotenv.config({ path: envAgentPath, override: true });
        console.log(`✅ Loaded agent configuration from ${envAgentPath}`);
    } catch (e) {
        console.warn(`Could not load ${envAgentPath}. Proceeding without it.`);
    }
  }

  load(): AgentConfig {
    console.log(`[DEBUG:Config] 5. Attempting to load YAML from: ${this.configPath}`);
    if (!fs.existsSync(this.configPath)) {
      throw new Error(`Configuration file not found at: ${this.configPath}`);
    }

    if (this.config) {
      return this.config;
    }
    try {
      const fileContents = fs.readFileSync(this.configPath, 'utf8');
      this.config = yaml.parse(fileContents);
      console.log(`[DEBUG:Config] 6. YAML file successfully parsed.`);

      const ignorePatterns = this.getIgnorePatterns();
      console.log(`[DEBUG:Config] 7. Ignore patterns loaded. Count: ${ignorePatterns.length}`);
      
      if (!this.config) {
        throw new Error('Failed to parse config file');
      }

      console.log(`✅ Loaded config v${this.config.version}`);
      console.log(`📦 Agents: ${Object.keys(this.config.agents).join(', ')}`);
      
      return this.config;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Config file not found: ${this.configPath}`);
      }
      throw new Error(`Failed to load config: ${error.message}`);
    }
  }

  getAgent(agentName: string): Agent | null {
    const config = this.load();
    return config.agents[agentName] || null;
  }

  public getAgentContext(agentName: string): string {
    console.log(`[DEBUG:getAgentContext] Called for agent: ${agentName}`);
    
    const agentContext = this.getAgent(agentName)?.context;
    if (agentContext) {
      console.log(`[DEBUG:getAgentContext] Using inline context from config`);
      return agentContext;
    }

    const promptPath = this.calculatePromptPath(agentName);
    console.log(`[DEBUG:getAgentContext] Attempting to load from: ${promptPath}`);
    console.log(`[DEBUG:getAgentContext] File exists: ${fs.existsSync(promptPath)}`);
    
    try {
      const content = fs.readFileSync(promptPath, 'utf8');
      console.log(`[DEBUG:getAgentContext] Successfully loaded ${content.length} chars`);
      return content;
    } catch (e: any) {
      console.error(`[DEBUG:getAgentContext] FAILED to load: ${e.message}`);
      console.error(`[DEBUG:getAgentContext] Error code: ${e.code}`);
      console.warn(`[ConfigError] Using default prompt - Could not load context from ${promptPath}: ${e.message}`);
      return `# PR Review Instructions\nFocus on the following areas:\n1. Security\n2. Bugs\n3. Performance\n\nReturn ONLY a JSON array.\n[FILE_CONTEXT]`;
    }
  }

  private checkModelAvailability(providerName: string, modelName: string, providerConfig: ProviderConfig): boolean {
    console.log(`[DEBUG] Checking model: "${modelName}"`);
    console.log(`[DEBUG] Available models:`, providerConfig.models);
    console.log(`[DEBUG] Includes check:`, providerConfig.models.includes(modelName));
  
    if (providerConfig.models.includes(modelName)) {
        return true;
    }
    
    return false;
  }

  createProvider(agentName: string): LLMProvider {
    const config = this.load();
    const agent = this.getAgent(agentName);
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    const parts = agent.model.split(':');
    const hasProviderPrefix = parts.length > 1;

    const providerName = hasProviderPrefix ? parts[0] : config.llm.default_provider;
    const requestedModelName = hasProviderPrefix ? parts.slice(1).join(':') : agent.model; 

    const providerConfig = config.llm.providers[providerName];
    if (!providerConfig) {
      throw new Error(`Provider not found: ${providerName}`);
    }
    
    let finalModelName = requestedModelName;
    const defaultModelName = config.llm.default_model;

    if (!this.checkModelAvailability(providerName, requestedModelName, providerConfig)) {
        
        
        console.warn(`model [${requestedModelName}] not found for agent [${agentName}]. Falling back to default model [${defaultModelName}].`);
        
        
        finalModelName = defaultModelName;
        
        
        if (!this.checkModelAvailability(providerName, finalModelName, providerConfig)) {
            
            console.warn(`Warning: Fallback model [${finalModelName}] is also not listed as available for provider [${providerName}].`);
        }
    }

    const providerInstance = this.instantiateProvider(providerName, finalModelName, providerConfig);
    
    return providerInstance;
  }


  private instantiateProvider(
    providerName: string, 
    modelName: string, 
    providerConfig: ProviderConfig
  ): LLMProvider {
    switch (providerName) {
      case 'ollama':
        return new OllamaProvider(
          providerConfig.host || 'http://localhost:11434',
          modelName
        );

      case 'anthropic':
        const anthropicKey = process.env[providerConfig.api_key_env || 'ANTHROPIC_API_KEY'];
        if (!anthropicKey) {
          throw new Error(`${providerConfig.api_key_env} not set`);
        }
        return new AnthropicProvider(anthropicKey, modelName);

      case 'openai':
        const openaiKey = process.env[providerConfig.api_key_env || 'OPENAI_API_KEY'];
        if (!openaiKey) {
          throw new Error(`${providerConfig.api_key_env} not set`);
        }
        return new OpenAIProvider(openaiKey, modelName);

      case 'openrouter':
        const openrouterKey = process.env[providerConfig.api_key_env || 'OPENROUTER_API_KEY'];
        if (!openrouterKey) {
          throw new Error(`${providerConfig.api_key_env} not set`);
        }
        return new OpenRouterProvider(
          openrouterKey,
          modelName,
          providerConfig.base_url
        );

      case 'google':
        const googleKey = process.env[providerConfig.api_key_env || 'GOOGLE_API_KEY'];
        if (!googleKey) {
          throw new Error(`${providerConfig.api_key_env} not set`);
        }
        return new GeminiProvider(googleKey, modelName);

      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }

  /**
   * Get agents that should trigger on a specific event
   */
  getAgentsForEvent(eventName: string, labels?: string[]): string[] {
    const config = this.load();
    const matchingAgents: string[] = [];

    for (const [agentName, agent] of Object.entries(config.agents)) {
      for (const trigger of agent.triggers) {
        if (trigger.event === eventName) {
          // Check label conditions if present
          if (trigger.conditions && labels) {
            if (this.matchesConditions(trigger.conditions, labels)) {
              matchingAgents.push(agentName);
            }
          } else if (!trigger.conditions) {
            matchingAgents.push(agentName);
          }
        }
      }
    }

    return matchingAgents;
  }


  private matchesConditions(conditions: Record<string, any>, labels: string[]): boolean {
    if (conditions.labels_all) {
      const required = conditions.labels_all as string[];
      if (!required.every(label => labels.includes(label))) {
        return false;
      }
    }

    if (conditions.labels_any) {
      const anyOf = conditions.labels_any as string[];
      if (!anyOf.some(label => labels.includes(label))) {
        return false;
      }
    }

    if (conditions.label_added) {
      if (!labels.includes(conditions.label_added)) {
        return false;
      }
    }

    return true;
  }

  /**
   * @returns An array of RegExp objects to be ignored
   */
  public getIgnorePatterns(): RegExp[] {
    const filePath = path.join(this.configDirRoot, 'ignore-files.txt');
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      const patterns = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .map(pattern => new RegExp(pattern));
        
      console.log(`✅ Loaded ${patterns.length} file ignore patterns from ${filePath}`);
  
      return patterns;
    } catch (e: any) {
      console.warn(`Could not load ignore patterns from ${filePath}: ${e.message}. Using an empty list.`);
      
      // FIX: Return an empty array as the fallback. 
      return []; 
    }
  }

  getCurrentSprint(): number {
    const config = this.load();
    if (config.settings?.current_sprint) {
      return config.settings.current_sprint;
    }
    
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const diff = now.getTime() - start.getTime();
    const oneWeek = 1000 * 60 * 60 * 24 * 7;
    return Math.floor(diff / oneWeek) + 1;
  }
}