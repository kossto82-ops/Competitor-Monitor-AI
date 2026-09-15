import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Competitor Monitor AI",
  description: "Automated competitor monitoring and change intelligence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
