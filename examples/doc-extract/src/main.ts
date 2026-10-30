#!/usr/bin/env -S node --conditions=switch-source
/** The doc-extract harness's command line: switch's run and replay with the doc-extract domain. */
import { commandLine } from "@osolmaz/switch/cli";
import { docExtractSetup } from "./setup.ts";

await commandLine({ "doc-extract": { setup: () => docExtractSetup() } })
	.name("doc-extract")
	.parseAsync();
