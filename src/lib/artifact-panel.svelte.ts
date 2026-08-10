/**
 * The artifact side panel: one document open at a time, Claude-style, to the
 * right of the chat. Cards in messages open it; the panel lazily loads its
 * content (blob for PDFs, text for renderable documents) when shown.
 */

export interface ArtifactSpec {
	/** Stable identity — used to avoid re-opening the same artifact twice. */
	key: string;
	title: string;
	badge: string;
	kind: 'pdf' | 'markdown' | 'text';
	load: () => Promise<{ objectUrl?: string; text?: string; error?: string }>;
	/** Returns an error message, or null on success (mirrors downloadExport). */
	download: () => Promise<string | null>;
}

export const artifactPanel = $state<{ view: ArtifactSpec | null }>({ view: null });

const autoOpened = new Set<string>();

export function openArtifact(spec: ArtifactSpec): void {
	artifactPanel.view = spec;
}

/** Open once per artifact key — for streaming auto-open during a live turn. */
export function autoOpenArtifact(spec: ArtifactSpec): void {
	if (autoOpened.has(spec.key)) return;
	autoOpened.add(spec.key);
	artifactPanel.view = spec;
}

export function closeArtifact(): void {
	artifactPanel.view = null;
}
