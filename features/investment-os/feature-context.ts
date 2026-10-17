/** Internal request-scoped switches; never accepted from a client payload. */
export type DealFeatures = Readonly<{cfo:boolean;taxReview:boolean;taxArithmetic:boolean;privateTax:boolean;jdgTax:boolean}>;
export function dealFeatures(): DealFeatures {
 return {cfo:process.env.DEAL_ROOM_CFO_ENABLED==="true",taxReview:process.env.DEAL_ROOM_TAX_REVIEW_ENABLED==="true",taxArithmetic:process.env.DEAL_ROOM_TAX_ARITHMETIC_ENABLED==="true",privateTax:process.env.DEAL_ROOM_PRIVATE_TAX_ENABLED==="true",jdgTax:process.env.DEAL_ROOM_JDG_TAX_ENABLED==="true"};
}
