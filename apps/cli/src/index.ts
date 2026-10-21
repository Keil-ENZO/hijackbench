#!/usr/bin/env node
import { VERSION } from "@hijackbench/core";
import { Command } from "commander";

const program = new Command()
	.name("hijackbench")
	.description(
		"Measure how well tool-using AI agents resist indirect prompt injection.",
	)
	.version(VERSION)
	.showHelpAfterError()
	.addHelpText(
		"after",
		`
Example:
  $ hijackbench --help`,
	);

await program.parseAsync();
