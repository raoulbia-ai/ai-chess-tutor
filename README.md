# AI Chess Tutor

A locally runnable chess tutor using Node.js, chess.js, Stockfish, and a server-side model provider. This repository shares source code for people to inspect and fork; it does not publish a running service or include the author's credentials and game records.

## Run your own copy

Requires Node.js 22 or newer.

```sh
npm ci
cp .env.example .env
npm run check
npm start
```

Supply your own OPENAI_API_KEY_CHESS_TUTOR in .env, then open http://127.0.0.1:3000. Compatible provider settings are documented in .env.example. LLM_MODEL writes the lessons; the optional LLM_AUDIT_MODEL fact-checks them before they are shown and defaults to LLM_MODEL. For OpenAI reasoning models (GPT-5 and later), LLM_REASONING_EFFORT sets how much the writer thinks; the fact-check uses the same value when it uses the same model. Set LLM_AUDIT_BASE_URL to run the fact-check on a separate OpenAI-compatible server, such as a local Ollama, while lessons use OpenAI. Turn commentary after each move is built from Stockfish and chess.js without a model call; set TUTOR_TURN_COMMENTARY=model for the earlier model-written version. Model requests use your configured provider and account. The server writes game events and questions to game-history.txt; this file stays local.

## Public and private files

Share package.json, package-lock.json, server.mjs, lib/, public/, the required skills/chess-tutoring/SKILL.md, .env.example, .gitignore, this README, and .github/workflows/check.yml. The teaching guide is loaded by the application at startup; omitting it without changing the app breaks startup.

Keep .env files, credentials, node_modules, game-history.txt, chess-tutor-research.md, logs, and machine-specific tooling private. .gitignore excludes these files. Ignore rules do not remove files already committed: inspect the staged diff before every commit and inspect existing history before first publication.

## Development process

Use one canonical GitHub repository and a local working copy. Do not maintain independently edited public and private versions of the application. Keep personal settings in ignored configuration and reusable behavior in source code.

1. Before starting work, pull the latest main with git pull --ff-only from a clean working tree.
2. Create a feature branch for one change. Keep secrets and local records out of commits.
3. Run npm run check. It checks JavaScript syntax; no automated test suite is configured.
4. Run npm start and manually check starting a game, a legal move and Black reply, hints, undo, and history saving. Tutor checks require your own model credentials.
5. Review git diff and the staged file list. Push the feature branch and open a pull request when ready to share it.
6. Merge after review and passing CI, then update the local main before starting the next change.

These are contributor instructions, not authorization for an assistant to commit, push, switch branches, or publish without the owner's approval.

Before the first publication, inspect the destination repository and compare any existing Spark/exported code. Preserve existing history; do not force push or overwrite an existing app. For the maintainer, deploy reviewed main commits to the DGX Spark service after local verification. Keep runtime configuration and history on the host.

Treat any hosted app as a separate runtime, not a second source of truth. Do not retire a working local copy until all unique changes are preserved and the replacement editing environment has been verified. Publishing this repository does not deploy an app.

## Licensing

Project source, tutor prompts, and the teaching guide are licensed under the [MIT License](LICENSE). Third-party dependencies retain their own licenses: chess.js is BSD-2-Clause and Stockfish is GPL-3.0, as recorded in package-lock.json. The project MIT license does not relicense those dependencies.
