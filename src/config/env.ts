import { existsSync } from 'node:fs';

// A local .env (see .env.example) fills in anything the shell did not set.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Typed view of the environment the suite runs against. Every layer reads
 * this and nothing else, so the same tests run against any OpenBoxes
 * instance: a stack booted by scripts/stack.sh or an existing server.
 */
export interface Env {
  /** Base URL including the context path, always ending in "/". */
  baseUrl: string;
  adminUsername: string;
  adminPassword: string;
  /** Location id chosen at login; fresh installs ship "Main Warehouse" as id 1. */
  locationId: string;
  /** Result label, e.g. image-v0.9.8; results go to results/<label>/. */
  label: string;
}

function read(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is not set (see .env.example)`);
}

export function loadEnv(): Env {
  const baseUrl = new URL(read('OB_BASE_URL', 'http://localhost:8080/openboxes'));
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  const label = read('OB_LABEL', 'local');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(label)) {
    throw new Error(`OB_LABEL must match [a-z0-9][a-z0-9.-]*: ${label}`);
  }
  return {
    baseUrl: baseUrl.toString(),
    adminUsername: read('OB_ADMIN_USERNAME', 'admin'),
    adminPassword: read('OB_ADMIN_PASSWORD', 'password'),
    locationId: read('OB_LOCATION_ID', '1'),
    label,
  };
}

export const env = loadEnv();
