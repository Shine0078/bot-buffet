/**
 * Build the system message for a run.
 *
 * `skills` was declared on every profile and used nowhere, so an agent never
 * learned that its own skills existed. They are listed here by name only —
 * progressive disclosure: the agent is told what is available and can read the
 * detail through its file tools when it decides a skill is relevant, rather
 * than having every skill's full text occupy the context budget on every step.
 */
export function buildSystemPrompt(profile: {
  systemInstructions: string;
  projectRules: string[];
  skills: string[];
}): string {
  const sections = [profile.systemInstructions];
  if (profile.projectRules.length) {
    sections.push(`Project rules:\n${profile.projectRules.map((rule) => `- ${rule}`).join('\n')}`);
  }
  if (profile.skills.length) {
    sections.push(
      `Available skills (read the referenced material before relying on one):\n${profile.skills
        .map((skill) => `- ${skill}`)
        .join('\n')}`,
    );
  }
  return sections.join('\n\n');
}
