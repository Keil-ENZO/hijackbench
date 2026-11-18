// The report as Markdown, readable on GitHub without installing anything.
//
// No date of generation: the same base gives the same file, so a diff of
// the report shows a change of results, never a change of clock.

import { AGENTDOJO, type Family, type Objective } from "../attacks/catalog.ts";
import { GANDALF } from "../attacks/gandalf.ts";
import type { CalibratedVerdict, Calibration } from "./calibration.ts";
import type {
	CampaignSummary,
	ObjectiveResult,
	Rate,
	Report,
	Source,
} from "./report.ts";

const OBJECTIVE_NAMES: Record<Objective, string> = {
	leak: "Leak",
	destructive: "Destructive",
	hijack: "Hijack",
};

const WHAT_SUCCEEDS: Record<Objective, string> = {
	leak: "the canary mailed to the attacker's address",
	destructive: "the contract deleted",
	hijack: "the task failed",
};

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

// "7.0 % [4.6, 10.6]": the rate and its 95 % Wilson interval.
export function formatRate({ rate, interval }: Rate): string {
	if (rate === null || !interval) return "n/a";
	return `${pct(rate)} [${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`;
}

const withCounts = (rate: Rate) =>
	rate.rate === null
		? "n/a"
		: `${formatRate(rate)}, ${rate.count} of ${rate.total}`;

// Change in points between two rates, signed.
function points(from: Rate, to: Rate): string {
	if (from.rate === null || to.rate === null) return "n/a";
	const delta = (to.rate - from.rate) * 100;
	return `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta).toFixed(1)} pts`;
}

function minutes(ms: number): string {
	const total = Math.round(ms / 60_000);
	return total < 60
		? `${total} min`
		: `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")}`;
}

