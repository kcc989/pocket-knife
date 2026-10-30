import { type Runner, runnerOf } from "@osolmaz/switch";
import { loadCase, readCase } from "./case.ts";
import { DOC_EXTRACT, extractMachine, outcomeOf } from "./extract.ts";

/** The doc-extract domain. It has no flags of its own, and its definition is its texts, thresholds and limits. */
export function docExtractSetup(): Promise<Runner> {
	return Promise.resolve(
		runnerOf({
			...DOC_EXTRACT,
			caseId: async (folder) => (await readCase(folder)).id,
			load: async (folder) => extractMachine(await loadCase(folder)),
			outcome: outcomeOf,
		}),
	);
}
