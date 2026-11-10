import { readWorkspace } from "./server";
import { WorkspaceEditor } from "./workspace-editor";
export async function WorkspacePage({ id }: { id: string }) {
  const initial = await readWorkspace(id);
  return <WorkspaceEditor initial={initial} />;
}
