import { testModeApi } from "@/features/investment-os/server/test-mode-api";
export const GET=(request:Request)=>testModeApi(request,"catalog");
export const POST=(request:Request)=>testModeApi(request,"catalog");
