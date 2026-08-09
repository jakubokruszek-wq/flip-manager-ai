import { runFacebookWatchJob } from "@/features/facebook-groups/watch-job";
export const runtime="nodejs";
export async function POST(request:Request){const secret=process.env.CRON_SECRET;if(!secret)return Response.json({error:"Brak CRON_SECRET w konfiguracji serwera."},{status:503});const supplied=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??request.headers.get("x-cron-secret");if(supplied!==secret)return Response.json({error:"Unauthorized"},{status:401});return Response.json(await runFacebookWatchJob());}
export const GET=POST;
