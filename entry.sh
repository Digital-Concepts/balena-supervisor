#!/bin/sh

set -o errexit

# Mounts boot, state, & data partitions from balenaOS.
source ./mount-partitions.sh

# If the legacy /tmp/resin-supervisor exists on the host, a container might
# already be using to take an update lock, so we symlink it to the new
# location so that the supervisor can see it
[ -d "${ROOT_MOUNTPOINT}"/tmp/resin-supervisor ] &&
	([ -d "${ROOT_MOUNTPOINT}"/tmp/balena-supervisor ] || ln -s ./resin-supervisor "${ROOT_MOUNTPOINT}"/tmp/balena-supervisor)

# Otherwise, if the lockfiles directory doesn't exist
[ -d "${ROOT_MOUNTPOINT}"/tmp/balena-supervisor ] ||
	mkdir -p "${ROOT_MOUNTPOINT}"/tmp/balena-supervisor

# If DOCKER_ROOT isn't set then default it
DOCKER_LIB_PATH="/var/lib/docker"
if [ -z "${DOCKER_ROOT}" ]; then
	DOCKER_ROOT="${ROOT_MOUNTPOINT}${DOCKER_LIB_PATH}"
fi

# Mount the DOCKER_ROOT path equivalent in the container fs
# this is necessary as long as the supervisor still has support
# for rsync deltas
if [ ! -d "${DOCKER_LIB_PATH}" ]; then
	ln -s "${DOCKER_ROOT}" "${DOCKER_LIB_PATH}"
fi

# Include self-signed CAs, should they exist
if [ -n "${BALENA_ROOT_CA}" ]; then
	if [ ! -e '/etc/ssl/certs/balenaRootCA.pem' ]; then
		echo "${BALENA_ROOT_CA}" >/etc/ssl/certs/balenaRootCA.pem

		# Include the balenaRootCA in the system store for services like Docker
		mkdir -p /usr/local/share/ca-certificates
		echo "${BALENA_ROOT_CA}" >/usr/local/share/ca-certificates/balenaRootCA.crt
		update-ca-certificates
	fi
fi

# Setup necessary directories for journalctl
# NOTE: this won't be necessary once the supervisor can update
# itself, as using the label io.balena.features.journal-logs will
# achieve the same objective
if { [ ! -d /run/log/journal ] || [ -L /run/log/journal ]; } && [ -s "${STATE_MOUNTPOINT}"/machine-id ]; then
	# Only enter here if the directory does not exist or the location exists and is a symlink
	# (note that test -d /symlink-to-dir will return true)

	# Create the directory
	mkdir -p /run/log

	# Override the local machine-id
	ln -sf "${ROOT_MOUNTPOINT}"/etc/machine-id /etc/machine-id

	# Remove the original link if it exists to avoid creating deep links
	[ -L /run/log/journal ] && rm /run/log/journal

	# If using persistent logging, the host will the journal under `/var/log/journal`
	# otherwise it will have it under /run/log/journal
	[ -d "${ROOT_MOUNTPOINT}/run/log/journal/$(cat /etc/machine-id)" ] && ln -sf "${ROOT_MOUNTPOINT}"/run/log/journal /run/log/journal
	[ -d "${ROOT_MOUNTPOINT}/var/log/journal/$(cat /etc/machine-id)" ] && ln -sf "${ROOT_MOUNTPOINT}"/var/log/journal /run/log/journal
fi

# Mount the host kernel module path onto the expected location
# We need to do this as busybox doesn't support using a custom location
if [ ! -d /lib/modules ]; then
	ln -s "${ROOT_MOUNTPOINT}"/lib/modules /lib/modules
fi
# Now load the ip6_tables kernel module, so we can do
# filtering on ipv6 addresses. Don't fail here if the
# modprobe fails, as this can either be that the module is
# already loaded or that the kernel module isn't present. In
# the former case, this is fine for runtime, and in the
# latter it means that the supervisor will fail later on, so
# not a problem.
modprobe ip6_tables || true

