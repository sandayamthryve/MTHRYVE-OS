import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass, Badge } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { CancelLeave, DecideLeave, NewLeaveRequest } from "@/components/leave/LeaveControls";

export const dynamic = "force-dynamic";

type LeaveRow = {
  id: string;
  employee_id: string;
  employee_name: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  duration_days: number;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  created_at: string;
  approver_name?: string;
};

type LeaveBalance = {
  leave_type: string;
  total_entitlement: number;
  used: number;
  remaining: number;
};

async function loadLeaveData(orgId: string, profileId: string, isManagement: boolean) {
  const supabase = createServerSupabaseClient();
  
  let query = supabase
    .from("leave_requests")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (!isManagement) {
    query = query.eq("employee_id", profileId);
  }

  const { data: requests } = await query.limit(500);
  
  const { data: balance } = await supabase
    .from("leave_balances")
    .select("*")
    .eq("org_id", orgId)
    .eq("employee_id", profileId);

  return {
    requests: (requests ?? []) as LeaveRow[],
    balance: (balance ?? []) as LeaveBalance[],
  };
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: LeaveRow["status"] }) {
  const variants: Record<LeaveRow["status"], "success" | "warning" | "destructive" | "muted"> = {
    approved: "success",
    pending: "warning",
    rejected: "destructive",
    cancelled: "muted",
  };
  return <Badge tone={variants[status]}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}

export default async function LeaveManagementPage() {
  const profile = await requireProfile();
  const isManagement = ["ceo", "coo", "department_head"].includes(profile.role);
  const { requests, balance } = await loadLeaveData(profile.org_id, profile.id, isManagement);

  const pendingCount = requests.filter((r) => r.status === "pending").length;
  const myPendingCount = requests.filter((r) => r.status === "pending" && r.employee_id === profile.id).length;

  return (
    <AppShell breadcrumb={["People", "Leave Management"]} profile={profile}>
      {/* The action was a link to /leave/new, a route that never existed.
          Filing now happens inline, so the form is where the list is. */}
      <PageHeader
        title={isManagement ? "Leave Management" : "My Leave"}
        subtitle={isManagement
          ? `Team overview · ${pendingCount} pending approval${pendingCount !== 1 ? "s" : ""}`
          : `Your leave balance & history · ${myPendingCount} pending request${myPendingCount !== 1 ? "s" : ""}`}
        action={<NewLeaveRequest />}
      />

      {/* Leave Balance */}
      {balance.length > 0 && (
        <SectionCard title="Leave Balance" className="mb-6">
          <TableShell columns={["Type", "Entitlement", "Used", "Remaining"]}>
            {balance.map((b) => (
              <tr key={b.leave_type} className={rowClass}>
                <td className="p-3 text-ink">{b.leave_type}</td>
                <td className="p-3 text-ink-muted">{b.total_entitlement} days</td>
                <td className="p-3 text-ink-muted">{b.used} days</td>
                <td className="p-3 font-medium text-ink">{b.remaining} days</td>
              </tr>
            ))}
          </TableShell>
        </SectionCard>
      )}

      {/* Leave Requests Table */}
      <SectionCard title={isManagement ? "All Leave Requests" : "My Leave History"}>
        {requests.length === 0 ? (
          <p className="text-sm text-ink-muted text-center py-8">
            {isManagement ? "No leave requests found." : "No leave requests yet. Create your first request above."}
          </p>
        ) : (
          <TableShell
            columns={[
              "Employee",
              "Type",
              "Period",
              "Duration",
              "Reason",
              "Status",
              "Filed",
              isManagement ? "Approver" : null,
              "",
            ].filter(Boolean) as string[]}
          >
            {requests.map((r) => (
              <tr key={r.id} className={rowClass}>
                <td className="p-3 font-medium text-ink">{r.employee_name}</td>
                <td className="p-3 text-ink-muted">{r.leave_type}</td>
                <td className="p-3 text-ink-muted">
                  {formatDate(r.start_date)} – {formatDate(r.end_date)}
                </td>
                <td className="p-3 font-mono text-sm text-ink">{r.duration_days} day{r.duration_days !== 1 ? "s" : ""}</td>
                <td className="p-3 text-ink-muted truncate max-w-[200px]">{r.reason}</td>
                <td className="p-3"><StatusBadge status={r.status} /></td>
                <td className="p-3 text-ink-dim font-mono text-xs">{formatDate(r.created_at)}</td>
                {isManagement && (
                  <td className="p-3 text-ink-dim">{r.approver_name ?? "—"}</td>
                )}
                <td className="p-3">
                  {/* Deciding is leadership-only and never your own; withdrawing
                      is yours and only while pending. Both mirror the RLS
                      policies, so no control is rendered that the policy would
                      reject. */}
                  {r.status !== "pending" ? null
                    : isManagement && r.employee_id !== profile.id ? <DecideLeave requestId={r.id} />
                    : r.employee_id === profile.id ? <CancelLeave requestId={r.id} />
                    : null}
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>

      {/* A "Quick Actions" card used to sit here with Approve Selected / Reject
          Selected buttons that had no handler, and a link to /leave/approvals,
          a route that does not exist. Deciding now happens per row, against the
          request being decided, so there is nothing left for it to do. */}
    </AppShell>
  );
}