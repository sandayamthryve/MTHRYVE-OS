import { redirect } from "next/navigation";

// /analytics has no landing of its own — Data Analytics is per-department. Send
// to E-Commerce, the flagship dashboard.
export default function AnalyticsIndex() {
  redirect("/analytics/ecommerce");
}
