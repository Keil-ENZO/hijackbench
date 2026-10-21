// A technical failure while talking to a model. It is never a verdict:
// the runner retries or stops, the judge never sees it.

export type ProviderErrorKind =
	| "network" // connection refused, reset, DNS
	| "timeout" // no complete reply in time
	| "http" // non-2xx status
	| "invalid_response" // a reply we cannot read
	| "aborted"; // cancelled by the caller, e.g. the emergency stop

export class ProviderError extends Error {
	override readonly name = "ProviderError";
	readonly kind: ProviderErrorKind;
	readonly status: number | undefined;

	constructor(
		kind: ProviderErrorKind,
		message: string,
		options: { cause?: unknown; status?: number } = {},
	) {
		super(message, { cause: options.cause });
		this.kind = kind;
		this.status = options.status;
	}
}

export const isProviderError = (error: unknown): error is ProviderError =>
	error instanceof ProviderError;
