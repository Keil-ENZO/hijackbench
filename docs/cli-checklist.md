# CLI checklist

What every command of hijackbench must meet. A new command passes it before its PR. `apps/cli/src/cli.test.ts` checks every point it can, on every command.

## Help

- [ ] `--help` describes the command, its arguments and its options.
- [ ] The help ends with at least one example, under `Examples:` or `Example:`, starting with `$ hijackbench`.
- [ ] A command that works over SSH shows the `ssh` line, with `-t` when it needs a terminal.

## Output

- [ ] A command that returns data takes `--json`. The JSON goes to stdout alone: messages and errors go to stderr.
- [ ] Colors come from `picocolors` only. It turns them off outside a terminal and with `NO_COLOR`.
- [ ] A progress bar or a prompt only in a terminal. In a pipe, plain lines.

## Exit codes

| Code | When |
|---|---|
| 0 | Success, warnings included |
| 1 | Failure: a check failed, a campaign or file is missing, an error |
| 2 | Usage error, set by Commander: unknown command or option, missing argument |
| 130 | A campaign stopped by Ctrl+C or `stop` |

- [ ] The code comes from `EXIT` in `apps/cli/src/index.ts`, never a bare number.
- [ ] A command-specific meaning is written in its help, as `doctor` and `status` do.

## Errors

- [ ] An error the user can fix says how, in one or two lines.
- [ ] No stack trace. `reportError` catches everything left. An error type the user can fix goes in `EXPECTED`, so it shows without the bug hint.
- [ ] `HIJACKBENCH_DEBUG=1` shows the stack.

## Commands

| Command | Example | `--json` | Specific exit code |
|---|---|---|---|
| `doctor` | yes | yes | 1 when a check fails |
| `models` | yes | yes | 1 when Ollama is unreachable |
| `run` | yes | no, a stream of runs | 130 when stopped |
| `resume` | yes | no, a stream of runs | 1 when the campaign is missing, 130 when stopped |
| `stop` | yes | no, writes a flag | |
| `status` | yes | yes | 1 when the campaign is missing |
| `judge` | yes | yes | 1 when the campaign is missing |
| `annotate` | yes | no, interactive | 1 without a terminal |
| `report` | yes | `--csv` | 1 when a campaign is missing or not judged |
