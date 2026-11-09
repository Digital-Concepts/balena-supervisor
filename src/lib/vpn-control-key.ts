import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { writeFileAtomic, mkdirp } from './fs-utils';
import { isENOENT } from './errors';
import { checkTruthy } from './validation';

// DC vendor extension: a secret injected only into services that carry the
// `io.balena.features.dc-vpn-control` label. While such a service runs,
// enabling the VPN through the device API requires presenting it, so only that
// service can switch it on. The restriction also holds while the target
// release carries the label (e.g. that service is being recreated), and when
// the target cannot be read. Releases without the label keep the open toggle.
// The key persists in the supervisor's private /data volume and stays stable
// across restarts so injecting it never recreates the service.

export const VPN_CONTROL_LABEL = 'io.balena.features.dc-vpn-control';

type LabelledService = { config: { labels?: { [name: string]: string } } };
type Labels = { labels?: { [name: string]: string } };
type TargetLike = {
	[uuid: string]: {
		releases?: { [commit: string]: { services?: { [name: string]: Labels } } };
	};
};

const KEY_PATTERN = /^[0-9a-f]{64}$/;

const keyPath = () =>
	process.env.DC_VPN_CONTROL_KEY_PATH ?? '/data/dc/vpn-control.key';

let pending: Promise<string> | undefined;

async function loadOrCreate(): Promise<string> {
	const file = keyPath();
	try {
		const existing = (await fs.readFile(file, 'utf8')).trim();
		if (KEY_PATTERN.test(existing)) {
			return existing;
		}
	} catch (e: any) {
		if (!isENOENT(e)) {
			throw e;
		}
	}
	const key = crypto.randomBytes(32).toString('hex');
	await mkdirp(path.dirname(file));
	await writeFileAtomic(file, key);
	return key;
}

export function getVpnControlKey(): Promise<string> {
	// Concurrent first callers share one creation so they all see the same key.
	pending ??= loadOrCreate().finally(() => {
		pending = undefined;
	});
	return pending;
}

const labelled = (labels?: { [name: string]: string }) =>
	checkTruthy(labels?.[VPN_CONTROL_LABEL]);

/**
 * True when a running service or a service of the target release carries the
 * dc-vpn-control label; a target that could not be read (null) counts as true.
 */
export function vpnControlActive(
	services: LabelledService[],
	target: TargetLike | null,
): boolean {
	if (target === null || services.some((s) => labelled(s.config.labels))) {
		return true;
	}
	return Object.values(target).some((app) =>
		Object.values(app.releases ?? {}).some((release) =>
			Object.values(release.services ?? {}).some((svc) => labelled(svc.labels)),
		),
	);
}

export async function vpnEnableAllowed(
	header: string | undefined,
	services: LabelledService[],
	target: TargetLike | null,
): Promise<boolean> {
	if (!vpnControlActive(services, target)) {
		return true;
	}
	if (!header) {
		return false;
	}
	const expected = Buffer.from(await getVpnControlKey());
	const given = Buffer.from(header);
	return (
		given.length === expected.length && crypto.timingSafeEqual(given, expected)
	);
}
