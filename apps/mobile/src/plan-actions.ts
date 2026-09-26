export type CanonicalPlanAction =
  | "execute"
  | "modify"
  | "continue"
  | "refine"
  | "rollback"
  | "exit-plan"
  | "close";

export function normalizePlanAction(action: string): CanonicalPlanAction | string {
  switch (action) {
    case "accept":
      return "execute";
    case "edit":
      return "modify";
    case "discuss":
    case "continue_discussion":
    case "continue-discussion":
      return "continue";
    case "reject":
    case "exit_plan":
      return "exit-plan";
    default:
      return action;
  }
}
