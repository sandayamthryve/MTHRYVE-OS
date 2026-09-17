import { redirect } from "next/navigation";

// The standalone Creative Studio surface has been unified into the new
// /creative-studio workspace (Plan / Produce / Library / Performance tabs).
// This route redirects there so any existing links / bookmarks keep working.
export const dynamic = "force-dynamic";

export default function ContentStudioRedirect() {
  redirect("/creative-studio");
}
