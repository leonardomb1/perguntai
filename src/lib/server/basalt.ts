import { readFile, stat } from 'node:fs/promises';
import { env } from '$env/dynamic/private';

/**
 * Optional Basalt SQL language reference for the agent, gated by env: point
 * BASALT_SYNTAX_PATH at a copy of basalt's language.md and the full dialect
 * reference rides in the code-execution guidance — without it the model only
 * knows "a `basalt` CLI exists" and tends to guess its syntax.
 *
 * The file is mtime-cached: the content is read once and reused, so the
 * system-prompt prefix stays byte-stable for the prompt cache; a deploy that
 * updates the file is picked up on the next request.
 */

const MAX_REFERENCE_CHARS = 80_000;

let cache: { path: string; mtime: number; content: string } | null = null;

export async function basaltReference(): Promise<string> {
	const path = env.BASALT_SYNTAX_PATH;
	if (!path) return '';
	try {
		const s = await stat(path);
		if (cache && cache.path === path && cache.mtime === s.mtimeMs) return cache.content;
		const content = (await readFile(path, 'utf8')).slice(0, MAX_REFERENCE_CHARS);
		cache = { path, mtime: s.mtimeMs, content };
		return content;
	} catch (error) {
		// Misconfigured path — say so once per boot pattern rather than silently
		// degrading to syntax-guessing.
		if (!cache || cache.path !== path) {
			console.warn(`basalt: could not read BASALT_SYNTAX_PATH (${path}):`, error);
			cache = { path, mtime: -1, content: '' };
		}
		return cache.content;
	}
}
