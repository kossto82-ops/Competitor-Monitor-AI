import type { ReactNode } from "react";

export const metadata = {
  title: "Competitor Monitor AI",
  description: "Automated competitor monitoring and change intelligence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
