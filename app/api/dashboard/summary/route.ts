import { getDashboardSummary } from "@/features/dashboard/server/get-dashboard-summary";

export async function GET() {
  try {
    return Response.json(await getDashboardSummary());
  } catch (error) {
    console.error("DASHBOARD SUMMARY ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się pobrać podsumowania dashboardu." }, { status: 500 });
  }
}
