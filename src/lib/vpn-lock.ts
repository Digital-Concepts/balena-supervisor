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

// Fail-closed sentinel: a lock file exists but its intent cannot be trusted.
// The lock's purpose is to keep the VPN off, so the safe state on any read or
// parse failure is `enabled: false` — never silently revert to the cloud
// target, which would re-enable the VPN.
function failClosed(): VpnLock {
	return { enabled: false, lockedAt: new Date(0).toISOString() };
}

export async function readVpnLock(): Promise<VpnLock | null> {
	let raw: string;
	try {
		raw = await fs.readFile(VPN_LOCK_PATH, 'utf8');
	} catch (e: any) {
		if (isENOENT(e)) {
			// No lock file at all: the cloud target legitimately governs the VPN.
			return null;
		}
		// The lock file is present but unreadable (EIO/EACCES/...). Fail closed.
		log.error(
			`vpn-lock read failed (${e?.message ?? e}); failing closed to VPN disabled`,
		);
		return failClosed();
	}

	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.enabled !== 'boolean') {
			throw new Error('missing boolean "enabled" field');
		}
		return {
			enabled: parsed.enabled,
			lockedAt:
				typeof parsed.lockedAt === 'string'
					? parsed.lockedAt
					: new Date(0).toISOString(),
		};
	} catch (e: any) {
		// The lock file exists but is corrupt. Fail closed rather than falling
		// back to the cloud target.
		log.error(
			`vpn-lock at ${VPN_LOCK_PATH} is malformed (${e?.message ?? e}); failing closed to VPN disabled`,
		);
		return failClosed();
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
