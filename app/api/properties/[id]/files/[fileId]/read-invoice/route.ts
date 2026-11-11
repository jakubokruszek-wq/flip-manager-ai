import { requireOperator, OperatorAuthorizationError, operatorAuthorizationResponse } from "@/features/auth/operator";
import { workspaceAccess, UUID } from "@/features/property-workspace/server";
import { PRIVATE_BUCKET, MAX_FILE_SIZE } from "@/features/property-workspace/files";
import { readInvoiceAi } from "@/features/property-workspace/invoice-ai";
export const maxDuration=90;
export async function POST(request: Request,{params}:{params:Promise<{id:string;fileId:string}>}) {
 try {
  const actor=await requireOperator();const {id,fileId}=await params;if(!UUID.test(fileId))return new Response(null,{status:404});
  const {db,operator}=await workspaceAccess(id,actor);
  const file=await db.from("property_workspace_files").select("path,mime,size").eq("property_id",id).eq("owner_id",operator.id).eq("id",fileId).maybeSingle();
  if(file.error||!file.data)return Response.json({message:"Nie znaleziono dokumentu."},{status:404});
  if(!["application/pdf","image/jpeg","image/png","image/webp"].includes(file.data.mime)||file.data.size>MAX_FILE_SIZE)return Response.json({message:"Wybierz zdjęcie lub PDF do 12 MB."},{status:422});
  const key=process.env.OPENAI_API_KEY;if(!key)return Response.json({message:"Odczyt AI nie jest skonfigurowany. Dla zdjęć możesz użyć OCR lub wpisać dane ręcznie."},{status:503});
  const stored=await db.storage.from(PRIVATE_BUCKET).download(file.data.path);if(stored.error||!stored.data||stored.data.size>MAX_FILE_SIZE)throw new Error("Nie udało się pobrać dokumentu.");
  const result=await readInvoiceAi(new Uint8Array(await stored.data.arrayBuffer()),key,request.signal);
  return Response.json(result,{headers:{"Cache-Control":"no-store"}});
 }catch(error){
  if(error instanceof OperatorAuthorizationError)return operatorAuthorizationResponse(error);
  console.error("invoice_read_failed");return Response.json({message:"Nie udało się odczytać dokumentu. Zapisany plik pozostaje bez zmian; możesz wpisać dane ręcznie."},{status:502,headers:{"Cache-Control":"no-store"}});
 }
}
