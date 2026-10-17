import { notFound } from "next/navigation";
import { InvestmentDesk } from "@/features/investment-os/components/investment-desk";
import { isTestListingId } from "@/features/investment-os/test-identity";
export const metadata = { title: "Pokój transakcji · Flip Manager" };
export default async function DealRoomPage({params}:{params:Promise<{listingId:string}>}) {
 const {listingId}=await params;if(isTestListingId(listingId))notFound();
 return <InvestmentDesk result={{id:listingId}} room />;
}
