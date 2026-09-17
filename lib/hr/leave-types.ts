// Leave types, kept OUT of the actions module on purpose.
//
// A "use server" file may only export async functions: everything else is not a
// server action, so React does not give it to the client and the import arrives
// undefined. Exporting this list from actions.ts made the form crash with
// "LEAVE_TYPES.map is not a function" the moment it opened. It lives here so
// both the action and the form can import the same source.
export const LEAVE_TYPES = [
  "Vacation",
  "Sick",
  "Emergency",
  "Bereavement",
  "Maternity / Paternity",
  "Unpaid",
] as const;

export type LeaveType = (typeof LEAVE_TYPES)[number];
