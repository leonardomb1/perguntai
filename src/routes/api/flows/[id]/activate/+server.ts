import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { requireFlowAccess } from '$lib/server/guards';
import { publicRecord, setDeployment } from '$lib/server/flows';
import { validateFlowSemantics } from '$lib/server/flow-validate';
import { compileFlow } from '$lib/server/flow-compile';
import { seal } from '$lib/server/seal';
import { getUserSettings } from '$lib/server/settings';
import {
	deleteWindmillSchedule,
	upsertWindmillFlow,
	upsertWindmillSchedule,
	setWindmillVariable,
	windmillWhoami
} from '$lib/server/windmill';
import type { RequestHandler } from './$types';

/**
 * Activation is the governance gate: the AI only ever saves drafts; a human
 * deploys one specific version to Windmill. Runs as the ACTIVATING user — we
 * seal their live StarRocks credentials for agent callbacks and store the
 * warehouse creds as their own Windmill secret variables.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	// Owner-only: activation seals the ACTIVATING user's live StarRocks creds as
	// the flow's run-as identity — nobody else can produce them.
	const ctx = await requireFlowAccess(request, params.id, 'activate');
	if (ctx instanceof Response) return ctx;
	const { user, record } = ctx;

	const body = (await request.json().catch(() => ({}))) as { version?: number };
	const wanted = typeof body.version === 'number' ? body.version : record.versions.at(-1)?.version;
	const version = record.versions.find((v) => v.version === wanted);
	if (!version) return json({ error: `Version ${wanted} not found` }, { status: 404 });

	// A stale draft could predate newer validation rules — never deploy one.
	const errors = validateFlowSemantics(version.spec);
	if (errors.length > 0) {
		return json({ error: 'Flow version fails validation', errors }, { status: 422 });
	}

	const settings = await getUserSettings(user.username);
	if (!settings.windmillDeployToken) {
		return json({ error: 'needs_deploy_token' }, { status: 400 });
	}
	const token = settings.windmillDeployToken;

	try {
		const wmUser = await windmillWhoami(token);
		const path = `u/${wmUser}/pai_${record.id.slice(0, 8)}`;
		const compiled = compileFlow(version.spec, {
			varPrefix: path,
			baseUrl: (env.PERGUNTAI_BASE_URL ?? env.ORIGIN)?.replace(/\/+$/, '') ?? null,
			flowId: record.id,
			owner: user.username,
			name: record.name
		});

		// Reuse the callback secret across re-activations so an in-flight run
		// from the previous version can still resolve its agent step.
		const secret = record.deployment?.secret ?? randomUUID();
		await Promise.all([
			setWindmillVariable(token, `${path}_sr_user`, user.credentials.username, true),
			setWindmillVariable(token, `${path}_sr_pass`, user.credentials.password, true),
			setWindmillVariable(token, `${path}_secret`, secret, true)
		]);

		await upsertWindmillFlow(token, path, {
			summary: record.name,
			description: `Fluxo PerguntAI ${record.id} v${version.version} — gerenciado pelo app, não edite aqui.`,
			value: compiled.value,
			schema: compiled.schema
		});

		const trigger = version.spec.nodes.find((n) => n.kind === 'trigger');
		const scheduled = trigger?.kind === 'trigger' && trigger.config.mode === 'schedule';
		if (scheduled && trigger.config.mode === 'schedule') {
			await upsertWindmillSchedule(token, path, {
				// Windmill cron is 6-field (seconds first); the spec stores 5-field.
				schedule: `0 ${trigger.config.cron}`,
				timezone: 'America/Sao_Paulo',
				script_path: path,
				enabled: true
			});
		} else {
			await deleteWindmillSchedule(token, path);
		}

		const updated = await setDeployment(user.username, record.id, {
			windmillPath: path,
			deployedVersion: version.version,
			scheduleEnabled: scheduled,
			deployedAt: new Date().toISOString(),
			secret,
			sealedCreds: seal(user.credentials)
		});
		return json(publicRecord(updated ?? record));
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Activation failed';
		console.error(`flow activate ${record.id} failed:`, message);
		return json({ error: message.slice(0, 300) }, { status: 502 });
	}
};
