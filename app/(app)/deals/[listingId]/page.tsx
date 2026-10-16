import { InvestmentDesk } from "@/features/investment-os/components/investment-desk";

export const metadata = { title: "Pokój transakcji · Flip Manager" };

export default async function DealRoomPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  return <>{listingId.startsWith("deadbeef-") ? <p role="status" className="border border-amber-500 p-3">TEST · wyłącznie syntetyczne dane · wyniki warunkowe</p> : null}<InvestmentDesk result={{ id: listingId }} room /></>;
}
