import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { permanentCrabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { nonEmptyString } from "./crabbox-worker-profile.js";
import { CRABBOX_LIFECYCLE_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

export async function assertCrabboxCloudConfigPolicy(params: {
  binary: string;
  provider: "aws" | "hetzner";
  runCommand: CrabboxCommandRunner;
}): Promise<void> {
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json"],
    binary: params.binary,
    runCommand: params.runCommand,
    timeoutMs: CRABBOX_LIFECYCLE_TIMEOUT_MS,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw permanentCrabboxCommandError("config show", result);
  }
  let config: unknown;
  try {
    config = JSON.parse(result.stdout);
  } catch {
    throw new WorkerProviderError("Crabbox config show returned invalid JSON");
  }
  const view = isRecord(config) ? config : undefined;
  if (params.provider === "aws") {
    const aws = view?.aws;
    const instanceProfile = isRecord(aws) ? aws.instanceProfile : undefined;
    if (typeof instanceProfile !== "string") {
      throw new WorkerProviderError("Crabbox config show returned an invalid AWS instance profile");
    }
    if (nonEmptyString(instanceProfile)) {
      throw new WorkerProviderError("Crabbox AWS instance profile must be empty for cloud workers");
    }
    return;
  }
  if (nonEmptyString(view?.coordinator) && view?.brokerMode === "managed") {
    return;
  }
  throw new WorkerProviderError("Crabbox Hetzner desktop profiles require a managed coordinator");
}
