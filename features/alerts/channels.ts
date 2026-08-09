import type { InvestmentAlert } from "./types";
export type AlertDeliveryChannel="web_push"|"email"|"telegram";
export interface AlertDeliveryAdapter { readonly channel:AlertDeliveryChannel; deliver(alert:InvestmentAlert):Promise<{delivered:boolean;reason?:string}>; }
export const disabledAlertDeliveryAdapters:AlertDeliveryAdapter[]=[];
