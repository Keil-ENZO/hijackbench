# hijackbench

A local test bench that measures how well tool-using AI agents resist indirect prompt injection.

The agent gets a normal task in a simulated environment: a mailbox and a file system. Some of the data it reads carries an attack. A deterministic judge reads the tool trace and decides whether the agent leaked a secret, ran a destructive action, or dropped its task.

**Status:** early setup. Nothing runs yet.

## Goals for v0

- Open models served locally with Ollama, no paid API.
- A judge with no LLM in it: same trace, same verdict.
- Honest statistics: Wilson intervals, and a published judge error rate.
- Task utility measured alongside security.

## Run with Docker

hijackbench runs next to an [Ollama](https://ollama.com) already running on the same machine. No Node install needed:

```bash
docker compose run --rm hijackbench --help
```

The container uses host networking to reach Ollama on `127.0.0.1:11434`. Set `OLLAMA_URL` to point elsewhere. Results live in the `hijackbench-data` volume and survive the container. Campaign files are read from `./campaigns`.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Requires Node 24 and pnpm.

## Responsible use

hijackbench attacks agents running in its own simulated environment. Do not point it at a system you do not own or are not authorized to test.

## License

MIT
