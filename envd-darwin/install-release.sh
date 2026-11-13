#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
	printf 'Usage: %s <release-tag> [vm-name]\n' "$0" >&2
	exit 2
fi

VERSION=$1
VM_NAME=${2:-sandbox-base}
REPO=${ENVD_RELEASE_REPO:-circlesac/sandbox}
PASSWORD=${TART_SSH_PASSWORD:-admin}

case "$(uname -m)" in
	arm64) ARCH=arm64 ;;
	x86_64) ARCH=amd64 ;;
	*)
		printf 'Unsupported host architecture: %s\n' "$(uname -m)" >&2
		exit 1
		;;
esac

for command in curl shasum ssh sshpass tart; do
	command -v "$command" >/dev/null 2>&1 || {
		printf 'Required command is missing: %s\n' "$command" >&2
		exit 1
	}
done

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/envd-release.XXXXXX")
cleanup() {
	rm -rf "$tmp_dir"
}
trap cleanup EXIT

asset="envd-darwin-${ARCH}.tar.gz"
base_url="https://github.com/${REPO}/releases/download/${VERSION}"
curl -fsSL -o "$tmp_dir/$asset" "$base_url/$asset"
curl -fsSL -o "$tmp_dir/$asset.sha256" "$base_url/$asset.sha256"
(cd "$tmp_dir" && shasum -a 256 -c "$asset.sha256")
tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"

IP_RESOLVER=${TART_IP_RESOLVER:-dhcp}
ip=$(tart ip --wait 30 --resolver "$IP_RESOLVER" "$VM_NAME")
ssh_to_vm() {
	sshpass -p "$PASSWORD" ssh \
		-o IdentitiesOnly=yes \
		-o StrictHostKeyChecking=no \
		-o UserKnownHostsFile=/dev/null \
		-o PreferredAuthentications=password \
		"admin@$ip" "$@"
}


# The command substitution must run inside the VM's login session.
# shellcheck disable=SC2016
ssh_to_vm \
	'sudo mkdir -p /usr/local/bin /usr/local/share/circlesac && sudo launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.circlesac.envd.plist 2>/dev/null || true'

ssh_to_vm 'sudo tee /usr/local/bin/envd >/dev/null && sudo chmod 0755 /usr/local/bin/envd' < "$tmp_dir/envd"

ssh_to_vm "cat > /tmp/com.circlesac.envd.plist <<'PLIST'
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
<key>Label</key><string>com.circlesac.envd</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/envd</string><string>-port</string><string>49983</string><string>-isnotfc</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/tmp/envd.log</string>
<key>StandardErrorPath</key><string>/tmp/envd.log</string>
</dict></plist>
</plist>
PLIST
mkdir -p ~/Library/LaunchAgents
mv /tmp/com.circlesac.envd.plist ~/Library/LaunchAgents/com.circlesac.envd.plist
printf '%s\n' '${VERSION}' | sudo tee /usr/local/share/circlesac/envd-version >/dev/null
launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.circlesac.envd.plist
launchctl kickstart -k gui/\$(id -u)/com.circlesac.envd"

printf 'Installed envd %s (%s) in %s\n' "$VERSION" "$ARCH" "$VM_NAME"
