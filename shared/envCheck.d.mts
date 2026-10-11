export function envValueProblem(value: string | null | undefined): string | null;
export function firstEnvProblem(
  entries: [name: string, value: string | null | undefined][],
  opts?: { allowEmpty?: boolean },
): { name: string; problem: string } | null;
