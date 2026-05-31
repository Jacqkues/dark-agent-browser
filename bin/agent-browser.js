#!/usr/bin/env node

/**
 * Cross-platform CLI wrapper for agent-browser
 * 
 * This wrapper enables npx support on Windows where shell scripts don't work.
 * For global installs, postinstall.js patches the shims to invoke the native
 * binary directly (zero overhead).
 */

import { spawn, execSync } from 'child_process';
import { existsSync, accessSync, chmodSync, constants, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function hasUsableBinary(path) {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

// Detect if the system uses musl libc (e.g. Alpine Linux)
function isMusl() {
  if (platform() !== 'linux') return false;
  try {
    const result = execSync('ldd --version 2>&1 || true', { encoding: 'utf8' });
    return result.toLowerCase().includes('musl');
  } catch {
    return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
  }
}

// Map Node.js platform/arch to binary naming convention
function getBinaryName() {
  const os = platform();
  const cpuArch = arch();

  let osKey;
  switch (os) {
    case 'darwin':
      osKey = 'darwin';
      break;
    case 'linux':
      osKey = isMusl() ? 'linux-musl' : 'linux';
      break;
    case 'win32':
      osKey = 'win32';
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case 'x64':
    case 'x86_64':
      archKey = 'x64';
      break;
    case 'arm64':
    case 'aarch64':
      archKey = 'arm64';
      break;
    default:
      return null;
  }

  const ext = os === 'win32' ? '.exe' : '';
  return `agent-browser-${osKey}-${archKey}${ext}`;
}

function main() {
  const binaryName = getBinaryName();

  if (!binaryName) {
    console.error(`Error: Unsupported platform: ${platform()}-${arch()}`);
    process.exit(1);
  }

  const binaryPath = join(__dirname, binaryName);

  if (!hasUsableBinary(binaryPath)) {
    let releaseUrl = null;
    try {
      const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
      releaseUrl = `https://github.com/vercel-labs/agent-browser/releases/download/v${packageJson.version}/${binaryName}`;
    } catch {
      // Best effort only
    }

    console.error(`Error: No binary found for ${platform()}-${arch()}`);
    console.error(`Expected: ${binaryPath}`);
    console.error('');
    console.error('The native binary is downloaded during npm postinstall.');
    console.error('Reinstall this package to retry the download.');
    if (releaseUrl) {
      console.error('');
      console.error('Manual download:');
      console.error(`  ${releaseUrl}`);
    }
    if (existsSync(join(projectRoot, 'cli', 'Cargo.toml'))) {
      console.error('');
      console.error('For a source checkout, run "pnpm run build:native".');
    }
    process.exit(1);
  }

  // Ensure binary is executable (fixes EACCES on macOS/Linux when postinstall didn't run,
  // e.g., when using bun which blocks lifecycle scripts by default)
  if (platform() !== 'win32') {
    try {
      accessSync(binaryPath, constants.X_OK);
    } catch {
      // Binary exists but isn't executable - fix it
      try {
        chmodSync(binaryPath, 0o755);
      } catch (chmodErr) {
        console.error(`Error: Cannot make binary executable: ${chmodErr.message}`);
        console.error('Try running: chmod +x ' + binaryPath);
        process.exit(1);
      }
    }
  }

  // Spawn the native binary with inherited stdio
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('error', (err) => {
    console.error(`Error executing binary: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

main();
