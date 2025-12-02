export class OllamaProvider {
    host;
    model;
    name = "Ollama";
    constructor(host, model) {
        this.host = host;
        this.model = model;
    }
    async generateReview(prompt) {
        const response = await fetch(`${this.host}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: this.model,
                prompt: prompt,
                stream: false
            })
        });
        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.statusText}`);
        }
        const data = await response.json();
        return data.response;
    }
}
export class OpenAIProvider {
    apiKey;
    model;
    name = "OpenAI";
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model;
    }
    async generateReview(prompt) {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    {
                        role: "system",
                        content: "You are an expert code reviewer. Provide constructive, actionable feedback on code changes."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.3
            })
        });
        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices[0].message.content;
    }
}
export class AnthropicProvider {
    apiKey;
    model;
    name = "Anthropic";
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model;
    }
    async generateReview(prompt) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": this.apiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 4096,
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                system: "You are an expert code reviewer. Provide constructive, actionable feedback on code changes. Focus on bugs, security issues, performance problems, and code quality."
            })
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.statusText} - ${error}`);
        }
        const data = await response.json();
        return data.content[0].text;
    }
}
