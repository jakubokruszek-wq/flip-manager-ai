/** CI-only legacy data-isolation regression; not an application route. */
import { testModeApi } from "./test-mode-api";
type C={params:Promise<{id:string}>};
export const GET=(r:Request)=>testModeApi(r,"catalog");export const POST=(r:Request)=>testModeApi(r,"catalog");
export const deal={GET:async(r:Request,c:C)=>testModeApi(r,"deal",(await c.params).id),PUT:async(r:Request,c:C)=>testModeApi(r,"deal",(await c.params).id)};
export const answers={GET:async(r:Request,c:C)=>testModeApi(r,"answers",(await c.params).id),POST:async(r:Request,c:C)=>testModeApi(r,"answers",(await c.params).id)};
export const initialize={POST:async(r:Request,c:C)=>testModeApi(r,"initialize",(await c.params).id)};
export const history={GET:async(r:Request,c:C)=>testModeApi(r,"history",(await c.params).id)};
