import { promises as fs } from 'fs';
import path from 'path';

import { writeFileAtomic, mkdirp } from './fs-utils';
import { isENOENT } from './errors';
import log from './supervisor-console';

// DC vendor extension: a local-authority lock file that overrides the
// cloud-managed SUPERVISOR_VPN_CONTROL target. When present, the supervisor's
// reconciliation loop must honour `enabled` regardless of cloud target state.
//
// Lives inside the supervisor's private /data volume, which user-app
// containers cannot mount under balena's release validation rules.

export const VPN_LOCK_PATH =
	process.env.DC_VPN_LOCK_PATH ?? '/data/dc/vpn-lock.json';

export interface VpnLock {
	enabled: boolean;
	lockedAt: string;
}

export async function readVpnLock(): Promise<VpnLock | null> {
	try {
		const raw = await fs.readFile(VPN_LOCK_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		if (typeof parsed?.enabled !== 'boolean') {
			log.warn(`vpn-lock at ${VPN_LOCK_PATH} is malformed; ignoring`);
			return null;
		}
		return {
			enabled: parsed.enabled,
			lockedAt:
				typeof parsed.lockedAt === 'string'
					? parsed.lockedAt
					: new Date(0).toISOString(),
		};
	} catch (e: any) {
		if (isENOENT(e)) {
			return null;
		}
		log.warn(`vpn-lock read failed: ${e?.message ?? e}`);
		return null;
	}
}

export async function writeVpnLock(enabled: boolean): Promise<VpnLock> {
	const lock: VpnLock = {
		enabled,
		lockedAt: new Date().toISOString(),
	};
	await mkdirp(path.dirname(VPN_LOCK_PATH));
	await writeFileAtomic(VPN_LOCK_PATH, JSON.stringify(lock));
	return lock;
}
