import _ from 'lodash';

import { getGlobalApiKey, refreshKey } from '../lib/api-keys';
import * as messages from './messages';
import * as eventTracker from '../event-tracker';
import * as deviceState from '../device-state';
import * as logger from '../logging';
import * as config from '../config';
import * as hostConfig from '../host-config';
import type {
	HostConfiguration,
	LegacyHostConfiguration,
} from '../host-config/types';
import * as applicationManager from '../compose/application-manager';
import type { CompositionStepAction } from '../compose/composition-steps';
import { generateStep } from '../compose/composition-steps';
import * as commitStore from '../compose/commit';
import type { Service } from '../compose/service';
import { getApp } from '../device-state/db-format';
import * as TargetState from '../api-binder/poll';
import log from '../lib/supervisor-console';
import { getBlink } from '../lib/blink';
import * as constants from '../lib/constants';
import {
	InternalInconsistencyError,
	NotFoundError,
	BadRequestError,
} from '../lib/errors';
import { withLock } from '../lib/update-lock';
import { promises as fs } from 'fs';
import { exec } from '../lib/fs-utils';
import { readFromBoot, writeToBoot } from '../lib/host-utils';

/**
 * Run an array of healthchecks, outputting whether all passed or not
 * Used by:
 * - GET /v1/healthy
 */
export const runHealthchecks = async (
	healthchecks: Array<() => Promise<boolean>>,
) => {
	const HEALTHCHECK_FAILURE = 'Healthcheck failed';

	try {
		const checks = await Promise.all(healthchecks.map((fn) => fn()));
		if (checks.some((check) => !check)) {
			throw new Error(HEALTHCHECK_FAILURE);
		}
	} catch {
		log.error(HEALTHCHECK_FAILURE);
		return false;
	}

	return true;
};

/**
 * Identify a device by blinking or some other method, if supported
 * Used by:
 * - POST /v1/blink
 */
const DEFAULT_IDENTIFY_DURATION = 15000;
export const identify = async (ms: number = DEFAULT_IDENTIFY_DURATION) => {
	const blink = await getBlink();
	eventTracker.track('Device blink');
	blink.pattern.start();
	setTimeout(blink.pattern.stop, ms);
};

/**
 * Expires the supervisor's API key and generates a new one.
 * Also communicates the new key to the balena API, if it's a key
 * with global scope. The backend uses the global key to communicate
 * with the Supervisor.
 * Used by:
 * - POST /v1/regenerate-api-key
 */
export const regenerateKey = async (oldKey: string) => {
	const shouldReportUpdatedKey = oldKey === (await getGlobalApiKey());
	const newKey = await refreshKey(oldKey);

	if (shouldReportUpdatedKey) {
		deviceState.reportCurrentState({
			api_secret: newKey,
		});
	}

	return newKey;
};

/**
 * Restarts an application by recreating containers.
 * Used by:
 * - POST /v1/restart
 * - POST /v2/applications/:appId/restart
 */
export const doRestart = async (appId: number, force: boolean = false) => {
	await deviceState.initialized();

	const currentState = await deviceState.getCurrentState();
	if (currentState.local.apps?.[appId] == null) {
		throw new InternalInconsistencyError(
			`Application with ID ${appId} is not in the current state`,
		);
	}

	const app = currentState.local.apps[appId];
	const services = app.services;

	try {
		// Set target so that services get deleted
		app.services = [];
		await deviceState.applyIntermediateTarget(currentState, { force });
		// Restore services
		app.services = services;
		return deviceState.applyIntermediateTarget(currentState, {
			keepVolumes: false,
			force,
		});
	} finally {
		deviceState.triggerApplyTarget();
	}
};

/**
 * Purges volumes for an application.
 * Used by:
 * - POST /v1/purge
 * - POST /v2/applications/:appId/purge
 */
export const doPurge = async (appId: number, force: boolean = false) => {
	await deviceState.initialized();

	logger.logSystemMessage(
		`Purging data for app ${appId}`,
		{ appId },
		'Purge data',
	);

	const currentState = await deviceState.getCurrentState();
	if (currentState.local.apps?.[appId] == null) {
		throw new InternalInconsistencyError(
			`Application with ID ${appId} is not in the current state`,
		);
	}
	// Save & delete the app from the current state
	const app = currentState.local.apps[appId];
	delete currentState.local.apps[appId];

	try {
		// Purposely tell the apply function to delete volumes so
		// they can get deleted even in local mode
		await deviceState.applyIntermediateTarget(currentState, {
			keepVolumes: false,
			force,
		});
		// Restore user app after purge
		currentState.local.apps[appId] = app;
		await deviceState.applyIntermediateTarget(currentState);
		logger.logSystemMessage('Purged data', { appId }, 'Purge data success');
	} catch (err: any) {
		logger.logSystemMessage(
			`Error purging data: ${err}`,
			{ appId, error: err?.message ?? err },
			'Purge data error',
		);
		throw err;
	} finally {
		deviceState.triggerApplyTarget();
	}
};

