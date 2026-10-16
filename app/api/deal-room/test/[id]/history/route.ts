import { testModeApi } from "@/features/investment-os/server/test-mode-api";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){return testModeApi(request,"history",(await params).id);}
