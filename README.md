# Moss AI Token Cost Tracker

A  dashboard for tracking your team's AI token spend (Anthropic + OpenAI) - no data leaves your machine.

TODO: add a video/gif guide of how to install this project

## Requirements

- [Node.js](https://nodejs.org/) 22 or newer

1. Install nvm (if you don't have it):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
Then restart your terminal (or run source ~/.zshrc).

2. Install the specific Node version:
nvm install 24.14.1

3. Use it:
nvm use 24.14.1

4. Set a default version so nvm loads it automatically every time
nvm alias default 24.14.1

## Setup

1. Clone this repo and install nothing - there are no dependencies to install.

   ```bash
   git clone https://github.com/michael-shiryakov/ai-token-spend.git
   cd ai-token-spend
   ```

2. Start the app:

   ```bash
   npm start
   ```

3. Open [http://localhost:4173](http://localhost:4173) in your browser.

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

## License

[MIT](./LICENSE) © Moss
