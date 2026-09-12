import type { DealPlaybook } from "../types";
import { ContentList } from "./investment-ui";

export function PlaybookPanel({ playbook }: { playbook: DealPlaybook }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <ContentList title="Przed telefonem" values={playbook.beforeCall} />
    <ContentList title="Pytania do sprzedającego" values={playbook.sellerQuestions} />
    <ContentList title="Checklista oględzin" values={playbook.viewingChecklist} />
    <ContentList title="Plan negocjacji" values={playbook.negotiationPlan} />
    <ContentList title="Wymagane dokumenty" values={playbook.documentsRequired} />
    <ContentList title="Warunki przed zakupem" values={playbook.conditionsBeforePurchase} />
  </div>;
}