type ClientError = BadRequestError | NotFoundError;
/**
 * Get the current app by its appId from application manager, handling the
 * case of app not being found or app not having services. ClientError should be
 * BadRequestError if querying from a legacy endpoint (v1), otherwise NotFoundError.
 */
const getCurrentApp = async (
	appId: number,
	clientError: new (message: string) => ClientError,
) => {
	const currentApps = await applicationManager.getCurrentApps();
	const currentApp = currentApps[appId];
	if (currentApp == null || currentApp.services.length === 0) {
		// App with given appId doesn't exist, or app doesn't have any services.
		throw new clientError(messages.appNotFound);
	}
	return currentApp;
};

/**
 * Get service details from a legacy (single-container) app.
 * Will only return the first service for multi-container apps, so shouldn't
 * be used for multi-container. The routes that use this, use it to return
 * the containerId of the service after an action was executed on that service,
 * in keeping with the existing legacy interface.
 *
 * Used by:
 * - POST /v1/apps/:appId/stop
 * - POST /v1/apps/:appId/start
 */
export const getLegacyService = async (appId: number) => {
	return (await getCurrentApp(appId, BadRequestError)).services[0];
};

/**
 * Executes a device state action such as reboot, shutdown, or noop
 * Used by:
 * - POST /v1/reboot
 * - POST /v1/shutdown
 * - actions.executeServiceAction
 */
export const executeDeviceAction = async (
	step: Parameters<typeof deviceState.executeStepAction>[0],
	force: boolean = false,
) => {
	return await deviceState.executeStepAction(step, {
		force,
	});
};

/**
 * Used internally by executeServiceAction to handle locks
 * around execution of a service action.
 */
const executeDeviceActionWithLock = async ({
	action,
	appId,
	currentService,
	targetService,
	force = false,
}: {
	action: CompositionStepAction;
	appId: number;
	currentService?: Service;
	targetService?: Service;
	force: boolean;
}) => {
	const lockOverride = await config.get('lockOverride');
	await withLock(
		appId,
		async () => {
			// Execute action on service
			await executeDeviceAction(
				generateStep(action, {
					current: currentService,
					target: targetService,
					wait: true,
				}),
				// FIXME: deviceState.executeStepAction only accepts force as a separate arg
				// instead of reading force from the step object, so we have to pass it twice
				force,
			);
		},
		{ force: force || lockOverride },
	);
};

/**
 * Executes a composition step action on a service.
 * isLegacy indicates that the action is being called from a legacy (v1) endpoint,
 * as a different error code is returned on certain failures to maintain the old interface.
 * Used by:
 * - POST /v1/apps/:appId/(stop|start)
 * - POST /v2/applications/:appId/(restart|stop|start)-service
 */
export const executeServiceAction = async ({
	action,
	appId,
	serviceName,
	imageId,
	force = false,
	isLegacy = false,
}: {
	action: CompositionStepAction;
	appId: number;
	serviceName?: string;
	imageId?: number;
	force?: boolean;
	isLegacy?: boolean;
}): Promise<void> => {
	// Get current and target apps
	const [currentApp, targetApp] = await Promise.all([
		getCurrentApp(appId, isLegacy ? BadRequestError : NotFoundError),
		getApp(appId),
	]);
	const isSingleContainer = currentApp.services.length === 1;
	if (!isSingleContainer && !serviceName && !imageId) {
		// App is multicontainer but no service parameters were provided
		throw new BadRequestError(messages.v2ServiceEndpointError);
	}

	// Find service in current and target apps
	const currentService = isSingleContainer
		? currentApp.services[0]
		: currentApp.services.find(
				(s) => s.imageId === imageId || s.serviceName === serviceName,
			);
	if (currentService == null) {
		// Legacy (v1) throws 400 while v2 throws 404, and we have to keep the interface consistent.
		throw new (isLegacy ? BadRequestError : NotFoundError)(
			messages.serviceNotFound,
		);
	}
	const targetService = targetApp.services.find(
		(s) =>
			s.imageId === currentService.imageId ||
			s.serviceName === currentService.serviceName,
	);
	if (targetService == null) {
		throw new NotFoundError(messages.targetServiceNotFound);
	}

	// A single service start action doesn't require locks
	if (action === 'start') {
		// Execute action on service
		await executeDeviceAction(
			generateStep(action, {
				target: targetService,
			}),
		);
	} else {
		await executeDeviceActionWithLock({
			action,
			appId,
			currentService,
			targetService,
			force,
		});
	}
};

