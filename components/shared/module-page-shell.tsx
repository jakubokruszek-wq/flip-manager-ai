import { PageHeader } from "@/components/ui/page-header";

type ModulePageShellProps = {
  title: string;
};

export function ModulePageShell({ title }: ModulePageShellProps) {
  return (
    <div>
      <PageHeader title={title} />
    </div>
  );
}
