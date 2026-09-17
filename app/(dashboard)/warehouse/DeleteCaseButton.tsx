"use client";

// Confirm-guarded submit for deleting a return case.

interface DeleteCaseButtonProps {
  caseId?: string;
  onDelete?: (formData: FormData) => Promise<void>;
  action?: (formData: FormData) => Promise<void>;
}

export function DeleteCaseButton({ caseId, onDelete, action }: DeleteCaseButtonProps) {
  return (
    <button
      type="submit"
      aria-label="Delete case"
      onClick={(e) => {
        if (!window.confirm("Delete this return case? This can't be undone.")) {
          e.preventDefault();
        }
      }}
      className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-red-300 hover:bg-charcoal-700"
    >
      Delete
    </button>
  );
}
