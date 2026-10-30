import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VALUE_KINDS } from "@osolmaz/switch";
import { z } from "zod";
import { checkSchema } from "./checks.ts";

const json = z.json();

/** One value to find: its kind, what it is, and Clairic's own settings for it, such as a unit. */
export const fieldSchema = z
	.object({
		kind: z.enum(VALUE_KINDS),
		instructions: z.string().min(1),
		field: z.record(z.string(), json).optional(),
	})
	.strict();
export type FieldSpec = z.infer<typeof fieldSchema>;

/** A case: its id, its document's file in the case folder, and the values to find in it, by name. */
export const caseSchema = z
	.object({
		id: z.string().min(1),
		document: z.string().min(1).default("document.md"),
		/** A read takes the picked part and the parts after it until it holds this many characters; 0 reads one part. */
		readChars: z.number().int().nonnegative().default(0),
		/** After the model stops, read every part read at once, and take those answers as the values. */
		finalRead: z.boolean().default(false),
		/**
		 * "navigate" picks one part at a time; "select" asks of every part at once, then reads the likeliest; "whole" reads
		 * the whole document at once.
		 */
		strategy: z.enum(["navigate", "select", "whole"]).default("navigate"),
		/** The most characters that the select strategy reads. */
		selectChars: z.number().int().positive().default(60_000),
		/** Sum checks: values that add up are found, however sure the extractor was of each. */
		checks: z.array(checkSchema).default([]),
		fields: z.record(z.string(), fieldSchema).refine((fields) => Object.keys(fields).length > 0, "no fields"),
	})
	.strict();
export type ExtractCase = z.infer<typeof caseSchema>;

/** A case with its document's text. */
export interface LoadedCase extends ExtractCase {
	readonly text: string;
}

/** Reads and checks a case folder's `case.json`. */
export async function readCase(folder: string): Promise<ExtractCase> {
	return caseSchema.parse(JSON.parse(await readFile(join(folder, "case.json"), "utf8")));
}

/** Reads a case folder: its `case.json` and its document. */
export async function loadCase(folder: string): Promise<LoadedCase> {
	const found = await readCase(folder);
	return { ...found, text: await readFile(join(folder, found.document), "utf8") };
}

/** The answer key of a case folder: each value by name, in `expected.json`. */
export const expectedSchema = z.object({ values: z.record(z.string(), json) }).strict();
export type Expected = z.infer<typeof expectedSchema>;

export async function loadExpected(folder: string): Promise<Expected> {
	return expectedSchema.parse(JSON.parse(await readFile(join(folder, "expected.json"), "utf8")));
}