/**
 * Updates the target state cache of the Supervisor, which triggers an apply if applicable.
 * Used by:
 * - POST /v1/update
 */
export const updateTarget = async (
	force: boolean = false,
	cancel: boolean = false,
) => {
	eventTracker.track('Update notification');

	if (force || (await config.get('instantUpdates'))) {
		TargetState.update(force, true, cancel).catch(_.noop);
		return true;
	}

	log.debug(
		'Ignoring update notification because instant updates are disabled or force not specified',
	);
	return false;
};

/**
 * Get application information for a single-container app, throwing if multicontainer
 * Used by:
 * - GET /v1/apps/:appId
 */
export const getSingleContainerApp = async (appId: number) => {
	eventTracker.track('GET app (v1)', { appId });
	const apps = await applicationManager.getCurrentApps();
	const app = apps[appId];
	const service = app?.services?.[0];
	if (service == null) {
		// This should return a 404 Not Found, but we can't change the interface now so keep it as a 400
		throw new BadRequestError('App not found');
	}
	if (app.services.length > 1) {
		throw new BadRequestError(
			'Some v1 endpoints are only allowed on single-container apps',
		);
	}

	// Because we only have a single app, we can fetch the commit for that
	// app, and maintain backwards compatability
	const commit = await commitStore.getCommitForApp(appId);

	return {
		appId,
		commit,
		containerId: service.containerId,
		env: _.omit(service.config.environment, constants.privateAppEnvVars),
		imageId: service.config.image,
		releaseId: service.releaseId,
	};
};

/**
 * Returns legacy device info, update status, and service status for a single-container application.
 * Used by:
 * 	- GET /v1/device
 */
export const getLegacyDeviceState = async () => {
	const state = await deviceState.getLegacyState();
	const stateToSend = _.pick(state.local, [
		'api_port',
		'ip_address',
		'os_version',
		'mac_address',
		'supervisor_version',
		'update_pending',
		'update_failed',
		'update_downloaded',
	]) as Dictionary<any>;

	if (state.local?.is_on__commit != null) {
		stateToSend.commit = state.local.is_on__commit;
	}

	// NOTE: This only returns the status of the first service,
	// even in a multi-container app. We should deprecate this endpoint
	// in favor of a multi-container friendly device endpoint (which doesn't
	// exist yet), and use that for cloud dashboard diagnostic queries.
	const service = _.toPairs(
		_.toPairs(state.local?.apps)[0]?.[1]?.services,
	)[0]?.[1];

	if (service != null) {
		stateToSend.status = service.status;
		if (stateToSend.status === 'Running') {
			stateToSend.status = 'Idle';
		}
		stateToSend.download_progress = service.download_progress;
	}

	return stateToSend;
};

/**
 * Get host config from the host-config module; Returns proxy config and hostname.
 * Used by:
 * 	- GET /v1/device/host-config
 */
export const getHostConfig = async () => {
	return await hostConfig.get();
};

/**
 * Patch host configs such as proxy config and hostname
 * Used by:
 * 	- PATCH /v1/device/host-config
 */
export const patchHostConfig = async (conf: unknown, force: boolean) => {
	let parsedConf: HostConfiguration | LegacyHostConfiguration;
	try {
		parsedConf = hostConfig.parse(conf);
	} catch (e: unknown) {
		throw new BadRequestError((e as Error).message);
	}
	await hostConfig.patch(parsedConf, force);
};

// Paths for dhcpcd.conf manipulation via nsenter + remount, mirroring the
// pattern established in entry.sh for DHCP hook hotswapping.
const ROOT_DHCPCD_CONF = `${constants.rootMountPoint}/etc/dhcpcd.conf`;
const STAGED_DHCPCD_CONF = `${constants.rootMountPoint}/tmp/dhcpcd.conf.new`;
const NS_MOUNT = `${constants.rootMountPoint}/proc/1/ns/mnt`;