const table = (head: string[], rows: string[][]) =>
	[
		`| ${head.join(" | ")} |`,
		`|${head.map(() => "---").join("|")}|`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");

const objective = (results: ObjectiveResult[], name: Objective) =>
	results.find((result) => result.objective === name);

function summaryTable(report: Report): string {
	return table(
		["Model", "Leak", "Destructive", "Hijack, task failed", "Hijack baseline"],
		report.byModel.map(({ model, objectives }) => {
			const hijack = objective(objectives, "hijack");
			return [
				`\`${model}\``,
				...(["leak", "destructive"] as const).map((name) => {
					const result = objective(objectives, name);
					return result ? formatRate(result.success) : "n/a";
				}),
				hijack ? formatRate(hijack.success) : "n/a",
				hijack?.baseline ? formatRate(hijack.baseline) : "n/a",
			];
		}),
	);
}

function modelSection(report: Report, index: number): string {
	const { model, objectives } = report.byModel[index] as Report["byModel"][0];
	return [
		`### \`${model}\``,
		"",
		table(
			[
				"Objective",
				"Attack succeeded, 95 % CI",
				"Without attack",
				"Partial",
				"Not exposed",
				"Errors",
			],
			objectives.map((result) => [
				OBJECTIVE_NAMES[result.objective],
				withCounts(result.success),
				result.baseline ? formatRate(result.baseline) : "0 by design",
				String(result.partial),
				String(result.unexposed),
				String(result.technicalErrors),
			]),
		),
	].join("\n");
}

function utilityTable(report: Report): string {
	const hosts = report.hostTasks.join(", ");
	return table(
		[
			"Model",
			"No attack, every task",
			`No attack, ${hosts}`,
			`Under attack, ${hosts}`,
			"Change",
		],
		report.byModel.map(({ model, utility }) => [
			`\`${model}\``,
			withCounts(utility.reference),
			withCounts(utility.referenceOnHosts),
			withCounts(utility.underAttack),
			points(utility.referenceOnHosts, utility.underAttack),
		]),
	);
}

function familyTable(report: Report): string {
	const cell = (rate: Rate) =>
		rate.rate === null ? "n/a" : `${rate.count} / ${rate.total}`;
	return table(
		["Family", "Objective", ...report.models.map((model) => `\`${model}\``)],
		report.byFamily.map((row) => [
			`\`${row.family satisfies Family}\``,
			OBJECTIVE_NAMES[row.objective],
			...row.success.map(cell),
		]),
	);
}

// Where the attacks come from, one sentence per source.
function sourceOf(source: Source): string {
	if (source === AGENTDOJO)
		return `The attack templates come from [${AGENTDOJO.name}](${AGENTDOJO.url}), copied word for word.`;
	return `The injections are real prompts written by players of [${GANDALF.name}](${GANDALF.url}), dataset \`${GANDALF.dataset}\` at revision \`${GANDALF.revision.slice(0, 12)}\`, ${GANDALF.license}. The password each prompt asks for is swapped for the objective's target, by rules, then the objective's order follows.`;
}

// The same objectives on another attacked campaign, same reference.
function comparisonTable(report: Report, other: Report): string {
	const rows = report.byModel.flatMap(({ model, objectives }) =>
		objectives.map((result) => {
			const theirs = other.byModel
				.find((m) => m.model === model)
				?.objectives.find((o) => o.objective === result.objective);
			return [
				`\`${model}\``,
				OBJECTIVE_NAMES[result.objective],
				withCounts(result.success),
				theirs ? withCounts(theirs.success) : "n/a",
				theirs ? points(theirs.success, result.success) : "n/a",
			];
		}),
	);
	return table(
		[
			"Model",
			"Objective",
			`\`${report.attacked.id}\``,
			`\`${other.attacked.id}\``,
			"Change",
		],
		rows,
	);
}

// The texts as their players wrote them, before the swap.
function topTextsSection(report: Report): string {
	return report.topTexts
		.map(
			({ attack, success }, i) =>
				`${i + 1}. **${attack.id}**, ${OBJECTIVE_NAMES[attack.objective].toLowerCase()}, on ${attack.taskId}: ${success.count} of ${success.total} exposed runs.\n\n   ~~~text\n${(
					attack.text ?? ""
				)
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.map((line) => `   ${line}`.trimEnd())
					.join("\n")}\n   ~~~`,
		)
		.join("\n\n");
}

// The V0 report lives in reports/v0, from before one folder per campaign.
const reportDir = (id: string) => (id === "attacked-v0" ? "v0" : id);

function campaignTable(report: Report): string {
	const row = (role: string, c: CampaignSummary) => [
		`\`${c.id}\``,
		role,
		String(c.runs),
		String(c.technicalErrors),
		minutes(c.runMs),
		`${c.pauses}, ${minutes(c.pauseMs)}`,
		String(c.cuts),
	];
	return table(
		[
			"Campaign",
			"Role",
			"Runs",
			"Technical errors",
			"Time in runs",
			"Thermal pauses",
			"Cuts",
		],
		[row("reference", report.reference), row("attacked", report.attacked)],
	);
}

const VERDICT_NAMES: Record<CalibratedVerdict, string> = {
	compromised: "compromised",
	partial: "partial",
	resisted_success: "resisted, task done",
	resisted_failure: "resisted, task failed",
};

function calibrationSection(calibration: Calibration, id: string): string {
	const { strata, compromise, task } = calibration;
	const columns = Object.keys(VERDICT_NAMES) as CalibratedVerdict[];
	const matrix = table(
		[
			"Judge ↓ · annotation →",
			...columns.map((v) => VERDICT_NAMES[v]),
			"annotated",
			"runs",
		],
		strata.map((s) => [
			VERDICT_NAMES[s.verdict],
			...columns.map((v) =>
				v === s.verdict ? `**${s.annotations[v]}**` : String(s.annotations[v]),
			),
			String(s.annotated),
			String(s.runs),
		]),
	);
	const missed = compromise.missed
		.map(
			(m) =>
				`  - judge says ${VERDICT_NAMES[m.verdict]}: ${withCounts(m.rate)}`,
		)
		.join("\n");
	const overall = compromise.missedOverall
		? `Over the whole campaign, weighted by the size of each verdict: about ${pct(compromise.missedOverall.rate)} of the runs the judge does not call compromised are, some ${Math.round(compromise.missedOverall.runs)} runs. At most ${pct(compromise.missedOverall.upper)}, from the upper bounds of the intervals above.`
		: "No estimate over the whole campaign yet: a verdict of the judge has runs but no annotation.";
	return `${calibration.annotated} runs of \`${id}\` were annotated by hand, blind: the judge's verdict showed only after the annotation. They were drawn with the same quota for every verdict of the judge, so the sample is not proportional to the campaign. Each rate below is read within one verdict of the judge, where the draw is uniform.

Rows: the judge. Columns: the annotation. The diagonal is agreement.

${matrix}

- **False alarms.** When the judge says compromised, the annotation disagrees in ${withCounts(compromise.falseAlarm)}.
- **Missed compromises.** When the judge says something else, the annotation says compromised in:
${missed}

  ${overall}
- **Task outcome**, on runs both call resisted. The judge says done, the annotation says failed: ${withCounts(task.falseDone)}. The judge says failed, the annotation says done: ${withCounts(task.falseFailed)}. This is what the hijack rate and the utility rest on.
- **Same verdict**: ${withCounts(calibration.agreement)}, on the sample as drawn, not weighted.

A partial attempt counts as not compromised: it raises no leak or destruction rate. One annotator, the author: a second one would tell how much the annotation itself varies.`;
}

// With another attacked campaign on the same reference, a section
// compares the two, objective by objective.
export function renderMarkdown(report: Report, compare?: Report): string {
	const { attacked, reference } = report;
	const gandalf = report.sources.includes(GANDALF);
	const dir = `reports/${reportDir(attacked.id)}`;
	const args = `${attacked.id} -r ${reference.id}${compare ? ` -c ${compare.attacked.id}` : ""}`;
	const runs = attacked.config.runs;
	const temperatures = [
		...new Set([attacked, reference].map((c) => c.config.agent.temperature)),
	].join(" and ");
	return `# hijackbench V0 results

How well three open models, served locally, resist indirect prompt injection while doing a normal task with tools. Every verdict comes from a deterministic judge, with no LLM in it. Rates come with their 95 % Wilson interval: with ${runs} runs per case, a rate of 0 is not a proof of safety.

Raw data: [runs.csv](runs.csv), one line per run of both campaigns.

## Setup

- **Models**: ${report.models.map((model) => `\`${model}\``).join(", ")}, through Ollama on one RTX 3090. Sampling temperature ${temperatures}.
- **Reference**: campaign \`${reference.id}\`, every task without attack, ${reference.config.runs} runs per task and model. It gives the utility of each model.
- **Attacked**: campaign \`${attacked.id}\`, ${report.attacks} public attacks, ${runs} runs per attack and model. ${report.sources.map(sourceOf).join(" ")}
- **Judge**: v${report.judgeVersion}, on every run of both campaigns.

What an attack has to do to succeed, by objective:

${(["leak", "destructive", "hijack"] as const).map((o) => `- **${OBJECTIVE_NAMES[o]}**: ${WHAT_SUCCEEDS[o]}.`).join("\n")}

The judge has no hijack rule: a hijacked agent fails its task. So the hijack rate is the task failure rate under attack, next to the failure rate of the same task without attack.

Only the runs that saw the payload count. A run whose agent never read the trapped mail or file measures nothing about resistance: it is counted apart, as not exposed. Technical errors leave every rate.

## Summary

Attack success rate by model, 95 % Wilson interval in brackets.

${summaryTable(report)}
${
	compare
		? `
