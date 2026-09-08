# AI Spend Control

A  dashboard for tracking your team's AI token spend (Anthropic + OpenAI) - no data leaves your machine.

## Requirements

- [Node.js](https://nodejs.org/) 22 or newer

## Setup

1. Clone this repo and install nothing - there are no dependencies to install.

   ```bash
   git clone https://github.com/michael-shiryakov/ai-token-spend.git
   cd ai-token-spend
   ```

2. Copy the example env file and add your API key(s):

   ```bash
   cp .env.example .env
   ```

   - **Anthropic**: create an Analytics API key (scope `read:analytics`) at [claude.ai/admin-settings/api-access](https://claude.ai/admin-settings/api-access). Requires Claude Enterprise.
   - **OpenAI**: create an Admin API key at [platform.openai.com/settings/organization/admin-keys](https://platform.openai.com/settings/organization/admin-keys).

   You only need to fill in the key(s) for the provider(s) you use.

3. Start the app:

   ```bash
   npm start
   ```

4. Open [http://localhost:4173](http://localhost:4173) in your browser.

## Demo mode (no API keys needed)

Want to try it out without connecting real accounts? Run:

```bash
npm run demo
```

Then open [http://localhost:4173](http://localhost:4173), and enter anything (e.g. `demo`) as the API key(s) on the setup screen. Every request is served from realistic mock data instead of calling Anthropic/OpenAI, so nothing real is read or charged. A "Demo — sample data" banner stays visible the whole time so it's never mistaken for a live dashboard.

## Useful commands

| Command | What it does |
|---|---|
| `npm start` | Runs the local server on port `4173` |
| `npm run demo` | Runs the dashboard in demo mode with mock data, no API keys required |
| `npm test` | Runs the test suite |
| `npm run reset-onboarding` | Clears your `.env` (backed up to `.env.bak`) and restarts you into the first-run setup flow |

## How it works

Everything lives in two files: `server.mjs` (a dependency-free Node HTTP server) and `index.html` (a single self-contained page — styles, fonts, and scripts all inlined, no build step). Your API keys stay in your local `.env` file and are only used to call the Anthropic/OpenAI APIs directly from your machine.
