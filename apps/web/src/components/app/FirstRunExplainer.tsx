import Link from "next/link";
import { LineChart, Search, Sparkles, Tag } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { NewCompetitorForm } from "@/components/app/NewCompetitorForm";

const CAPABILITIES = [
  { icon: Tag, label: "Pricing", description: "Plan and price changes" },
  { icon: Search, label: "Products and services", description: "New or removed offerings" },
  { icon: Sparkles, label: "Offers and promotions", description: "Discounts and campaigns" },
  { icon: LineChart, label: "Plans and features", description: "What's included, and what changed" },
];

/**
 * Phase 5 (Section 1/2): the first thing a brand-new organization sees.
 * Written in plain product language - no mention of ChangeEvents,
 * BullMQ, snapshots, or AiAnalysis. Only describes capabilities the
 * product actually has today (Section 2: "do not make unsupported
 * claims") - deterministic monitoring of public commercial information,
 * with optional AI interpretation once a provider is configured.
 */
export function FirstRunExplainer() {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="py-8 text-center">
          <h2 className="text-xl font-semibold text-slate-900">Monitor your competitors</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">
            Add a competitor's website and we'll monitor publicly available commercial information for changes. Every
            change is verified evidence, not a guess - and you can add your own AI provider later to get a plain-language
            interpretation of what changed.
          </p>
          <div className="mx-auto mt-6 grid max-w-lg grid-cols-2 gap-4 text-left">
            {CAPABILITIES.map((cap) => (
              <div key={cap.label} className="flex items-start gap-2">
                <cap.icon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-slate-900">{cap.label}</p>
                  <p className="text-xs text-slate-500">{cap.description}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex justify-center">
            <NewCompetitorForm />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-5">
          <h3 className="text-sm font-semibold text-slate-900">How it works</h3>
          <ol className="mt-3 space-y-2 text-sm text-slate-600">
            <li>
              1. <Link href="/competitors" className="text-indigo-600 hover:text-indigo-700">Add a competitor</Link> and one of their pages
              (their pricing page is a good start).
            </li>
            <li>2. Run a scan - we'll record what that page looks like right now.</li>
            <li>3. The next scan compares against that baseline and tells you exactly what changed, with evidence.</li>
            <li>4. Optionally, configure your own AI provider under AI Provider to get a plain-language interpretation of each change.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
