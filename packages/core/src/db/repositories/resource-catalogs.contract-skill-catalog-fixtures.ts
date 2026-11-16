export const noWrite = () => Promise.resolve(undefined);

export const skillCheckViolation = (constraint: string) => ({
  cause: { code: '23514', constraint },
});

export type SkillWrite = ReturnType<typeof skillInput>;

export const skillInput = (name: string, ownerPrincipalId: string) => ({
  name,
  skillMd: `# ${name}`,
  enabled: true,
  ownerPrincipalId,
});
