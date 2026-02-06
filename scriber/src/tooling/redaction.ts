export interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

export const redactValue = (
  value: string | undefined,
  isPassword: boolean | undefined,
  rules: RedactionRule[]
) => {
  if (value === undefined) {
    return undefined;
  }
  if (isPassword) {
    return "********";
  }
  return rules.reduce(
    (current, rule) => current.replace(rule.pattern, rule.replacement),
    value
  );
};
