// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	/** Set to true at build time when `SURF_ADAPTER=node` (self-hosted single-origin image). */
	const __SURF_SELF_HOSTED__: boolean;
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
