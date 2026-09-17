"use client";

// Confirm-guarded submit for deleting a product-master row. The enclosing <form>
// and its hidden id live in the server component; this is only the button so it
// can intercept the click with a window.confirm before the form submits.

export function DeleteProductButton() {
  return (
    <button
      type="submit"
      aria-label="Delete product"
      onClick={(e) => {
        if (!window.confirm("Delete this product from the master? This can't be undone.")) {
          e.preventDefault();
        }
      }}
      className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-red-300 hover:bg-charcoal-700"
    >
      Delete
    </button>
  );
}
