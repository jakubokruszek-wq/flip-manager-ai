import { runFacebookWatchJob } from "@/features/facebook-groups/watch-job";
import { authorizeFacebookWatchRequest } from "@/features/auth/github-actions-oidc";
export const runtime="nodejs";
export async function POST(request:Request){if(!process.env.CRON_SECRET&&!request.headers.get("authorization"))return Response.json({error:"Brak CRON_SECRET w konfiguracji serwera."},{status:503});if(!await authorizeFacebookWatchRequest(request))return Response.json({error:"Unauthorized"},{status:401});return Response.json(await runFacebookWatchJob());}
export const GET=POST;
