/**
 * The address a proof will actually request.
 *
 * A scope expression may name a subtree; a step that will be executed may not.
 * Turning one into the other is the only thing left of the old plan builder:
 * a plan now comes from the skill's own check rather than from a branch that
 * knew what each methodology meant.
 */
export function concreteUrl(expression: string): string {
  return expression.replace(/\*$/, "")
}
