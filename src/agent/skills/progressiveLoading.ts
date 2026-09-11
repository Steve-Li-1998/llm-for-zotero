import { sha256Text } from "../store/journalRecoveryBlobStore";
import { getSkillCustomizationNotice } from "./managedBlock";
import type {
  AgentSkill,
  SkillActivationMode,
  SkillContextKind,
} from "./skillLoader";
import type { LoadedSkill, SkillInventoryEntry } from "./loadingTypes";

export type {
  LoadedSkill,
  LoadedSkillRecord,
  SkillInventoryEntry,
} from "./loadingTypes";

/**
 * Metadata safe to include in the first agent request. Full instruction bodies
 * remain behind `load_skill` until the main agent needs one.
 */
export function buildSkillInventory(
  skills: ReadonlyArray<AgentSkill>,
): SkillInventoryEntry[] {
  return skills
    .map((skill) => ({
      id: skill.id,
      name: skill.name?.trim() || skill.id,
      description: skill.description,
      version: skill.version,
      contexts: [...skill.contexts],
      activation: skill.activation,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function fingerprintSkillInstruction(
  instruction: string,
): Promise<string> {
  return `sha256:${await sha256Text(instruction)}`;
}

/** Load one installed skill without semantic routing or another model call. */
export async function loadSkill(
  skill: AgentSkill,
  shippedInstruction?: string,
): Promise<LoadedSkill> {
  return {
    skill: buildSkillInventory([skill])[0],
    customizationNotice: getSkillCustomizationNotice(skill.instruction, {
      source: skill.source,
      shippedInstruction,
    }),
    instructions: skill.instruction,
    loadedSkill: {
      id: skill.id,
      version: skill.version,
      instructionFingerprint: await fingerprintSkillInstruction(
        skill.instruction,
      ),
      source: "loaded",
    },
  };
}
