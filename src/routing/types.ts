export type Effort = 1 | 2 | 3 | 4 | 5;
export type Scope = "coding" | "agents" | "overall";

export interface Measurement {
	score: number;
	source: "PublicAI";
	generatedAt: string;
	fetchedAt: number;
	id: string;
	covered?: number;
	agreement?: string;
}

export type RoutingConfig =
	| { mode: "jev"; model?: string; maxReferencePrice?: number }
	| { mode: "fixed"; models: Record<Effort, string> };

export interface ModelFacts {
	id: string;
	name: string;
	inputPrice?: number;
	outputPrice?: number;
	context?: number;
	tools?: boolean;
	reference?: { source: "models.dev"; fetchedAt: number };
	measurements?: Partial<Record<Scope, Measurement>>;
}

export interface CatalogSnapshot {
	version: 1;
	fetchedAt: number;
	models: ModelFacts[];
	warnings?: string[];
}

export interface RoutingDecision {
	effort: Effort;
	method: "jev" | "fixed";
	selectedModel: string;
	candidates: string[];
	reason: string;
	warnings: string[];
	confidence?: number;
	routerModel?: string;
	catalogFetchedAt?: number;
	facts?: ModelFacts;
}

export interface RouteTask {
	task: string;
	objective: string;
	effort?: Effort;
	model?: string;
	provider?: string;
	adjustment?: { previousModel: string; previousEffort?: Effort; direction?: "up" | "down" };
}

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
