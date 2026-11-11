import { parseMoney } from "./model";
function validNip(value: string) {
  const digits=value.replace(/\D/g,"");const weights=[6,5,7,2,3,4,5,6,7];
  return digits.length===10&&weights.reduce((sum,w,i)=>sum+w*Number(digits[i]),0)%11===Number(digits[9]);
}
export function invoiceDate(value:string):string {
  const match=value.match(/\b(\d{4})[./-](\d{2})[./-](\d{2})\b/)??value.match(/\b(\d{2})[./-](\d{2})[./-](\d{4})\b/);
  if(!match)return "";const [y,m,d]=match[1].length===4?[match[1],match[2],match[3]]:[match[3],match[2],match[1]];
  const date=new Date(`${y}-${m}-${d}T00:00:00Z`);return Number.isNaN(date.valueOf())||date.getUTCFullYear()!==Number(y)||date.getUTCMonth()+1!==Number(m)||date.getUTCDate()!==Number(d)?"":`${y}-${m}-${d}`;
}
export function invoiceAmount(value:string):number|null {
  const normalized=value.replace(/[\u00a0\u202f]/g," ").trim();if(!/^(?:\d{1,3}(?:[ .]\d{3})+|\d+)(?:[,.]\d{2})?$/.test(normalized))return null;
  const separator=normalized.match(/[,.]\d{2}$/)?.index;
  const full=separator===undefined?normalized.replace(/[ .]/g,""):normalized.slice(0,separator).replace(/[ .]/g,"")+"."+normalized.slice(separator+1);
  try{return parseMoney(full);}catch{return null;}
}
export function invoiceAmountTokens(line:string):number[] { return amounts(line).map(invoiceAmount).filter((v):v is number=>v!==null); }
function amounts(line:string):string[] {
  const decimals=line.match(/(?<![\d,.])(?:\d{1,3}(?:[ .]\d{3})+|\d+)[,.]\d{2}(?!\d)/g)??[];
  if(decimals.length)return decimals;
  return line.match(/\b\d+(?:[ .]\d{3})*(?=\s*(?:PLN|zł)\b)/gi)??(/^\s*\d+\s*$/.test(line)?[line.trim()]:[]);
}
const gross=/(?:razem|suma|warto[śs][ćc]|og[oó]łem|[łl][ąa]czn[aey]\s*(?:kwota|warto[śs][ćc])?)\s*(?:do\s*zap[łl]aty\s*)?brutto|brutto\s*(?:razem|og[oó]łem)/i;
const payable=/(?:do\s*zap[łl]aty|kwota\s*(?:og[oó]łem|nale[żz]no[śs][ćc])|og[oó]łem\s*(?:PLN|zł|:)|suma\s*(?:PLN|zł)|^razem\s*(?::|(?=\d)))/i;
function totalAt(lines:string[],index:number,label:RegExp):number|null {
  const rest=lines[index].replace(label,"").replace(/^[\s:=-]+/,"");
  for(const line of [rest,...lines.slice(index+1,index+3)]){
    if(/\b(?:EUR|USD|GBP|CHF)\b|[€$£]/i.test(line))return null;
    const values=amounts(line);if(values.length)return values.length===1?invoiceAmount(values[0]):null;
    if(/\b(?:netto|VAT|NIP|faktura|data|termin|nabywca|sprzedawca)\b/i.test(line))break;
  }
  return null;
}
function tableTotals(lines:string[]):number[] {
  const totals:number[]=[];
  for(let i=0;i<lines.length;i++) {
    if(!/^(?:warto[śs][ćc]\s+)?netto\s+(?:kwota\s+)?VAT\s+(?:warto[śs][ćc]\s+)?brutto\s*$/i.test(lines[i]))continue;
    for(const row of lines.slice(i+1,i+4)) {
      if(!/^(?:razem|suma|og[oó][łl]em)\b/i.test(row)||/[€$£]|\b(?:EUR|USD|GBP|CHF)\b/i.test(row))continue;
      const values=invoiceAmountTokens(row);
      if(values.length===3&&Math.abs(values[0]+values[1]-values[2])<=2)totals.push(values[2]);
    }
  }
  return totals;
}
export function invoiceDraft(text:string) {
  const normalized=text.replace(/[\u00a0\u202f]/g," ").replace(/[–−]/g,"-");const lines=normalized.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
  let amount:number|null=null;
  const strong=lines.map((line,i)=>gross.test(line)?i:-1).filter(i=>i>=0);
  const weak=lines.map((line,i)=>payable.test(line)&&!/pozosta[łl]/i.test(line)?i:-1).filter(i=>i>=0);
  const candidates=(strong.length?strong:weak).map(i=>totalAt(lines,i,strong.length?gross:payable));
  const known=[...new Set([...candidates.filter((v):v is number=>v!==null),...tableTotals(lines)])];if(known.length===1)amount=known[0];
  const number=normalized.match(/(?:faktura(?:\s+vat)?(?:\s+(?:nr|numer))?|(?:nr|numer)\s*faktury)\s*[:.#-]?\s*(?!VAT\b)([\p{L}\d][\p{L}\d/_.-]*\d[\p{L}\d/_.-]*|\d)/iu)?.[1]??"";
  const dateMatch=normalized.match(/(?:data\s*(?:wystawienia|faktury)|wystawiono(?:\s*dnia)?)\s*[:.-]?\s*([^\n]{0,30})/i)?.[1]??"";
  const sellerStart=lines.findIndex(line=>/sprzedawc[ay]|wystawca|dostawca/i.test(line));
  const seller=sellerStart>=0?lines.slice(sellerStart,Math.min(lines.length,sellerStart+8)).join("\n").split(/nabywca|kupuj[ąa]cy|odbiorca|data\s|faktura\s|razem\s/i)[0]:normalized.split(/nabywca|kupuj[ąa]cy/i)[0];
  const nip=seller.match(/\bNIP\s*[:\s]*([\d][\d -]{8,15}[\d])/i)?.[1]?.trim()??"";
  const name=sellerStart<0?"":seller.split("\n").map(v=>v.replace(/^.*?(?:sprzedawc[ay]|wystawca|dostawca)\s*:?\s*/i,"").trim()).find(v=>v&&!/^(?:NIP|REGON|KRS|tel|www|https?|ul\.|\d)/i.test(v))??"";
  const supplier=[name,validNip(nip)?`NIP ${nip.replace(/\D/g,"")}`:""].filter(Boolean).join(" · ").slice(0,300);
  return {invoiceNumber:/^\d{4}[-./]\d{2}[-./]\d{2}$/.test(number)?"":number.slice(0,150),date:invoiceDate(dateMatch),amount,supplier};
}
