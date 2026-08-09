import { navigationSections } from "@/config/navigation";

import { Logo } from "@/components/ui/logo";
import { SidebarNavItem } from "@/components/layout/sidebar-nav-item";

type SidebarProps = {
  onNavigate?: () => void;
};

export function Sidebar({ onNavigate }: SidebarProps) {
  return (
    <aside className="flex h-full w-full flex-col border-r border-border/80 bg-surface/90 backdrop-blur-xl">
      <div className="flex h-16 items-center border-b border-border/80 px-5">
        <Logo />
      </div>

      <nav className="flex-1 space-y-7 overflow-y-auto px-3 py-5">
        {navigationSections.map((section) => (
          <div key={section.label ?? section.items[0]?.title} className="space-y-1">
            {section.label ? (
              <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {section.label}
              </p>
            ) : null}
            <div className="space-y-1">
              {section.items.map((item) => (
                <SidebarNavItem
                  key={item.title}
                  item={item}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border/80 px-5 py-4">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">
          Flip Manager AI
        </p>
      </div>
    </aside>
  );
}
