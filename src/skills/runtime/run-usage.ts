import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { resolveSkillTelemetrySource } from "../loading/source.js";
import type { ExplicitSkillSelection, SkillSnapshot, SkillTelemetrySource } from "../types.js";

const MAX_TRACKED_SKILL_USAGE_RUNS = 1024;

export type RunSkillUsage = Readonly<{
  name: string;
  source: SkillTelemetrySource;
  activation: "command" | "read";
  skillFile?: string;
}>;

const skillUsageByRun = new Map<string, Map<string, RunSkillUsage>>();

function comparableSkillPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    return undefined;
  }
  const resolved = canonicalizePath(path.resolve(trimmed));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Records the skills the foreground run demonstrably invoked or read. */
export function recordRunSkillUsage(params: RunSkillUsage & { runId?: string }): void {
  const runId = params.runId;
  if (!runId) {
    return;
  }
  const usage = skillUsageByRun.get(runId) ?? new Map<string, RunSkillUsage>();
  const record = {
    name: params.name,
    source: params.source,
    activation: params.activation,
    ...(params.skillFile ? { skillFile: params.skillFile } : {}),
  };
  usage.set(`${record.source}\u0000${record.name}\u0000${record.activation}`, record);
  skillUsageByRun.set(runId, usage);
  pruneMapToMaxSize(skillUsageByRun, MAX_TRACKED_SKILL_USAGE_RUNS);
}

/** Records core-resolved explicit skill commands against the admitted run. */
export function recordExplicitSkillSelectionsForRun(params: {
  runId?: string;
  selections?: readonly ExplicitSkillSelection[];
  skillsSnapshot?: SkillSnapshot;
}): void {
  if (!params.runId || !params.selections?.length) {
    return;
  }
  const skillsByPath = new Map(
    (params.skillsSnapshot?.resolvedSkills ?? []).flatMap((skill) => {
      const skillFile = comparableSkillPath(skill.filePath);
      return skillFile ? [[skillFile, skill] as const] : [];
    }),
  );
  for (const selection of params.selections) {
    const selectedPath = comparableSkillPath(selection.path);
    const skill = selectedPath ? skillsByPath.get(selectedPath) : undefined;
    if (!skill) {
      continue;
    }
    recordRunSkillUsage({
      runId: params.runId,
      name: skill.name,
      source: resolveSkillTelemetrySource(skill),
      activation: "command",
      skillFile: skill.filePath,
    });
  }
}

/** Checks whether this run demonstrably used one writable workspace skill. */
export function hasRunWorkspaceSkillUsage(params: {
  runId: string | undefined;
  name: string;
  skillFile: string;
}): boolean {
  if (!params.runId) {
    return false;
  }
  for (const usage of skillUsageByRun.get(params.runId)?.values() ?? []) {
    if (
      usage.source === "workspace" &&
      (usage.skillFile === params.skillFile || (!usage.skillFile && usage.name === params.name))
    ) {
      return true;
    }
  }
  return false;
}

/** Transfers one completed run's usage receipt to its terminal side effects. */
export function consumeRunSkillUsage(runId: string | undefined): RunSkillUsage[] {
  if (!runId) {
    return [];
  }
  const usage = skillUsageByRun.get(runId);
  skillUsageByRun.delete(runId);
  return usage ? [...usage.values()] : [];
}
