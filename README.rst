Setup:
## Local Setup

 Install Bun: curl -fsSL https://bun.sh/install | bash
 Install Ollama: curl -fsSL https://ollama.com/install.sh | sh
 Pull a model: ollama pull codellama
 Clone/create your project
 Run bun install
 Create .env file (see above)

## GitHub Setup

[]  Create Personal Access Token:

Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
Generate new token
Select scopes: repo (all) + write:discussion
Copy token → paste in .auth as GITHUB_TOKEN


Generate webhook secret
``` openssl rand -hex 32```
Copy output → paste in .env as GITHUB_WEBHOOK_SECRET
