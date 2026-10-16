import { testModeApi } from "@/features/investment-os/server/test-mode-api";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){return testModeApi(request,"deal",(await params).id);}
export async function PUT(request:Request,{params}:Context){return testModeApi(request,"deal",(await params).id);}
