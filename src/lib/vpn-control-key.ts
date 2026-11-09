import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import { writeFileAtomic, mkdirp } from './fs-utils';
import { isENOENT } from './errors';
import { checkTruthy } from './validation';

// DC vendor extension: a secret injected only into services that carry the
// `io.balena.features.dc-vpn-control` label. While such a service runs,
// enabling the VPN through the device API requires presenting it, so only that
// service can switch it on. Releases without the label keep the open toggle.
// The key persists in the supervisor's private /data volume and stays stable
// across restarts so injecting it never recreates the service.

export const VPN_CONTROL_LABEL = 'io.balena.features.dc-vpn-control';

type LabelledService = { config: { labels?: { [name: string]: string } } };

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

/** True when a running service carries the dc-vpn-control label. */
export function vpnControlActive(services: LabelledService[]): boolean {
	return services.some((s) =>
		checkTruthy(s.config.labels?.[VPN_CONTROL_LABEL]),
	);
}

export async function vpnEnableAllowed(
	header: string | undefined,
	services: LabelledService[],
): Promise<boolean> {
	if (!vpnControlActive(services)) {
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
