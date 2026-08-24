type CrabboxProvisionTimeoutProfile = {
  provider: string;
  desktop?: boolean;
  setup?: string;
};

export const CRABBOX_WARMUP_TIMEOUT_MS = 240_000;
export const CRABBOX_LIFECYCLE_TIMEOUT_MS = 60_000;
// AWS coordinator heartbeat latency reached 107.6 seconds in production measurements.
export const CRABBOX_HEARTBEAT_TIMEOUT_MS = 150_000;

// `providers --json` is a static compiled report: no network, no credentials,
// measured well under a second. The picker awaits it, so cap it far below the
// lifecycle budget — a hung binary must fall back to label-only choices
// promptly instead of stalling the whole cloud picker.
export const CRABBOX_MACHINE_CATALOG_TIMEOUT_MS = 5_000;
const CRABBOX_PROVISION_TIMEOUT_MS = 290_000;
// Crabbox starts its 45-minute desktop/browser bootstrap clock after acquisition.
// Preserve OpenClaw's existing five-minute acquisition envelope, then leave one
// lifecycle allowance for post-warmup inspection and cleanup.
export const CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS = 50 * 60_000;
const CRABBOX_DESKTOP_PROVISION_TIMEOUT_MS =
  CRABBOX_DESKTOP_WARMUP_TIMEOUT_MS + CRABBOX_LIFECYCLE_TIMEOUT_MS;
// The documented VM-create window precedes SSH readiness; observed readiness needs a bounded 30m.
export const CRABBOX_MACHINE0_WARMUP_TIMEOUT_MS = 30 * 60_000;
// Fixed-lease inspection can follow warmup's final read; allow four one-minute retries.
const CRABBOX_MACHINE0_LIFECYCLE_TIMEOUT_MS = 5 * 60_000;
const CRABBOX_MACHINE0_PROVISION_TIMEOUT_MS =
  CRABBOX_MACHINE0_WARMUP_TIMEOUT_MS + CRABBOX_MACHINE0_LIFECYCLE_TIMEOUT_MS;
// Setup gets its own budget on top of provision so a slow warmup cannot starve it.
export const CRABBOX_SETUP_TIMEOUT_MS = 300_000;
export const CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS = 15 * 60_000;

export function resolveCrabboxLifecycleTimeoutMs(provider: string): number {
  return provider === "machine0"
    ? CRABBOX_MACHINE0_LIFECYCLE_TIMEOUT_MS
    : CRABBOX_LIFECYCLE_TIMEOUT_MS;
}

export function resolveCrabboxProvisionBaseTimeoutMs(
  profile: CrabboxProvisionTimeoutProfile,
): number {
  if (profile.provider === "machine0") {
    return CRABBOX_MACHINE0_PROVISION_TIMEOUT_MS;
  }
  return profile.desktop ? CRABBOX_DESKTOP_PROVISION_TIMEOUT_MS : CRABBOX_PROVISION_TIMEOUT_MS;
}

export function countCrabboxProvisionSetupPhases(profile: CrabboxProvisionTimeoutProfile): number {
  return Number(Boolean(profile.desktop)) + Number(Boolean(profile.setup));
}

export function resolveCrabboxProvisionCallTimeoutMs(
  profile: CrabboxProvisionTimeoutProfile,
): number {
  return (
    resolveCrabboxProvisionBaseTimeoutMs(profile) +
    countCrabboxProvisionSetupPhases(profile) * CRABBOX_SETUP_TIMEOUT_MS +
    CRABBOX_NODE_ENROLLMENT_TIMEOUT_MS +
    resolveCrabboxLifecycleTimeoutMs(profile.provider)
  );
}
