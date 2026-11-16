#!/usr/bin/env node
// Host-alignment sentinel: verifies that the pi coding agent installed on this
// machine satisfies the devDependency range declared in package.json.
//
// Why: local tsc/vitest run against the devDependency copy in node_modules,
// while the real extension runs against the globally installed host. If the
// two drift apart, types can be green locally and broken on the host.
//
// Exit codes: 0 = in range or host not detectable (skip); 1 = out of range.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const HOST_PACKAGE = "@earendil-works/pi-coding-agent";

function readPackageJson() {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const range = manifest.devDependencies?.[HOST_PACKAGE];
	if (typeof range !== "string") {
		console.error(`check-host: package.json has no devDependency for ${HOST_PACKAGE}`);
		process.exit(1);
	}
	return range;
}

// Locate the globally installed pi via `which pi`, resolving symlinks, and walk
// up from the real binary until we find the package.json of the host package.
// Never touches this project's node_modules.
function detectHostVersion() {
	let piPath;
	try {
		piPath = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
	if (!piPath) return undefined;
	let real;
	try {
		real = realpathSync(piPath);
	} catch {
		return undefined;
	}
	let dir = path.dirname(real);
	for (let i = 0; i < 10; i++) {
		try {
			const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
			if (manifest.name === HOST_PACKAGE && typeof manifest.version === "string") {
				return manifest.version;
			}
		} catch {
			// keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

const range = readPackageJson();
const hostVersion = detectHostVersion();

if (!hostVersion) {
	console.log(
		`check-host: skip — no globally installed pi (which pi) found; cannot compare against devDependency range ${range}`,
	);
	process.exit(0);
}

let satisfied;
try {
	// npm semver is available as a transitive dependency of the toolchain; fall
	// back to import failure -> treat as skip-worthy environment error.
	const semver = await import("semver");
	satisfied = semver.default.satisfies(hostVersion, range, { includePrerelease: true });
} catch {
	console.log(`check-host: skip — semver unavailable; host ${hostVersion}, range ${range}`);
	process.exit(0);
}

if (satisfied) {
	console.log(`check-host: OK — host pi ${hostVersion} satisfies devDependency range ${range}`);
	process.exit(0);
}

console.error(
	`check-host: MISMATCH — host pi is ${hostVersion} but devDependency range is ${range}. ` +
		`Local type checks do not reflect the host; update the devDependency (npm install -D ${HOST_PACKAGE}@<host version>) or upgrade the host.`,
);
process.exit(1);
