// Mission numbering. Trivially `current + 1`; it exists as a function so the
// mission registry (workstream 02) owns the only call site and numbers are
// never minted anywhere else.
export function nextNumber(current: number): number {
	return current + 1;
}
