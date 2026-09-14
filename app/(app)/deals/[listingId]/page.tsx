import { InvestmentDesk } from "@/features/investment-os/components/investment-desk";

export const metadata = { title: "Pokój transakcji · Flip Manager" };

export default async function DealRoomPage({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  return <InvestmentDesk result={{ id: listingId }} room />;
}
