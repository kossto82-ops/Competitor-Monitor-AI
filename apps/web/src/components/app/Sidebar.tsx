"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Building2, GitCompareArrows, Settings, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/competitors", label: "Competitors", icon: Building2, section: "Monitoring" },
  { href: "/changes", label: "Changes", icon: GitCompareArrows },
  { href: "/settings/account", label: "Account", icon: Settings, section: "Settings" },
  { href: "/settings/ai", label: "AI Provider", icon: Sparkles },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-4">
      <div className="mb-6 px-2">
        <span className="text-sm font-semibold text-slate-900">Competitor Monitor AI</span>
      </div>

      <ul className="space-y-0.5">
        {NAV.map((item, index) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const showSectionLabel = item.section && (index === 0 || NAV[index - 1]?.section !== item.section);
          return (
            <li key={item.href}>
              {showSectionLabel ? (
                <p className="mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {item.section}
                </p>
              ) : null}
              <Link
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                )}
              >
                <item.icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
