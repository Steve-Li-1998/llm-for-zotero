import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  getAllSkills,
  getBuiltinSkillInstructionById,
  loadSkill,
} from "../../skills";
import type { AgentSkill, LoadedSkill } from "../../skills";
import type { AgentToolDefinition } from "../../types";
import { fail, ok, validateObject } from "../shared";

export type LoadSkillInput = { id: string };

export type LoadSkillResult =
  | ({ found: true } & LoadedSkill)
  | {
      found: false;
      error: string;
      availableSkillIds: string[];
    };

export type LoadSkillToolOptions = {
  getSkills?: () => ReadonlyArray<AgentSkill>;
  getShippedInstruction?: (id: string) => string | undefined;
};

/**
 * Read one installed skill into the active agent workflow. The initial prompt
 * can carry only the metadata inventory; this tool returns the exact body and
 * its stable identity without invoking another model.
 */
export function createLoadSkillTool(
  options: LoadSkillToolOptions = {},
): AgentToolDefinition<LoadSkillInput, LoadSkillResult> {
  const getSkills = options.getSkills || getAllSkills;
  const getShippedInstruction =
    options.getShippedInstruction || getBuiltinSkillInstructionById;
  return {
    spec: {
      name: "load_skill",
      description:
        "Load the full instructions for one installed skill by exact ID. Use this when a skill in the supplied inventory matches the current work and its workflow guidance is needed. Loading guidance does not authorize actions or override the user's current request.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "Exact ID from the installed skill inventory.",
          },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
      requiresConfirmation: false,
    },
    validate(args) {
      if (
        !validateObject<Record<string, unknown>>(args) ||
        Object.keys(args).some((key) => key !== "id") ||
        typeof args.id !== "string" ||
        !args.id.trim()
      ) {
        return fail("id must be a non-empty installed skill ID");
      }
      return ok({ id: args.id.trim() });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason: "Skill loading reads host-owned in-memory guidance.",
      }),
    async execute(input, context) {
      const skills = getSkills();
      const skill = skills.find((candidate) => candidate.id === input.id);
      if (!skill) {
        return {
          found: false,
          error: `Skill "${input.id}" is not installed.`,
          availableSkillIds: skills
            .map((candidate) => candidate.id)
            .sort((left, right) => left.localeCompare(right)),
        };
      }
      const loaded = await loadSkill(skill, getShippedInstruction(skill.id));
      if (context?.request) {
        const records = context.request.loadedSkillRecords || [];
        context.request.loadedSkillRecords = [
          ...records.filter((record) => record.id !== loaded.loadedSkill.id),
          loaded.loadedSkill,
        ];
      }
      return {
        found: true,
        ...loaded,
      };
    },
  };
}