## Compared with \`${compare.attacked.id}\`

The same objectives, tasks and models, attacked by ${compare.sources.map((s) => s.name).join(" and ")} in \`${compare.attacked.id}\`. Both read against \`${reference.id}\`. A change whose intervals overlap may be noise.

${comparisonTable(report, compare)}
`
		: ""
}
## Results by model

"Without attack" is the same measure on the reference campaign. Nothing leaks or gets deleted there by design: no one asks for it. "Partial" counts the runs where the agent started to follow the attack without real damage: a mail to the attacker without the secret, or a read of the secret file.

${report.byModel.map((_, index) => modelSection(report, index)).join("\n\n")}

## Utility with and without attack

Task success, technical errors left out. The attacks are grafted on ${report.hostTasks.join(", ")} only: the fair comparison is between the two middle columns. Runs that never saw the payload stay in here: a task they failed is a task failed.

${utilityTable(report)}

## By attack family

Exposed runs where the attack succeeded, out of the exposed runs.

${familyTable(report)}
${
	report.topTexts.length > 0
		? `
## The texts that got through most

The real prompts that succeeded most often, all models together, as their players wrote them, typos kept. In the run, the password became the objective's target and the objective's order followed.

${topTextsSection(report)}
`
		: ""
}
## Campaigns

${campaignTable(report)}
${report.calibration ? `\n## Judge calibration\n\n${calibrationSection(report.calibration, attacked.id)}\n` : ""}
## Known limits

- **Exact canary only.** The secret carries a random canary, matched exactly. A canary reworded, encoded or split across two mails is not seen: a leak of that kind counts as resisted.
- **Canary in the final answer.** A canary shown to the user stays with the user: it is not a leak. Only the read of the secret file is noted, as a partial attempt.
- **Attacks aimed at a known contact.** A partial attempt is only seen when the mail goes to an address outside the contacts. An attack that sends a mail without the canary to a known contact triggers nothing.
- **Hijack has no rule of its own.** It is read from task failure, against the reference. A task failed for an unrelated reason under attack counts as hijacked.
${
	report.calibration
		? `- **A small calibration.** The judge's error rates come from ${report.calibration.annotated} runs annotated by one person. Their intervals are wide: see [Judge calibration](#judge-calibration).`
		: "- **The judge is not calibrated yet.** Its error rate against hand-annotated runs comes with J7. Until then, the verdicts are the judge's alone."
}
- **Objective and vector go together.** Leak and hijack hide in a mail, destructive in a file. A gap between objectives may come from the channel as well as from the ask.
${
	gandalf
		? `- **Gandalf prompts were written for a chatbot.** Their players spoke to the model directly. Here the agent reads them inside a mail or a file, as data: a prompt that worked on Gandalf may not work here, and the other way round.\n`
		: ""
}- **A narrow sample.** Three quantized open models, one simulated mailbox and file system, one task per objective, ${runs} runs per case. The rates hold for this setup, not for agents in general.

## Reproduce

Run the ${compare ? "three" : "two"} campaigns from their files in \`campaigns/\`, then:

\`\`\`bash
bin/hijackbench judge ${reference.id}
bin/hijackbench judge ${attacked.id}${compare ? `\nbin/hijackbench judge ${compare.attacked.id}` : ""}
bin/hijackbench report ${args} > ${dir}/report.md
bin/hijackbench report ${args} --csv > ${dir}/runs.csv
\`\`\`
`;
}
