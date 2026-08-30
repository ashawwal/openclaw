import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillCommandSpecs } from "../../../skills/discovery/command-specs.js";
import { loadWorkspaceSkills } from "../../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../../skills/loading/workspace-skill-prompt.js";
import {
  consumeRunSkillUsage,
  hasRunWorkspaceSkillUsage,
} from "../../../skills/runtime/run-usage.js";
import { writeSkill } from "../../../skills/test-support/e2e-test-helpers.js";
import { applySkillProposal, proposeCreateSkill } from "../../../skills/workshop/service.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { withTempDir } from "../../../test-utils/temp-dir.js";
import { createSkillWorkshopTool } from "../../tools/skill-workshop-tool.js";
import { recordExplicitSkillSelectionsForRun } from "./skill-selection-usage.js";

describe("explicit run skill usage", () => {
  it.runIf(process.platform !== "win32")(
    "matches a canonical selection to an allowed workspace symlink snapshot",
    async () => {
      await withTempDir("openclaw-run-skill-usage-", async (rootDir) => {
        const workspacePath = path.join(rootDir, "workspace");
        await fs.mkdir(workspacePath, { recursive: true });
        const workspaceDir = await fs.realpath(workspacePath);
        const targetRoot = path.join(rootDir, "allowed-targets");
        const targetSkillDir = path.join(targetRoot, "release");
        const unrelatedTargetSkillDir = path.join(targetRoot, "unrelated");
        const linkedSkillDir = path.join(workspaceDir, "skills", "release");
        const unrelatedLinkedSkillDir = path.join(workspaceDir, "skills", "unrelated");
        await writeSkill({
          dir: targetSkillDir,
          name: "release",
          description: "Release safely",
          frontmatterExtra: "user-invocable: true\ndisable-model-invocation: true",
        });
        await writeSkill({
          dir: unrelatedTargetSkillDir,
          name: "unrelated",
          description: "Unrelated skill",
        });
        await fs.mkdir(path.dirname(linkedSkillDir), { recursive: true });
        await fs.symlink(targetSkillDir, linkedSkillDir, "dir");
        await fs.symlink(unrelatedTargetSkillDir, unrelatedLinkedSkillDir, "dir");
        const config = { skills: { load: { allowSymlinkTargets: [targetRoot] } } };
        const entries = loadWorkspaceSkills(workspaceDir, {
          config,
          managedSkillsDir: path.join(rootDir, "managed"),
          bundledSkillsDir: "",
          pluginSkillsDir: path.join(rootDir, "plugins"),
        });
        const snapshot = buildSkillSnapshot(workspaceDir, { config, entries });
        const selection = buildWorkspaceSkillCommandSpecs(workspaceDir, {
          config,
          entries,
        }).find((command) => command.skillName === "release");
        const snapshotSkillFile = path.join(linkedSkillDir, "SKILL.md");
        const unrelatedSkillFile = path.join(unrelatedLinkedSkillDir, "SKILL.md");
        const snapshotSkill = snapshot.resolvedSkills?.find((skill) => skill.name === "release");
        const snapshotCommand = snapshot.resolvedSkillCommands?.find(
          (command) => command.skillName === "release",
        );
        const runId = "allowed-symlink-run";

        expect(selection?.skillFile).toBe(await fs.realpath(snapshotSkillFile));
        expect(snapshotSkill).toBeUndefined();
        expect(snapshotCommand).toEqual({
          selectionPath: await fs.realpath(snapshotSkillFile),
          skillFile: snapshotSkillFile,
          skillName: "release",
          skillSource: "workspace",
        });

        recordExplicitSkillSelectionsForRun({
          runId,
          selections: selection?.skillFile
            ? [{ name: selection.name, path: selection.skillFile }]
            : [],
          skillsSnapshot: snapshot,
        });

        expect(
          hasRunWorkspaceSkillUsage({ runId, name: "release", skillFile: snapshotSkillFile }),
        ).toBe(true);
        expect(
          hasRunWorkspaceSkillUsage({
            runId,
            name: "unrelated",
            skillFile: unrelatedSkillFile,
          }),
        ).toBe(false);
        consumeRunSkillUsage(runId);
      });
    },
  );

  it("fails closed when two command identities share one admitted path", () => {
    const runId = "ambiguous-command-path-run";
    const selectionPath = "/tmp/shared-target/SKILL.md";
    const firstSkillFile = "/tmp/workspace/skills/first/SKILL.md";
    const secondSkillFile = "/tmp/workspace/skills/second/SKILL.md";

    recordExplicitSkillSelectionsForRun({
      runId,
      selections: [{ name: "first", path: selectionPath }],
      skillsSnapshot: {
        prompt: "",
        skills: [],
        resolvedSkillCommands: [
          {
            selectionPath,
            skillFile: firstSkillFile,
            skillName: "first",
            skillSource: "workspace",
          },
          {
            selectionPath,
            skillFile: secondSkillFile,
            skillName: "second",
            skillSource: "workspace",
          },
        ],
      },
    });

    expect(hasRunWorkspaceSkillUsage({ runId, name: "first", skillFile: firstSkillFile })).toBe(
      false,
    );
    expect(hasRunWorkspaceSkillUsage({ runId, name: "second", skillFile: secondSkillFile })).toBe(
      false,
    );
    expect(consumeRunSkillUsage(runId)).toEqual([]);
  });

  it("lets only the explicitly selected skill cross the Workshop write boundary", async () => {
    await withTempDir("openclaw-run-skill-repair-", async (rootDir) => {
      const testState = await createOpenClawTestState({
        layout: "state-only",
        prefix: "openclaw-run-skill-repair-state-",
      });
      try {
        const workspaceDir = path.join(rootDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        const selectedName = "selected-repair";
        const unselectedName = "unselected-repair";
        for (const [name, token] of [
          [selectedName, "OLD_SELECTED"],
          [unselectedName, "OLD_UNSELECTED"],
        ] as const) {
          const proposal = await proposeCreateSkill({
            workspaceDir,
            env: testState.env,
            name,
            description: `${name} proof fixture`,
            content: `# ${name}\n\nKeep ${token} guidance.\n`,
          });
          await applySkillProposal({
            workspaceDir,
            env: testState.env,
            proposalId: proposal.record.id,
            expectedRevisionHash: proposal.revisionHash,
          });
        }

        const entries = loadWorkspaceSkills(workspaceDir, {
          managedSkillsDir: path.join(rootDir, "managed"),
          bundledSkillsDir: "",
          pluginSkillsDir: path.join(rootDir, "plugins"),
        });
        const snapshot = buildSkillSnapshot(workspaceDir, { entries });
        const selected = buildWorkspaceSkillCommandSpecs(workspaceDir, { entries }).find(
          (command) => command.skillName === selectedName,
        );
        expect(selected?.skillFile).toBeTruthy();

        const runId = "explicit-selection-final-effect";
        recordExplicitSkillSelectionsForRun({
          runId,
          selections: selected?.skillFile
            ? [{ name: selected.name, path: selected.skillFile }]
            : [],
          skillsSnapshot: snapshot,
        });

        const tool = createSkillWorkshopTool({
          workspaceDir,
          env: testState.env,
          config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
          agentId: "main",
          origin: { agentId: "main", runId },
        });
        await tool.execute("prepare-selected", {
          action: "prepare_patch",
          skill_name: selectedName,
          old_string: "Keep OLD_SELECTED guidance.",
        });
        await expect(
          tool.execute("patch-selected", {
            action: "patch",
            skill_name: selectedName,
            old_string: "Keep OLD_SELECTED guidance.",
            new_string: "Keep NEW_SELECTED guidance.",
          }),
        ).resolves.toMatchObject({ details: { status: "applied" } });

        await tool.execute("prepare-unselected", {
          action: "prepare_patch",
          skill_name: unselectedName,
          old_string: "Keep OLD_UNSELECTED guidance.",
        });
        await expect(
          tool.execute("patch-unselected", {
            action: "patch",
            skill_name: unselectedName,
            old_string: "Keep OLD_UNSELECTED guidance.",
            new_string: "Keep NEW_UNSELECTED guidance.",
          }),
        ).rejects.toThrow(`skill "${unselectedName}" was not used in this run`);

        await expect(
          fs.readFile(path.join(workspaceDir, "skills", selectedName, "SKILL.md"), "utf8"),
        ).resolves.toContain("Keep NEW_SELECTED guidance.");
        await expect(
          fs.readFile(path.join(workspaceDir, "skills", unselectedName, "SKILL.md"), "utf8"),
        ).resolves.toContain("Keep OLD_UNSELECTED guidance.");
        consumeRunSkillUsage(runId);
      } finally {
        await testState.cleanup();
      }
    });
  });
});
