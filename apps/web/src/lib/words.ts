import { type Action, GROUP_TITLES, type Group, type Permission } from "@aipass/shared";

/** How a permission reads to the person it's about. */
export function permissionSentence(p: Permission): string {
  const [g, a] = p.split(":") as [Group, Action];
  const what = GROUP_TITLES[g].toLowerCase();
  if (a === "propose") return `suggest new ${what} for you to approve`;
  if (a === "write") return `change your ${what}`;
  return `see your ${what}`;
}
