import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, Card, SectionCard, Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface EmployeeDetailProps {
  params: Promise<{ id: string }>;
}

type EmployeeRow = {
  id: string;
  full_name: string;
  email: string;
  phone?: string;
  department_id: string;
  department_name: string;
  position: string;
  employment_status: "active" | "probation" | "inactive" | "terminated";
  hire_date: string;
  employee_number?: string;
  employment_type?: string;
  manager_id?: string;
  manager_name?: string;
  address?: string;
  emergency_contact?: string;
  emergency_phone?: string;
  sss_number?: string;
  philhealth_number?: string;
  pagibig_number?: string;
  tin?: string;
  bank_account?: string;
  bank_name?: string;
  created_at: string;
  updated_at: string;
};

async function loadEmployee(orgId: string, employeeId: string) {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("employees")
    .select(`
      *,
      department:departments!department_id(name),
      manager:profiles!manager_id(full_name)
    `)
    .eq("org_id", orgId)
    .eq("id", employeeId)
    .single();
  return data as EmployeeRow | null;
}

function formatDate(dateStr?: string) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });
}

function StatusBadge({ status }: { status: EmployeeRow["employment_status"] }) {
  const variants: Record<EmployeeRow["employment_status"], "success" | "warning" | "muted" | "destructive"> = {
    active: "success",
    probation: "warning",
    inactive: "muted",
    terminated: "destructive",
  };
  return <Badge tone={variants[status]}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}

function DetailRow({ label, value, empty = "—" }: { label: string; value?: string | null; empty?: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 py-2 border-t border-charcoal-700/50">
      <span className="shrink-0 w-full sm:w-48 font-medium text-ink-muted text-sm">{label}</span>
      <span className="text-ink text-sm truncate">{value ?? empty}</span>
    </div>
  );
}

export default async function EmployeeDetailPage({ params }: EmployeeDetailProps) {
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const { id } = await params;
  const employee = await loadEmployee(profile.org_id, id);

  if (!employee) notFound();

  return (
    <AppShell breadcrumb={["People", "Employee Management", employee.full_name]} profile={profile}>
      <PageHeader
        title={employee.full_name}
        subtitle={
          <>
            <span className="mr-3">{employee.position}</span>
            <span className="mr-3">·</span>
            <span className="mr-3">{employee.department_name}</span>
            <span className="mr-3">·</span>
            <StatusBadge status={employee.employment_status} />
          </>
        }
        action={
          <div className="flex items-center gap-2">
            <a href={`/employee/${id}/edit`} className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Edit Profile
            </a>
            <a href={`/leave?employee=${id}`} className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Leave History
            </a>
            <a href={`/performance?employee=${id}`} className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Performance
            </a>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Personal Information */}
        <SectionCard title="Personal Information" className="lg:col-span-2">
          <div className="space-y-1">
            <DetailRow label="Employee Number" value={employee.employee_number} />
            <DetailRow label="Email" value={employee.email} />
            <DetailRow label="Phone" value={employee.phone} />
            <DetailRow label="Address" value={employee.address} />
            <DetailRow label="Hire Date" value={formatDate(employee.hire_date)} />
            <DetailRow label="Employment Type" value={employee.employment_type} />
          </div>
        </SectionCard>

        {/* Employment Details */}
        <SectionCard title="Employment Details">
          <div className="space-y-1">
            <DetailRow label="Department" value={employee.department_name} />
            <DetailRow label="Position / Role" value={employee.position} />
            <DetailRow label="Reports To" value={employee.manager_name} />
            <DetailRow label="Employment Status" value={employee.employment_status} />
          </div>
        </SectionCard>

        {/* Contact Information */}
        <SectionCard title="Contact Information" className="lg:col-span-2">
          <div className="space-y-1">
            <DetailRow label="Personal Email" value={employee.email} />
            <DetailRow label="Mobile" value={employee.phone} />
            <DetailRow label="Emergency Contact" value={employee.emergency_contact} />
            <DetailRow label="Emergency Phone" value={employee.emergency_phone} />
          </div>
        </SectionCard>

        {/* Government IDs */}
        <SectionCard title="Government Records">
          <div className="space-y-1">
            <DetailRow label="SSS Number" value={employee.sss_number} />
            <DetailRow label="PhilHealth Number" value={employee.philhealth_number} />
            <DetailRow label="Pag-IBIG Number" value={employee.pagibig_number} />
            <DetailRow label="TIN" value={employee.tin} />
          </div>
        </SectionCard>

        {/* Bank Details */}
        <SectionCard title="Bank Details">
          <div className="space-y-1">
            <DetailRow label="Bank Name" value={employee.bank_name} />
            <DetailRow label="Account Number" value={employee.bank_account} />
          </div>
        </SectionCard>

        {/* HR Records / Audit Trail */}
        <SectionCard title="HR Records & Audit" className="lg:col-span-3">
          <div className="space-y-1">
            <DetailRow label="Record Created" value={formatDate(employee.created_at)} />
            <DetailRow label="Last Updated" value={formatDate(employee.updated_at)} />
          </div>
          <p className="text-xs text-ink-dim mt-3">
            Full audit trail available in Audit Feed. Changes to employee records are logged with user, timestamp, and field-level diffs.
          </p>
        </SectionCard>
      </div>
    </AppShell>
  );
}