// Remove or replace previous eth0 information
const modifyDhcpcdConf = (content: string, newSection?: string): string => {
	const lines = content.split('\n');
	const result: string[] = [];
	let inEth0Section = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^interface\s+eth0(\s|$)/.test(trimmed)) {
			inEth0Section = true;
			continue;
		}
		if (inEth0Section && /^interface\s+/.test(trimmed)) {
			inEth0Section = false;
		}
		if (!inEth0Section) {
			result.push(line);
		}
	}

	while (result.length > 0 && result[result.length - 1].trim() === '') {
		result.pop();
	}

	if (newSection) {
		result.push('');
		result.push(newSection);
	}

	return result.join('\n') + '\n';
};

// Write modified dhcpcd.conf to the host filesystem using the nsenter as we
// need those actions on the host not the container
const writeDhcpcdConf = async (content: string): Promise<void> => {
	await fs.writeFile(STAGED_DHCPCD_CONF, content, { mode: 0o644 });
	try {
		// mount it as rw then hotswap the config
		await exec(`nsenter --mount=${NS_MOUNT} -- mount -o remount,rw /`);
		await exec(
			`nsenter --mount=${NS_MOUNT} -- sh -c 'cp /tmp/dhcpcd.conf.new /etc/dhcpcd.conf && rm /tmp/dhcpcd.conf.new'`,
		);
	} finally {
		await exec(`nsenter --mount=${NS_MOUNT} -- mount -o remount,ro /`).catch(
			(e: unknown) =>
				log.warn(
					'Failed to remount root read-only after dhcpcd.conf write:',
					e,
				),
		);
		await fs.unlink(STAGED_DHCPCD_CONF).catch(() => undefined);
	}
};

// restart dhcpcd with thenew config
const reloadDhcpcd = async () => {
	await exec(
		`nsenter --mount=${NS_MOUNT} -- sh -c 'killall -HUP dhcpcd 2>/dev/null || true'`,
	).catch((e: unknown) => log.warn('Failed to signal dhcpcd to reload:', e));
};

// Write the information for the the .conf into the correct format. and modify the file.
export const doSetEth0StaticIp = async (
	ip: string,
	routers?: string,
	dns?: string,
): Promise<void> => {
	const section = [
		'interface eth0',
		`static ip_address=${ip}`,
		...(routers ? [`static routers=${routers}`] : []),
		...(dns ? [`static domain_name_servers=${dns}`] : []),
	].join('\n');

	const conf = await fs.readFile(ROOT_DHCPCD_CONF, 'utf-8');
	const modified = modifyDhcpcdConf(conf, section);
	await writeDhcpcdConf(modified);
	await reloadDhcpcd();
};

// Remove the eth0 ip information from the .conf.
// restart the dhcpcd.
export const doClearEth0StaticIp = async (): Promise<void> => {
	const conf = await fs.readFile(ROOT_DHCPCD_CONF, 'utf-8');
	const modified = modifyDhcpcdConf(conf);
	await writeDhcpcdConf(modified);
	await reloadDhcpcd();
};

// ---------------------------------------------------------------------------
// NTP server configuration — reads/writes ntpServers in /mnt/boot/config.json
// ---------------------------------------------------------------------------

const readConfigJson = async (): Promise<Record<string, unknown>> => {
	const content = await readFromBoot(constants.configJsonPath, 'utf-8');
	return JSON.parse(content) as Record<string, unknown>;
};

const writeConfigJson = async (
	conf: Record<string, unknown>,
): Promise<void> => {
	await writeToBoot(constants.configJsonPath, JSON.stringify(conf));
};

/**
 * Return the current ntpServers string from config.json, or null if not set.
 */
export const doGetNtpServers = async (): Promise<string | null> => {
	const conf = await readConfigJson();
	const val = conf.ntpServers;
	return typeof val === 'string' ? val : null;
};

/**
 * Write a space-separated list of NTP servers into config.json.
 * @param ntpServers Space-separated NTP server addresses, e.g. "ntp1.server.com ntp2.server.com"
 */
export const doSetNtpServers = async (ntpServers: string): Promise<void> => {
	const conf = await readConfigJson();
	conf.ntpServers = ntpServers;
	await writeConfigJson(conf);
};

/**
 * Remove the ntpServers key from config.json, reverting to balenaOS defaults.
 */
export const doClearNtpServers = async (): Promise<void> => {
	const conf = await readConfigJson();
	delete conf.ntpServers;
	await writeConfigJson(conf);
};