# Fix permissions on DHCP hooks that need to be executable
if [ -d "${ROOT_MOUNTPOINT}"/usr/lib/dhcpcd/dhcpcd-hooks ]; then
	# Check if the hooks are executable
	if find "${ROOT_MOUNTPOINT}"/usr/lib/dhcpcd/dhcpcd-hooks -type f ! -perm -u+x | grep -q .; then
		# Use nsenter to run commands in the host's mount namespace
		if nsenter --mount=/mnt/root/proc/1/ns/mnt -- mount -o remount,rw /; then
			# Set executable permissions on all hooks 
			if nsenter --mount=/mnt/root/proc/1/ns/mnt -- sh -c 'chmod 0755 /usr/lib/dhcpcd/dhcpcd-hooks/*' 2>/dev/null; then
				echo "Fixed DHCP hook permissions"
			else
				echo "Warning: Failed to set permissions on DHCP hooks" >&2
			fi
			if ! nsenter --mount=/mnt/root/proc/1/ns/mnt -- mount -o remount,ro /; then
				echo "Warning: Failed to remount root filesystem as read-only" >&2
			fi
		else
			echo "Warning: Failed to remount root filesystem, skipping DHCP hook permission fix" >&2
		fi
	fi
fi

# Hotswap a dhcpcd hook file on the host if it is outdated or missing.
# Usage: swap_dhcpcd_hook <hook_filename> <sentinel>
swap_dhcpcd_hook() {
	local hook="$1" sentinel="$2"
	local hook_path="/usr/lib/dhcpcd/dhcpcd-hooks/${hook}"
	if [ -f "${ROOT_MOUNTPOINT}${hook_path}" ]; then
		if [ "$(tail -n 1 "${ROOT_MOUNTPOINT}${hook_path}")" = "${sentinel}" ]; then
			echo "Skipping replacement of ${hook} as it is already the new version"
			return
		fi
		if nsenter --mount=/mnt/root/proc/1/ns/mnt -- mount -o remount,rw /; then
			cp /tmp/"${hook}" "${ROOT_MOUNTPOINT}"/tmp/"${hook}"
			if nsenter --mount=/mnt/root/proc/1/ns/mnt -- sh -c "rm ${hook_path} && cp /tmp/${hook} ${hook_path}" 2>/dev/null; then
				echo "Replaced DHCP hook ${hook} with new version"
			else
				echo "Warning: Failed to replace DHCP hook ${hook}" >&2
			fi
			if ! nsenter --mount=/mnt/root/proc/1/ns/mnt -- mount -o remount,ro /; then
				echo "Warning: Failed to remount root filesystem as read-only" >&2
			fi
			rm -f "${ROOT_MOUNTPOINT}"/tmp/"${hook}"
		else
			echo "Warning: Failed to remount root filesystem, skipping DHCP hook replacement" >&2
		fi
	elif [ -f /tmp/"${hook}" ]; then
		if nsenter --mount=/mnt/root/proc/1/ns/mnt -- mount -o remount,rw /; then
			cp /tmp/"${hook}" "${ROOT_MOUNTPOINT}"/tmp/"${hook}"
			if nsenter --mount=/mnt/root/proc/1/ns/mnt -- cp /tmp/"${hook}" "${hook_path}" 2>/dev/null; then
				echo "Installed DHCP hook ${hook}"
			else
				echo "Warning: Failed to install DHCP hook ${hook}" >&2
			fi
			if ! nsenter --mount=/mnt/root/proc/1/ns/mnt -- mount -o remount,ro /; then
				echo "Warning: Failed to remount root filesystem as read-only" >&2
			fi
			rm -f "${ROOT_MOUNTPOINT}"/tmp/"${hook}"
		else
			echo "Warning: Failed to remount root filesystem, skipping DHCP hook installation" >&2
		fi
	fi
}

swap_dhcpcd_hook 70-no_dflroute_zeroconf "#17.1.5"
swap_dhcpcd_hook 20-resolv.conf "#17.1.5"

if [ "${LIVEPUSH}" = "1" ]; then
	exec npx nodemon --watch src --watch typings --ignore tests -e js,ts,json \
		--exec node -r ts-node/register/transpile-only src/app.ts
else
	exec node /usr/src/app/dist/app.js
fi
